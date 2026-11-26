import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { readSlots, Slot, slotsError } from '../../commons/utils/slots';
import { PrismaService, Tx } from '../../commons/prisma/prisma.service';
import { PlanService } from '../../commons/services/plan.service';
import { AuditService } from '../../commons/services/audit.service';
import type { Scope } from '../../commons/types';
import { conflict, notFound, unprocessable } from '../../commons/utils/errors';

export interface MenuItemView {
  id: string;
  name: string;
  description: string | null;
  priceMinor: number;
  imageId: string | null;
  isAvailable: boolean;
  /** Spec 032 : formule à prix unique ; ses rubriques et les plats proposés (vide pour un plat). */
  isBundle: boolean;
  groups: BundleGroupView[];
  /** Spec 033, R1 : prix promotionnel en cours ; null sans promotion. */
  promoPriceMinor: number | null;
  /** Spec 039 : créneaux de la promotion et de disponibilité (null = permanent), nom de la promotion. */
  promoSlots: Slot[] | null;
  promoName: string | null;
  availabilitySlots: Slot[] | null;
  /** Spec 038 : groupes d'options. */
  optionGroups: OptionGroupView[];
}

export interface OptionView {
  id: string;
  name: string;
  priceMinor: number;
  icon: string | null;
  isAvailable: boolean;
}

export interface OptionGroupView {
  id: string;
  name: string;
  multiple: boolean;
  required: boolean;
  options: OptionView[];
}

/** Spec 038, R1 : groupe d'options à l'écriture ; `id` d'une option existante la conserve. */
export interface OptionGroupInput {
  name: string;
  multiple: boolean;
  required: boolean;
  options: { id?: string; name: string; priceMinor: number; icon?: string | null; isAvailable?: boolean }[];
}

export interface BundleGroupView {
  id: string;
  name: string;
  choiceIds: string[];
}

/** Spec 032, R1 : rubrique d'une formule à l'écriture. */
export interface BundleGroupInput {
  name: string;
  choiceIds: string[];
}

export interface MenuCategoryView {
  id: string;
  name: string;
  icon: string;
  imageId: string | null;
  items: MenuItemView[];
}

export interface ItemInput {
  categoryId: string;
  name: string;
  description?: string | null;
  priceMinor: number;
  isAvailable?: boolean;
  /** Spec 032 : présent = formule (1 à 4 rubriques). */
  groups?: BundleGroupInput[];
  /** Spec 033 : prix promotionnel, null pour retirer la promotion. */
  promoPriceMinor?: number | null;
  /** Spec 039. */
  promoSlots?: Slot[] | null;
  promoName?: string | null;
  availabilitySlots?: Slot[] | null;
  /** Spec 038 : remplace tous les groupes d'options ; [] les retire. */
  optionGroups?: OptionGroupInput[];
}

const MAX_IMAGE_BYTES = 300 * 1024;

/** Signatures de fichier acceptées : le type annoncé doit correspondre au contenu réel. */
const IMAGE_SIGNATURES: Record<string, (bytes: Buffer) => boolean> = {
  'image/jpeg': (b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff,
  'image/png': (b) => b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])),
  'image/webp': (b) => b.subarray(0, 4).toString('ascii') === 'RIFF' && b.subarray(8, 12).toString('ascii') === 'WEBP',
};

const CATEGORY_SELECT = { id: true, name: true, icon: true, imageId: true } as const;

/** Spec 033, R1 : un prix promotionnel est strictement inférieur au prix. */
function assertPromo(priceMinor: number, promoPriceMinor: number | null | undefined): void {
  if (promoPriceMinor !== null && promoPriceMinor !== undefined && promoPriceMinor >= priceMinor) {
    throw unprocessable('PROMO_PRICE_INVALID', 'Le prix promotionnel doit être inférieur au prix.');
  }
}

