import { Injectable } from '@nestjs/common';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Prisma, type LoyaltyGift, type LoyaltyPrize } from '@prisma/client';
import { IsIn, IsInt, IsOptional, IsString, IsUUID, Max, MaxLength, Min, MinLength, ValidateIf } from 'class-validator';
import { PrismaService } from '../../commons/prisma/prisma.service';
import { AuditService } from '../../commons/services/audit.service';
import { PlanService } from '../../commons/services/plan.service';
import type { GuestSession, Scope } from '../../commons/types';
import { conflict, notFound, unprocessable } from '../../commons/utils/errors';
import { decodeImage } from '../menu/menu.service';
import { OutboxService } from '../outbox/outbox.service';
import { ServiceRequestsService, staffActor } from '../service-requests/service-requests.service';
import { giftState, type GiftState, stockMonth } from './loyalty-draw';

export const MAX_PRIZES = 20;

/** Spec 046, R2 : un lot du panier. */
export class CreatePrizeDto {
  @ApiProperty({ enum: ['menu_item', 'free'] }) @IsIn(['menu_item', 'free'])
  kind: 'menu_item' | 'free';

  @ApiPropertyOptional({ description: 'Plat de la carte (type menu_item)' }) @ValidateIf((dto: CreatePrizeDto) => dto.kind === 'menu_item') @IsUUID()
  menuItemId?: string;

  @ApiPropertyOptional({ description: 'Nom du lot ; celui du plat par défaut' }) @ValidateIf((dto: CreatePrizeDto) => dto.kind === 'free' || dto.name !== undefined)
  @IsString() @MinLength(1) @MaxLength(60)
  name?: string;

  @ApiProperty({ minimum: 1, maximum: 100 }) @IsInt() @Min(1) @Max(100)
  weight: number;

  @ApiPropertyOptional({ nullable: true, description: 'Stock mensuel ; absent ou null = sans limite' })
  @IsOptional() @IsInt() @Min(1) @Max(100_000)
  monthlyStock?: number | null;
}

export class UpdatePrizeDto {
  @ApiPropertyOptional() @IsOptional() @IsString() @MinLength(1) @MaxLength(60)
  name?: string;

  @ApiPropertyOptional({ minimum: 1, maximum: 100 }) @IsOptional() @IsInt() @Min(1) @Max(100)
  weight?: number;

  @ApiPropertyOptional({ nullable: true }) @ValidateIf((_, value) => value !== null && value !== undefined) @IsInt() @Min(1) @Max(100_000)
  monthlyStock?: number | null;

  @ApiPropertyOptional() @IsOptional() @IsInt() @Min(0) @Max(1_000)
  position?: number;
}

export interface PrizeView {
  id: string;
  kind: 'menu_item' | 'free';
  menuItemId: string | null;
  name: string;
  imageId: string | null;
  weight: number;
  monthlyStock: number | null;
  drawnThisMonth: number;
  position: number;
}

export interface GuestGiftView {
  id: string;
  state: GiftState;
  revealed: boolean;
  /** Place du cadeau sur la vague (nombre de tampons à son déblocage). */
  atStamp: number;
  unlockedAt: string;
  expiresAt: string;
  /** R7 : débloqué et pas encore fêté par des feux d'artifice. */
  celebrate: boolean;
  /** R9 : le lot n'est connu du téléphone qu'une fois le cadeau déballé. */
  prize: { name: string; imageId: string | null; kind: 'menu_item' | 'free' } | null;
}

export interface SurpriseCardView {
  giftsReceived: number;
  gifts: GuestGiftView[];
}

