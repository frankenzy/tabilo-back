import { Injectable } from '@nestjs/common';
import { PrismaService, Tx } from '../../commons/prisma/prisma.service';
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
}

export interface MenuCategoryView {
  id: string;
  name: string;
  items: MenuItemView[];
}

export interface ItemInput {
  categoryId: string;
  name: string;
  description?: string | null;
  priceMinor: number;
  isAvailable?: boolean;
}

const MAX_IMAGE_BYTES = 300 * 1024;

/** Signatures de fichier acceptées : le type annoncé doit correspondre au contenu réel. */
const IMAGE_SIGNATURES: Record<string, (bytes: Buffer) => boolean> = {
  'image/jpeg': (b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff,
  'image/png': (b) => b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])),
  'image/webp': (b) => b.subarray(0, 4).toString('ascii') === 'RIFF' && b.subarray(8, 12).toString('ascii') === 'WEBP',
};

const ITEM_SELECT = { id: true, name: true, description: true, priceMinor: true, imageId: true, isAvailable: true } as const;

/** Carte de l'établissement : rubriques, articles, prix, disponibilité et photos. */
@Injectable()
export class MenuService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  /** Carte complète, dans l'ordre choisi par le gérant. Les ruptures restent visibles, marquées. */
  async overview(establishmentId: string): Promise<MenuCategoryView[]> {
    const categories = await this.prisma.menuCategory.findMany({
      where: { establishmentId, archivedAt: null },
      orderBy: [{ position: 'asc' }, { createdAt: 'asc' }],
      select: {
        id: true,
        name: true,
        items: { where: { archivedAt: null }, orderBy: [{ position: 'asc' }, { createdAt: 'asc' }], select: ITEM_SELECT },
      },
    });
    return categories;
  }

  // -------------------------------------------------------------- rubriques

  async createCategory(scope: Scope, dto: { name: string }) {
    await this.assertCategoryNameFree(scope, dto.name);
    const last = await this.prisma.menuCategory.aggregate({ where: { ...this.where(scope), archivedAt: null }, _max: { position: true } });
    return this.prisma.$transaction(async (tx) => {
      const category = await tx.menuCategory.create({
        data: { ...this.where(scope), name: dto.name, position: (last._max.position ?? -1) + 1 },
        select: { id: true, name: true },
      });
      await this.log(tx, scope, 'menu_category.created', 'MenuCategory', category.id);
      return { ...category, items: [] };
    });
  }

  async updateCategory(scope: Scope, id: string, dto: { name?: string }) {
    const category = await this.findCategory(scope, id);
    if (dto.name && dto.name !== category.name) await this.assertCategoryNameFree(scope, dto.name);
    return this.prisma.$transaction(async (tx) => {
      const updated = await tx.menuCategory.update({ where: { id }, data: dto, select: { id: true, name: true } });
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

  async createItem(scope: Scope, dto: ItemInput): Promise<MenuItemView> {
    await this.findCategory(scope, dto.categoryId);
    const last = await this.prisma.menuItem.aggregate({ where: { categoryId: dto.categoryId, archivedAt: null }, _max: { position: true } });
    return this.prisma.$transaction(async (tx) => {
      const item = await tx.menuItem.create({
        data: { ...this.where(scope), ...dto, description: dto.description || null, position: (last._max.position ?? -1) + 1 },
        select: ITEM_SELECT,
      });
      await this.log(tx, scope, 'menu_item.created', 'MenuItem', item.id);
      return item;
    });
  }

  async updateItem(scope: Scope, id: string, dto: Partial<ItemInput>): Promise<MenuItemView> {
    const item = await this.findItem(scope, id);
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
      const updated = await tx.menuItem.update({
        where: { id },
        data: { ...dto, position, description: dto.description === undefined ? undefined : dto.description || null },
        select: ITEM_SELECT,
      });
      await this.log(tx, scope, 'menu_item.updated', 'MenuItem', id, {
        priceChanged: dto.priceMinor !== undefined && dto.priceMinor !== item.priceMinor,
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
    const matches = IMAGE_SIGNATURES[dto.mime];
    if (!matches) throw unprocessable('IMAGE_TYPE_UNSUPPORTED', 'Format accepté : JPEG, PNG ou WebP.');
    const bytes = Buffer.from(dto.data, 'base64');
    if (bytes.length === 0 || bytes.length > MAX_IMAGE_BYTES) {
      throw unprocessable('IMAGE_TOO_LARGE', 'La photo dépasse 300 Ko.');
    }
    if (!matches(bytes)) throw unprocessable('IMAGE_INVALID', "Ce fichier n'est pas une image valide.");
    return this.prisma.$transaction(async (tx) => {
      const image = await tx.menuImage.create({ data: { ...this.where(scope), mime: dto.mime, data: bytes }, select: { id: true } });
      const updated = await tx.menuItem.update({ where: { id: itemId }, data: { imageId: image.id }, select: ITEM_SELECT });
      if (item.imageId) await tx.menuImage.delete({ where: { id: item.imageId } });
      await this.log(tx, scope, 'menu_item.image_updated', 'MenuItem', itemId);
      return updated;
    });
  }

  async removeImage(scope: Scope, itemId: string): Promise<MenuItemView> {
    const item = await this.findItem(scope, itemId);
    if (!item.imageId) return this.prisma.menuItem.findUniqueOrThrow({ where: { id: itemId }, select: ITEM_SELECT });
    return this.prisma.$transaction(async (tx) => {
      const updated = await tx.menuItem.update({ where: { id: itemId }, data: { imageId: null }, select: ITEM_SELECT });
      await tx.menuImage.delete({ where: { id: item.imageId as string } });
      await this.log(tx, scope, 'menu_item.image_removed', 'MenuItem', itemId);
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