/** Décode et contrôle une photo : type annoncé autorisé, taille, signature binaire conforme au type. */
export function decodeImage(dto: { mime: string; data: string }, maxBytes = MAX_IMAGE_BYTES): Buffer<ArrayBuffer> {
  const matches = IMAGE_SIGNATURES[dto.mime];
  if (!matches) throw unprocessable('IMAGE_TYPE_UNSUPPORTED', 'Format accepté : JPEG, PNG ou WebP.');
  const bytes = Buffer.from(dto.data, 'base64');
  if (bytes.length === 0 || bytes.length > maxBytes) {
    throw unprocessable('IMAGE_TOO_LARGE', `L’image dépasse ${Math.round(maxBytes / 1024)} Ko.`);
  }
  if (!matches(bytes)) throw unprocessable('IMAGE_INVALID', "Ce fichier n'est pas une image valide.");
  return bytes;
}

const ITEM_SELECT = {
  id: true, name: true, description: true, priceMinor: true, imageId: true, isAvailable: true, isBundle: true, promoPriceMinor: true,
  promoSlots: true, promoName: true, availabilitySlots: true,
  optionGroups: {
    orderBy: { position: 'asc' },
    select: {
      id: true, name: true, multiple: true, required: true,
      options: { orderBy: { position: 'asc' }, select: { id: true, name: true, priceMinor: true, icon: true, isAvailable: true } },
    },
  },
  bundleGroups: { orderBy: { position: 'asc' }, select: { id: true, name: true, choiceIds: true } },
} satisfies Prisma.MenuItemSelect;

type ItemRow = Prisma.MenuItemGetPayload<{ select: typeof ITEM_SELECT }>;

/** `active` : plats simples encore à la carte ; un plat retiré disparaît des rubriques (spec 032, R7). */
function toItemView({ bundleGroups, promoSlots, availabilitySlots, ...item }: ItemRow, active?: Set<string>): MenuItemView {
  return {
    ...item,
    promoSlots: readSlots(promoSlots),
    availabilitySlots: readSlots(availabilitySlots),
    groups: bundleGroups.map((group) => ({ ...group, choiceIds: active ? group.choiceIds.filter((id) => active.has(id)) : group.choiceIds })),
  };
}