/** Spec 046 : panier de cadeaux, cadeaux du client, déballage et utilisation. */
@Injectable()
export class SurpriseService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly plans: PlanService,
    private readonly outbox: OutboxService,
    private readonly requests: ServiceRequestsService,
  ) {}

  // ---------------------------------------------------------------- panier (gérant)

  async prizes(scope: Scope): Promise<PrizeView[]> {
    const rows = await this.prisma.loyaltyPrize.findMany({
      where: { establishmentId: scope.establishmentId, tenantId: scope.tenantId, archivedAt: null },
      orderBy: [{ position: 'asc' }, { createdAt: 'asc' }],
    });
    return this.prizeViews(rows);
  }

  /** R2 et R3 : un panier de 1 à 20 lots, dont au moins un sans limite. */
  async assertValidBasket(establishmentId: string, change?: { without?: string; limited?: { id: string; stock: number | null } }): Promise<void> {
    const rows = await this.prisma.loyaltyPrize.findMany({ where: { establishmentId, archivedAt: null }, select: { id: true, monthlyStock: true } });
    const basket = rows
      .filter((row) => row.id !== change?.without)
      .map((row) => (row.id === change?.limited?.id ? { ...row, monthlyStock: change.limited.stock } : row));
    if (basket.length === 0) throw unprocessable('PRIZES_REQUIRED', 'Ajoutez au moins un cadeau au panier.');
    if (!basket.some((row) => row.monthlyStock === null)) {
      throw unprocessable('UNLIMITED_PRIZE_REQUIRED', 'Gardez au moins un cadeau sans limite de stock : chaque cadeau débloqué doit contenir quelque chose.');
    }
  }

  async createPrize(scope: Scope, dto: CreatePrizeDto): Promise<PrizeView> {
    await this.plans.assertFeature(scope.tenantId, 'loyalty');
    const count = await this.prisma.loyaltyPrize.count({ where: { establishmentId: scope.establishmentId, archivedAt: null } });
    if (count >= MAX_PRIZES) throw unprocessable('PRIZES_LIMIT', `Le panier compte au plus ${MAX_PRIZES} cadeaux.`);
    let name = dto.name?.trim();
    let menuItemId: string | null = null;
    if (dto.kind === 'menu_item') {
      const item = await this.prisma.menuItem.findFirst({
        where: { id: dto.menuItemId, tenantId: scope.tenantId, establishmentId: scope.establishmentId, archivedAt: null },
        select: { id: true, name: true },
      });
      if (!item) throw unprocessable('MENU_ITEM_NOT_FOUND', 'Choisissez un plat de la carte.');
      menuItemId = item.id;
      name = name || item.name;
    }
    if (!name) throw unprocessable('PRIZE_NAME_REQUIRED', 'Donnez un nom au cadeau.');
    const created = await this.prisma.loyaltyPrize.create({
      data: {
        tenantId: scope.tenantId,
        establishmentId: scope.establishmentId,
        kind: dto.kind,
        menuItemId,
        name,
        weight: dto.weight,
        monthlyStock: dto.monthlyStock ?? null,
        position: count,
      },
    });
    await this.audit.record({ action: 'loyalty.prize_created', tenantId: scope.tenantId, establishmentId: scope.establishmentId, actorId: scope.userId, entityType: 'LoyaltyPrize', entityId: created.id, metadata: { name, weight: dto.weight, monthlyStock: dto.monthlyStock ?? null }, ip: scope.ip });
    return (await this.prizeViews([created]))[0];
  }

  async updatePrize(scope: Scope, id: string, dto: UpdatePrizeDto): Promise<PrizeView> {
    const prize = await this.findPrize(scope, id);
    if (dto.monthlyStock !== undefined && (await this.surpriseActive(scope.establishmentId))) {
      await this.assertValidBasket(scope.establishmentId, { limited: { id, stock: dto.monthlyStock } });
    }
    const updated = await this.prisma.loyaltyPrize.update({
      where: { id: prize.id },
      data: {
        ...(dto.name !== undefined ? { name: dto.name.trim() } : {}),
        ...(dto.weight !== undefined ? { weight: dto.weight } : {}),
        ...(dto.monthlyStock !== undefined ? { monthlyStock: dto.monthlyStock } : {}),
        ...(dto.position !== undefined ? { position: dto.position } : {}),
      },
    });
    await this.audit.record({ action: 'loyalty.prize_updated', tenantId: scope.tenantId, establishmentId: scope.establishmentId, actorId: scope.userId, entityType: 'LoyaltyPrize', entityId: id, metadata: { ...dto }, ip: scope.ip });
    return (await this.prizeViews([updated]))[0];
  }

  /** Retirer un lot l'archive : les cadeaux déjà tirés le gardent. */
  async archivePrize(scope: Scope, id: string): Promise<void> {
    const prize = await this.findPrize(scope, id);
    if (await this.surpriseActive(scope.establishmentId)) await this.assertValidBasket(scope.establishmentId, { without: id });
    await this.prisma.loyaltyPrize.update({ where: { id: prize.id }, data: { archivedAt: new Date() } });
    await this.audit.record({ action: 'loyalty.prize_archived', tenantId: scope.tenantId, establishmentId: scope.establishmentId, actorId: scope.userId, entityType: 'LoyaltyPrize', entityId: id, ip: scope.ip });
  }

  async setPrizeImage(scope: Scope, id: string, dto: { mime: string; data: string }): Promise<PrizeView> {
    const prize = await this.findPrize(scope, id);
    const bytes = decodeImage(dto);
    const updated = await this.prisma.$transaction(async (tx) => {
      const image = await tx.menuImage.create({ data: { tenantId: scope.tenantId, establishmentId: scope.establishmentId, mime: dto.mime, data: bytes }, select: { id: true } });
      const saved = await tx.loyaltyPrize.update({ where: { id: prize.id }, data: { imageId: image.id } });
      if (prize.imageId) await tx.menuImage.delete({ where: { id: prize.imageId } });
      return saved;
    });
    return (await this.prizeViews([updated]))[0];
  }

  async removePrizeImage(scope: Scope, id: string): Promise<PrizeView> {
    const prize = await this.findPrize(scope, id);
    if (!prize.imageId) return (await this.prizeViews([prize]))[0];
    const updated = await this.prisma.$transaction(async (tx) => {
      const saved = await tx.loyaltyPrize.update({ where: { id: prize.id }, data: { imageId: null } });
      await tx.menuImage.delete({ where: { id: prize.imageId as string } });
      return saved;
    });
    return (await this.prizeViews([updated]))[0];
  }

  // ---------------------------------------------------------------- client

  /** R5, R8 et R9 : les cadeaux de la carte ; le lot d'un cadeau emballé n'est jamais envoyé. */
  async cardView(cardId: string): Promise<SurpriseCardView> {
    const gifts = await this.prisma.loyaltyGift.findMany({ where: { cardId }, orderBy: { unlockedAt: 'desc' }, take: 100 });
    const now = new Date();
    const prizes = await this.prizesById(gifts.filter((gift) => gift.revealedAt).map((gift) => gift.prizeId));
    const views = gifts.map((gift) => this.giftView(gift, now, prizes));
    // Les cadeaux emballés d'abord, puis les autres du plus récent au plus ancien.
    views.sort((a, b) => Number(b.state === 'wrapped') - Number(a.state === 'wrapped'));
    return { giftsReceived: gifts.length, gifts: views };
  }

  /** R9 : déballer révèle le lot et note l'heure. */
  async reveal(guest: GuestSession, cardId: string, giftId: string): Promise<GuestGiftView> {
    const gift = await this.findGift(guest, cardId, giftId);
    const now = new Date();
    if (!gift.revealedAt) {
      await this.prisma.loyaltyGift.updateMany({ where: { id: gift.id, revealedAt: null }, data: { revealedAt: now } });
      await this.audit.record({ action: 'loyalty.gift_revealed', tenantId: guest.tenantId, establishmentId: guest.establishmentId, entityType: 'LoyaltyGift', entityId: gift.id, metadata: { cardId } });
    }
    const fresh = await this.prisma.loyaltyGift.findUniqueOrThrow({ where: { id: gift.id } });
    return this.giftView(fresh, now, await this.prizesById([fresh.prizeId]));
  }

  /** R7 : les feux d'artifice ne se rejouent pas. */
  async celebrated(guest: GuestSession, cardId: string, giftId: string): Promise<void> {
    const gift = await this.findGift(guest, cardId, giftId);
    await this.prisma.loyaltyGift.updateMany({ where: { id: gift.id, celebratedAt: null }, data: { celebratedAt: new Date() } });
  }

  /** R10 et R11 : utiliser un cadeau déballé et valable ; un par session, validé ensuite par le personnel. */
  async use(guest: GuestSession, cardId: string, giftId: string): Promise<GuestGiftView> {
    const gift = await this.findGift(guest, cardId, giftId);
    const now = new Date();
    const state = giftState(gift, now);
    if (state === 'wrapped') throw unprocessable('GIFT_WRAPPED', 'Déballez d’abord votre cadeau.');
    if (state === 'expired') throw unprocessable('GIFT_EXPIRED', 'Ce cadeau a expiré.');
    if (state !== 'won') throw conflict('GIFT_ALREADY_USED', 'Ce cadeau est déjà utilisé.');
    const sameVisit = await this.prisma.loyaltyGift.count({ where: { useSessionId: guest.id } });
    if (sameVisit > 0) throw conflict('GIFT_ONE_PER_VISIT', 'Un cadeau par visite : gardez celui-ci pour la prochaine fois.');
    try {
      const updated = await this.prisma.loyaltyGift.updateMany({
        where: { id: gift.id, requestedAt: null, usedAt: null, expiresAt: { gt: now } },
        data: { requestedAt: now, useSessionId: guest.id, tableId: guest.tableId },
      });
      if (updated.count !== 1) throw conflict('GIFT_ALREADY_USED', 'Ce cadeau est déjà utilisé.');
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        throw conflict('GIFT_ONE_PER_VISIT', 'Un cadeau par visite : gardez celui-ci pour la prochaine fois.');
      }
      throw error;
    }
    await this.audit.record({ action: 'loyalty.gift_requested', tenantId: guest.tenantId, establishmentId: guest.establishmentId, entityType: 'LoyaltyGift', entityId: gift.id, metadata: { cardId, sessionId: guest.id } });
    const fresh = await this.prisma.loyaltyGift.findUniqueOrThrow({ where: { id: gift.id } });
    return this.giftView(fresh, now, await this.prizesById([fresh.prizeId]));
  }

  // ---------------------------------------------------------------- personnel

  /** Cadeaux demandés, en attente de validation, pour la fiche de table. */
  async pending(scope: Scope) {
    const gifts = await this.prisma.loyaltyGift.findMany({
      where: { establishmentId: scope.establishmentId, tenantId: scope.tenantId, requestedAt: { not: null }, usedAt: null },
      orderBy: { requestedAt: 'asc' },
    });
    const prizes = await this.prizesById(gifts.map((gift) => gift.prizeId));
    return gifts.map((gift) => {
      const prize = prizes.get(gift.prizeId);
      return {
        id: gift.id,
        kind: 'gift' as const,
        tableId: gift.tableId as string,
        sessionId: gift.useSessionId as string,
        prizeKind: prize?.kind ?? 'free',
        reward: prize ? { id: prize.menuItemId ?? prize.id, name: prize.name, imageId: prize.imageId } : null,
        createdAt: (gift.requestedAt as Date).toISOString(),
      };
    });
  }

  /** R10 : plat de la carte → commande offerte (spec 033) ; lot libre → « Remis », sans ligne dans l'addition. */
  async validate(scope: Scope, giftId: string): Promise<{ validated: true }> {
    await this.prisma.$transaction(async (tx) => {
      const gift = await tx.loyaltyGift.findFirst({ where: { id: giftId, establishmentId: scope.establishmentId, tenantId: scope.tenantId } });
      if (!gift || !gift.requestedAt || !gift.useSessionId) throw notFound('GIFT_NOT_FOUND', 'Cadeau introuvable.');
      const used = await tx.loyaltyGift.updateMany({ where: { id: gift.id, usedAt: null }, data: { usedAt: new Date(), usedById: scope.userId } });
      if (used.count !== 1) throw conflict('ALREADY_VALIDATED', 'Cadeau déjà validé.');
      const prize = await tx.loyaltyPrize.findUniqueOrThrow({ where: { id: gift.prizeId } });
      let requestId: string | null = null;
      if (prize.kind === 'menu_item' && prize.menuItemId) {
        requestId = await this.requests.createRewardOrder(tx, gift.useSessionId, prize.menuItemId, staffActor(scope));
        await tx.loyaltyGift.update({ where: { id: gift.id }, data: { requestId } });
      }
      await this.audit.record(
        { action: 'loyalty.gift_validated', tenantId: scope.tenantId, establishmentId: scope.establishmentId, actorId: scope.userId, entityType: 'LoyaltyGift', entityId: gift.id, metadata: { prizeId: prize.id, kind: prize.kind, requestId }, ip: scope.ip },
        tx,
      );
    });
    this.outbox.kick();
    return { validated: true };
  }

  // ---------------------------------------------------------------- outils

  private async surpriseActive(establishmentId: string): Promise<boolean> {
    const program = await this.prisma.loyaltyProgram.findUnique({ where: { establishmentId }, select: { mode: true, isActive: true } });
    return program?.mode === 'surprise' && program.isActive;
  }

  private async findPrize(scope: Scope, id: string): Promise<LoyaltyPrize> {
    const prize = await this.prisma.loyaltyPrize.findFirst({ where: { id, establishmentId: scope.establishmentId, tenantId: scope.tenantId, archivedAt: null } });
    if (!prize) throw notFound('PRIZE_NOT_FOUND', 'Cadeau introuvable.');
    return prize;
  }

  private async findGift(guest: GuestSession, cardId: string, giftId: string): Promise<LoyaltyGift> {
    const gift = await this.prisma.loyaltyGift.findFirst({ where: { id: giftId, cardId, establishmentId: guest.establishmentId } });
    if (!gift) throw notFound('GIFT_NOT_FOUND', 'Cadeau introuvable.');
    return gift;
  }

  /** Image du lot ; à défaut, la photo du plat de la carte. */
  private async prizesById(ids: string[]) {
    if (ids.length === 0) return new Map<string, { id: string; kind: 'menu_item' | 'free'; name: string; imageId: string | null; menuItemId: string | null }>();
    const rows = await this.prisma.loyaltyPrize.findMany({ where: { id: { in: [...new Set(ids)] } } });
    const items = await this.itemImages(rows);
    return new Map(rows.map((row) => [row.id, { id: row.id, kind: row.kind, name: row.name, menuItemId: row.menuItemId, imageId: row.imageId ?? (row.menuItemId ? (items.get(row.menuItemId) ?? null) : null) }]));
  }

  private async itemImages(rows: LoyaltyPrize[]): Promise<Map<string, string | null>> {
    const ids = rows.filter((row) => !row.imageId && row.menuItemId).map((row) => row.menuItemId as string);
    if (ids.length === 0) return new Map();
    const items = await this.prisma.menuItem.findMany({ where: { id: { in: ids } }, select: { id: true, imageId: true } });
    return new Map(items.map((item) => [item.id, item.imageId]));
  }

  private async prizeViews(rows: LoyaltyPrize[]): Promise<PrizeView[]> {
    const month = stockMonth(new Date());
    const [draws, items] = await Promise.all([
      this.prisma.loyaltyPrizeDraw.findMany({ where: { prizeId: { in: rows.map((row) => row.id) }, month } }),
      this.itemImages(rows),
    ]);
    const counts = new Map(draws.map((row) => [row.prizeId, row.count]));
    return rows.map((row) => ({
      id: row.id,
      kind: row.kind,
      menuItemId: row.menuItemId,
      name: row.name,
      imageId: row.imageId ?? (row.menuItemId ? (items.get(row.menuItemId) ?? null) : null),
      weight: row.weight,
      monthlyStock: row.monthlyStock,
      drawnThisMonth: counts.get(row.id) ?? 0,
      position: row.position,
    }));
  }

  private giftView(gift: LoyaltyGift, now: Date, prizes: Map<string, { kind: 'menu_item' | 'free'; name: string; imageId: string | null }>): GuestGiftView {
    const prize = gift.revealedAt ? prizes.get(gift.prizeId) : undefined;
    return {
      id: gift.id,
      state: giftState(gift, now),
      revealed: gift.revealedAt !== null,
      atStamp: gift.atStamp,
      unlockedAt: gift.unlockedAt.toISOString(),
      expiresAt: gift.expiresAt.toISOString(),
      celebrate: gift.celebratedAt === null,
      prize: prize ? { name: prize.name, imageId: prize.imageId, kind: prize.kind } : null,
    };
  }
}