/** Carte de l'établissement : rubriques, articles, prix, disponibilité et photos. */
@Injectable()
export class MenuService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly plans: PlanService,
  ) {}

  /** Carte complète, dans l'ordre choisi par le gérant. Les ruptures restent visibles, marquées. */
  async overview(establishmentId: string): Promise<MenuCategoryView[]> {
    const categories = await this.prisma.menuCategory.findMany({
      where: { establishmentId, archivedAt: null },
      orderBy: [{ position: 'asc' }, { createdAt: 'asc' }],
      select: {
        ...CATEGORY_SELECT,
        items: { where: { archivedAt: null }, orderBy: [{ position: 'asc' }, { createdAt: 'asc' }], select: ITEM_SELECT },
      },
    });
    const active = new Set(categories.flatMap((category) => category.items.filter((item) => !item.isBundle).map((item) => item.id)));
    return categories.map((category) => ({ ...category, items: category.items.map((item) => toItemView(item, active)) }));
  }

  // -------------------------------------------------------------- rubriques

  async createCategory(scope: Scope, dto: { name: string; icon?: string }) {
    await this.assertCategoryNameFree(scope, dto.name);
    const last = await this.prisma.menuCategory.aggregate({ where: { ...this.where(scope), archivedAt: null }, _max: { position: true } });
    return this.prisma.$transaction(async (tx) => {
      const category = await tx.menuCategory.create({
        data: { ...this.where(scope), name: dto.name, icon: dto.icon, position: (last._max.position ?? -1) + 1 },
        select: CATEGORY_SELECT,
      });
      await this.log(tx, scope, 'menu_category.created', 'MenuCategory', category.id);
      return { ...category, items: [] };
    });
  }

  async updateCategory(scope: Scope, id: string, dto: { name?: string; icon?: string }) {
    const category = await this.findCategory(scope, id);
    if (dto.name && dto.name !== category.name) await this.assertCategoryNameFree(scope, dto.name);
    return this.prisma.$transaction(async (tx) => {
      const updated = await tx.menuCategory.update({ where: { id }, data: dto, select: CATEGORY_SELECT });
      await this.log(tx, scope, 'menu_category.updated', 'MenuCategory', id);
      return updated;
    });
  }

  /** Archive la rubrique et ses articles. Les commandes passées gardent leurs lignes figées. */
  async archiveCategory(scope: Scope, id: string): Promise<void> {
    await this.findCategory(scope, id);
    await this.prisma.$transaction(async (tx) => {
      const now = new Date();
      await tx.menuItem.updateMany({ where: { categoryId: id, archivedAt: null }, data: { archivedAt: now } });
      await tx.menuCategory.update({ where: { id }, data: { archivedAt: now } });
      await this.log(tx, scope, 'menu_category.archived', 'MenuCategory', id);
    });
  }

  // ---------------------------------------------------------------- articles

  async createItem(scope: Scope, { groups, optionGroups, ...input }: ItemInput): Promise<MenuItemView> {
    const dto = this.slotsData(input);
    await this.findCategory(scope, dto.categoryId);
    await this.assertOptionsAndSlots(scope, input, optionGroups, groups !== undefined);
    // Spec 034, R4 : formules et promotions selon la formule d'abonnement.
    if (groups) await this.plans.assertFeature(scope.tenantId, 'bundles');
    if (dto.promoPriceMinor != null) await this.plans.assertFeature(scope.tenantId, 'promotions');
    if (groups) await this.assertBundleGroups(scope, groups);
    assertPromo(dto.priceMinor, dto.promoPriceMinor);
    const last = await this.prisma.menuItem.aggregate({ where: { categoryId: dto.categoryId, archivedAt: null }, _max: { position: true } });
    return this.prisma.$transaction(async (tx) => {
      const item = await tx.menuItem.create({
        data: { ...this.where(scope), ...dto, isBundle: groups !== undefined, description: dto.description || null, position: (last._max.position ?? -1) + 1 },
        select: { id: true },
      });
      if (groups) await this.writeBundleGroups(tx, scope, item.id, groups);
      if (optionGroups) await this.writeOptionGroups(tx, scope, item.id, optionGroups);
      await this.log(tx, scope, groups ? 'menu_bundle.created' : 'menu_item.created', 'MenuItem', item.id);
      return toItemView(await tx.menuItem.findUniqueOrThrow({ where: { id: item.id }, select: ITEM_SELECT }));
    });
  }

  async updateItem(scope: Scope, id: string, { groups, optionGroups, ...input }: Partial<ItemInput>): Promise<MenuItemView> {
    const dto = this.slotsData(input);
    const item = await this.findItem(scope, id);
    await this.assertOptionsAndSlots(scope, input, optionGroups, item.isBundle);
    if (groups) {
      // Spec 032 : seules les rubriques d'une formule se modifient ; un plat ne devient pas une formule.
      if (!item.isBundle) throw unprocessable('NOT_A_BUNDLE', "Ce plat n'est pas une formule.");
      await this.plans.assertFeature(scope.tenantId, 'bundles');
      await this.assertBundleGroups(scope, groups);
    }
    // Spec 034, R4 et R5 : mettre une promotion est réservé ; la retirer reste toujours possible.
    if (dto.promoPriceMinor != null) await this.plans.assertFeature(scope.tenantId, 'promotions');
    // Spec 033, R1 : le prix promo reste sous le prix, même quand seul le prix change.
    const promo = dto.promoPriceMinor !== undefined ? dto.promoPriceMinor : item.promoPriceMinor;
    if (dto.promoPriceMinor !== undefined || (dto.priceMinor !== undefined && promo !== null)) assertPromo(dto.priceMinor ?? item.priceMinor, promo);
    const moved = dto.categoryId !== undefined && dto.categoryId !== item.categoryId;
    let position: number | undefined;
    if (moved) {
      await this.findCategory(scope, dto.categoryId as string);
      // Un article qui change de rubrique se place en dernier dans la nouvelle (R11 bis).
      const last = await this.prisma.menuItem.aggregate({
        where: { categoryId: dto.categoryId, archivedAt: null },
        _max: { position: true },
      });
      position = (last._max.position ?? -1) + 1;
    }
    return this.prisma.$transaction(async (tx) => {
      if (groups) await this.writeBundleGroups(tx, scope, id, groups);
      if (optionGroups) await this.writeOptionGroups(tx, scope, id, optionGroups);
      const updated = toItemView(await tx.menuItem.update({
        where: { id },
        data: { ...dto, position, description: dto.description === undefined ? undefined : dto.description || null },
        select: ITEM_SELECT,
      }));
      await this.log(tx, scope, 'menu_item.updated', 'MenuItem', id, {
        priceChanged: dto.priceMinor !== undefined && dto.priceMinor !== item.priceMinor,
        ...(dto.promoPriceMinor !== undefined && dto.promoPriceMinor !== item.promoPriceMinor ? { promoChanged: true } : {}),
      });
      return updated;
    });
  }

  async archiveItem(scope: Scope, id: string): Promise<void> {
    await this.findItem(scope, id);
    await this.prisma.$transaction(async (tx) => {
      await tx.menuItem.update({ where: { id }, data: { archivedAt: new Date() } });
      await this.log(tx, scope, 'menu_item.archived', 'MenuItem', id);
    });
  }

  // ------------------------------------------------------------------ photos

  /** Remplace la photo d'un article. L'image arrive déjà réduite par le navigateur. */
  async setImage(scope: Scope, itemId: string, dto: { mime: string; data: string }): Promise<MenuItemView> {
    const item = await this.findItem(scope, itemId);
    const bytes = decodeImage(dto);
    return this.prisma.$transaction(async (tx) => {
      const image = await tx.menuImage.create({ data: { ...this.where(scope), mime: dto.mime, data: bytes }, select: { id: true } });
      const updated = toItemView(await tx.menuItem.update({ where: { id: itemId }, data: { imageId: image.id }, select: ITEM_SELECT }));
      if (item.imageId) await tx.menuImage.delete({ where: { id: item.imageId } });
      await this.log(tx, scope, 'menu_item.image_updated', 'MenuItem', itemId);
      return updated;
    });
  }

  async removeImage(scope: Scope, itemId: string): Promise<MenuItemView> {
    const item = await this.findItem(scope, itemId);
    if (!item.imageId) return toItemView(await this.prisma.menuItem.findUniqueOrThrow({ where: { id: itemId }, select: ITEM_SELECT }));
    return this.prisma.$transaction(async (tx) => {
      const updated = toItemView(await tx.menuItem.update({ where: { id: itemId }, data: { imageId: null }, select: ITEM_SELECT }));
      await tx.menuImage.delete({ where: { id: item.imageId as string } });
      await this.log(tx, scope, 'menu_item.image_removed', 'MenuItem', itemId);
      return updated;
    });
  }

  /** Photo de rubrique (spec 003) : remplace le pictogramme côté client. Mêmes contrôles qu'un article. */
  async setCategoryImage(scope: Scope, categoryId: string, dto: { mime: string; data: string }) {
    const category = await this.findCategory(scope, categoryId);
    const bytes = decodeImage(dto);
    return this.prisma.$transaction(async (tx) => {
      const image = await tx.menuImage.create({ data: { ...this.where(scope), mime: dto.mime, data: bytes }, select: { id: true } });
      const updated = await tx.menuCategory.update({ where: { id: categoryId }, data: { imageId: image.id }, select: CATEGORY_SELECT });
      if (category.imageId) await tx.menuImage.delete({ where: { id: category.imageId } });
      await this.log(tx, scope, 'menu_category.image_updated', 'MenuCategory', categoryId);
      return updated;
    });
  }

  async removeCategoryImage(scope: Scope, categoryId: string) {
    const category = await this.findCategory(scope, categoryId);
    if (!category.imageId) return this.prisma.menuCategory.findUniqueOrThrow({ where: { id: categoryId }, select: CATEGORY_SELECT });
    return this.prisma.$transaction(async (tx) => {
      const updated = await tx.menuCategory.update({ where: { id: categoryId }, data: { imageId: null }, select: CATEGORY_SELECT });
      await tx.menuImage.delete({ where: { id: category.imageId as string } });
      await this.log(tx, scope, 'menu_category.image_removed', 'MenuCategory', categoryId);
      return updated;
    });
  }

  // ------------------------------------------------------------------- ordre

  /**
   * Réordonne les rubriques. `ids` doit contenir exactement les rubriques actives, sans doublon :
   * une liste incomplète signale une carte modifiée en parallèle, et on refuse plutôt que deviner.
   */
  async reorderCategories(scope: Scope, ids: string[]): Promise<MenuCategoryView[]> {
    const current = await this.prisma.menuCategory.findMany({ where: { ...this.where(scope), archivedAt: null }, select: { id: true } });
    this.assertSameSet(current.map((c) => c.id), ids);
    await this.prisma.$transaction(async (tx) => {
      for (const [position, id] of ids.entries()) await tx.menuCategory.update({ where: { id }, data: { position } });
      await this.log(tx, scope, 'menu_category.reordered', 'Establishment', scope.establishmentId);
    });
    return this.overview(scope.establishmentId);
  }

  /** Réordonne les articles d'une rubrique. Même règle : la liste complète, rien d'autre. */
  async reorderItems(scope: Scope, categoryId: string, ids: string[]): Promise<MenuCategoryView> {
    await this.findCategory(scope, categoryId);
    const current = await this.prisma.menuItem.findMany({ where: { ...this.where(scope), categoryId, archivedAt: null }, select: { id: true } });
    this.assertSameSet(current.map((i) => i.id), ids);
    await this.prisma.$transaction(async (tx) => {
      for (const [position, id] of ids.entries()) await tx.menuItem.update({ where: { id }, data: { position } });
      await this.log(tx, scope, 'menu_item.reordered', 'MenuCategory', categoryId);
    });
    const category = (await this.overview(scope.establishmentId)).find((c) => c.id === categoryId);
    if (!category) throw notFound('MENU_CATEGORY_NOT_FOUND', 'Rubrique introuvable.');
    return category;
  }

  /**
   * Suggestions « Souvent commandés avec » (spec 002, R1) : 6 articles au plus, jamais un article
   * du panier, épuisé ou retiré. Trois passes : co-occurrence dans les commandes servies des
   * 90 derniers jours, puis popularité, puis articles des rubriques absentes du panier.
   */
  async suggestions(establishmentId: string, cartIds: string[]): Promise<string[]> {
    const LIMIT = 6;
    const since = new Date(Date.now() - 90 * 86_400_000);
    const cart = [...new Set(cartIds)];
    const orderable = await this.prisma.menuItem.findMany({
      where: { establishmentId, archivedAt: null, isAvailable: true, category: { archivedAt: null } },
      orderBy: [{ category: { position: 'asc' } }, { position: 'asc' }, { createdAt: 'asc' }],
      select: { id: true, categoryId: true },
    });
    const candidates = new Set(orderable.map((item) => item.id));
    cart.forEach((id) => candidates.delete(id));
    const picked: string[] = [];
    const take = (ids: string[]) => {
      for (const id of ids) {
        if (picked.length >= LIMIT) return;
        if (candidates.has(id) && !picked.includes(id)) picked.push(id);
      }
    };

    if (cart.length > 0) {
      const together = await this.prisma.$queryRaw<{ id: string }[]>`
        SELECT o."menuItemId"::text AS id
        FROM "ServiceRequestItem" a
        JOIN "ServiceRequestItem" o ON o."requestId" = a."requestId" AND o."menuItemId" <> a."menuItemId"
        JOIN "ServiceRequest" r ON r.id = a."requestId"
        WHERE a."establishmentId" = ${establishmentId}::uuid
          AND a."menuItemId" = ANY(${cart}::uuid[])
          AND r.status = 'resolved' AND r."createdAt" >= ${since}
        GROUP BY o."menuItemId"
        ORDER BY count(DISTINCT o."requestId") DESC, o."menuItemId"
        LIMIT 50`;
      take(together.map((row) => row.id));
    }
    if (picked.length < LIMIT) {
      const popular = await this.prisma.$queryRaw<{ id: string }[]>`
        SELECT i."menuItemId"::text AS id
        FROM "ServiceRequestItem" i JOIN "ServiceRequest" r ON r.id = i."requestId"
        WHERE i."establishmentId" = ${establishmentId}::uuid AND r.status = 'resolved' AND r."createdAt" >= ${since}
        GROUP BY i."menuItemId"
        ORDER BY sum(i.quantity) DESC, i."menuItemId"
        LIMIT 50`;
      take(popular.map((row) => row.id));
    }
    if (picked.length < LIMIT) {
      const cartCategories = new Set(orderable.filter((item) => cart.includes(item.id)).map((item) => item.categoryId));
      take(orderable.filter((item) => !cartCategories.has(item.categoryId)).map((item) => item.id));
    }
    return picked;
  }

  /** Lecture publique d'une photo par son identifiant. */
  async image(id: string): Promise<{ mime: string; data: Buffer }> {
    const image = await this.prisma.menuImage.findUnique({ where: { id }, select: { mime: true, data: true } });
    if (!image) throw notFound('IMAGE_NOT_FOUND', 'Image introuvable.');
    return { mime: image.mime, data: Buffer.from(image.data) };
  }

  // ----------------------------------------------------------------- outils

  private where(scope: Scope) {
    return { tenantId: scope.tenantId, establishmentId: scope.establishmentId };
  }

  private async findCategory(scope: Scope, id: string) {
    const category = await this.prisma.menuCategory.findFirst({ where: { id, ...this.where(scope), archivedAt: null } });
    if (!category) throw notFound('MENU_CATEGORY_NOT_FOUND', 'Rubrique introuvable.');
    return category;
  }

  private async findItem(scope: Scope, id: string) {
    const item = await this.prisma.menuItem.findFirst({ where: { id, ...this.where(scope), archivedAt: null } });
    if (!item) throw notFound('MENU_ITEM_NOT_FOUND', 'Article introuvable.');
    return item;
  }

  /** Spec 039 : créneaux en JSON pour Prisma (null efface). */
  private slotsData<T extends { promoSlots?: Slot[] | null; availabilitySlots?: Slot[] | null }>(input: T) {
    const json = (value: Slot[] | null | undefined) =>
      value === undefined ? undefined : value === null || value.length === 0 ? Prisma.DbNull : (value as unknown as Prisma.InputJsonArray);
    return { ...input, promoSlots: json(input.promoSlots), availabilitySlots: json(input.availabilitySlots) };
  }

  /** Specs 038 et 039 : contrôles des options et des créneaux, et modules de la formule (spec 034). */
  private async assertOptionsAndSlots(
    scope: Scope,
    input: { promoSlots?: Slot[] | null; availabilitySlots?: Slot[] | null },
    optionGroups: OptionGroupInput[] | undefined,
    isBundle: boolean,
  ): Promise<void> {
    for (const slots of [input.promoSlots, input.availabilitySlots]) {
      if (slots === undefined || slots === null || slots.length === 0) continue;
      const error = slotsError(slots);
      if (error) throw unprocessable('SLOTS_INVALID', error);
      await this.plans.assertFeature(scope.tenantId, 'promotions');
    }
    if (!optionGroups || optionGroups.length === 0) return;
    if (isBundle) throw unprocessable('OPTIONS_ON_BUNDLE', 'Une formule n’a pas d’options : elle garde son prix unique.');
    await this.plans.assertFeature(scope.tenantId, 'options');
    if (optionGroups.length > 4) throw unprocessable('OPTION_GROUPS_INVALID', 'Un plat a 4 groupes d’options au plus.');
    for (const group of optionGroups) {
      if (group.options.length < 2 || group.options.length > 10) {
        throw unprocessable('OPTION_GROUPS_INVALID', `Le groupe « ${group.name} » propose de 2 à 10 options.`);
      }
    }
  }

  /** Spec 038 : remplace les groupes d'options ; une option existante garde son identifiant (paniers en cours). */
  private async writeOptionGroups(tx: Tx, scope: Scope, itemId: string, groups: OptionGroupInput[]): Promise<void> {
    const existing = new Set(
      (await tx.menuOption.findMany({ where: { establishmentId: scope.establishmentId, group: { itemId } }, select: { id: true } })).map((option) => option.id),
    );
    await tx.menuOptionGroup.deleteMany({ where: { itemId, establishmentId: scope.establishmentId } });
    for (const [position, group] of groups.entries()) {
      const created = await tx.menuOptionGroup.create({
        data: { ...this.where(scope), itemId, name: group.name, multiple: group.multiple, required: group.required, position },
        select: { id: true },
      });
      await tx.menuOption.createMany({
        data: group.options.map((option, index) => ({
          ...(option.id && existing.has(option.id) ? { id: option.id } : {}),
          ...this.where(scope),
          groupId: created.id,
          name: option.name,
          priceMinor: option.priceMinor,
          icon: option.icon ?? null,
          isAvailable: option.isAvailable ?? true,
          position: index,
        })),
      });
    }
  }

  /** Spec 032, R1 : 1 à 4 rubriques, 1 à 12 plats chacune, tous des plats simples à la carte de CET établissement. */
  private async assertBundleGroups(scope: Scope, groups: BundleGroupInput[]): Promise<void> {
    if (groups.length < 1 || groups.length > 4) throw unprocessable('BUNDLE_GROUPS_INVALID', 'Une formule a de 1 à 4 rubriques.');
    const ids = new Set<string>();
    for (const group of groups) {
      if (group.choiceIds.length < 1 || group.choiceIds.length > 12) {
        throw unprocessable('BUNDLE_GROUP_EMPTY', `La rubrique « ${group.name} » propose de 1 à 12 plats.`);
      }
      group.choiceIds.forEach((id) => ids.add(id));
    }
    const found = await this.prisma.menuItem.count({ where: { id: { in: [...ids] }, ...this.where(scope), archivedAt: null, isBundle: false } });
    if (found !== ids.size) throw unprocessable('BUNDLE_CHOICE_INVALID', "Un plat proposé n'est pas à la carte de l'établissement.");
  }

  private async writeBundleGroups(tx: Tx, scope: Scope, bundleId: string, groups: BundleGroupInput[]): Promise<void> {
    await tx.menuBundleGroup.deleteMany({ where: { bundleId, establishmentId: scope.establishmentId } });
    await tx.menuBundleGroup.createMany({
      data: groups.map((group, position) => ({ ...this.where(scope), bundleId, name: group.name, position, choiceIds: [...new Set(group.choiceIds)] })),
    });
  }

  private assertSameSet(expected: string[], received: string[]): void {
    const unique = new Set(received);
    if (unique.size !== received.length || unique.size !== expected.length || expected.some((id) => !unique.has(id))) {
      throw unprocessable('MENU_ORDER_MISMATCH', 'La carte a changé entre-temps. Rechargez la page et recommencez.');
    }
  }

  private async assertCategoryNameFree(scope: Scope, name: string): Promise<void> {
    const taken = await this.prisma.menuCategory.findFirst({
      where: { ...this.where(scope), archivedAt: null, name: { equals: name, mode: 'insensitive' } },
      select: { id: true },
    });
    if (taken) throw conflict('MENU_CATEGORY_EXISTS', 'Une rubrique porte déjà ce nom.');
  }

  private log(tx: Tx, scope: Scope, action: string, entityType: string, entityId: string, metadata?: Record<string, boolean>) {
    return this.audit.record({ action, ...this.where(scope), actorId: scope.userId, entityType, entityId, metadata, ip: scope.ip }, tx);
  }
}
