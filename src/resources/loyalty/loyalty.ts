import { Body, Controller, Delete, Get, HttpCode, Injectable, Module, Param, ParseUUIDPipe, Patch, Post, Put, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiHeader, ApiOperation, ApiProperty, ApiPropertyOptional, ApiTags } from '@nestjs/swagger';
import { IsBoolean, IsIn, IsInt, IsOptional, IsString, IsUUID, Max, MaxLength, Min, MinLength, ValidateIf } from 'class-validator';
import { AllowSettledSession, CurrentGuest, CurrentScope, Public, RequirePermissions } from '../../commons/decorators';
import { GuestSessionGuard, SESSION_HEADER } from '../../commons/guards/guest-session.guard';
import { PrismaService } from '../../commons/prisma/prisma.service';
import { AuditService } from '../../commons/services/audit.service';
import { PlanService } from '../../commons/services/plan.service';
import type { GuestSession, Scope } from '../../commons/types';
import { hashToken, randomToken } from '../../commons/utils/crypto';
import { conflict, notFound, unprocessable } from '../../commons/utils/errors';
import { OutboxService } from '../outbox/outbox.service';
import { RealtimeModule } from '../realtime/realtime.module';
import { ServiceRequestsModule } from '../service-requests/service-requests.module';
import { ServiceRequestsService, staffActor } from '../service-requests/service-requests.service';
import { MenuImageDto } from '../menu/menu.controller';
import { drawThreshold } from './loyalty-draw';
import { CreatePrizeDto, SurpriseService, UpdatePrizeDto, type SurpriseCardView } from './loyalty-surprise';

/** Spec 043, R1 et spec 046, R1 : la carte de fidélité de l'établissement, en mode Classique ou Surprise. */
export class LoyaltyProgramDto {
  @ApiPropertyOptional({ enum: ['classic', 'surprise'], default: 'classic' }) @IsOptional() @IsIn(['classic', 'surprise'])
  mode?: 'classic' | 'surprise';

  @ApiPropertyOptional({ minimum: 5, maximum: 20, description: 'Mode Classique' }) @ValidateIf((dto: LoyaltyProgramDto) => dto.mode !== 'surprise' || dto.stampsRequired !== undefined)
  @IsInt() @Min(5) @Max(20)
  stampsRequired?: number;

  @ApiProperty({ description: 'Montant minimum d’une commande réglée pour un tampon (unité mineure)' }) @IsInt() @Min(0) @Max(100_000_000)
  minOrderMinor: number;

  @ApiPropertyOptional({ description: 'Récompense du mode Classique' }) @ValidateIf((dto: LoyaltyProgramDto) => dto.mode !== 'surprise' || dto.rewardItemId !== undefined)
  @IsUUID()
  rewardItemId?: string;

  @ApiPropertyOptional({ minimum: 1, maximum: 20, description: 'Mode Surprise : au moins tant de commandes' }) @IsOptional() @IsInt() @Min(1) @Max(20)
  surpriseMin?: number;

  @ApiPropertyOptional({ minimum: 1, maximum: 20, description: 'Mode Surprise : au plus tant de commandes' }) @IsOptional() @IsInt() @Min(1) @Max(20)
  surpriseMax?: number;

  @ApiPropertyOptional({ minimum: 1, maximum: 365, description: 'Validité d’un cadeau, en jours' }) @IsOptional() @IsInt() @Min(1) @Max(365)
  giftValidityDays?: number;

  @ApiPropertyOptional() @IsOptional() @IsBoolean()
  isActive?: boolean;
}

/** Spec 043, R2 : jeton de carte gardé par le téléphone. */
export class AttachCardDto {
  @ApiPropertyOptional() @IsOptional() @IsString() @MinLength(32) @MaxLength(128)
  token?: string;
}

export interface GuestCardView {
  /** Jeton à garder dans le téléphone ; renvoyé seulement à la création de la carte. */
  token?: string;
  mode: 'classic' | 'surprise';
  stamps: number;
  stampsRequired: number;
  minOrderMinor: number;
  rewardItemId: string | null;
  /** Spec 046 : cadeaux du mode Surprise, avec la place du prochain (R5 révisée) ; jamais le lot d'un cadeau emballé. */
  surprise: SurpriseCardView | null;
  /** Spec 046, R16 : la visite (session) a-t-elle donné un tampon ? */
  visitStamped: boolean;
  /** Récompense demandée pendant cette visite, en attente ou validée. */
  redemption: { id: string; validated: boolean } | null;
}

@Injectable()
export class LoyaltyService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly plans: PlanService,
    private readonly outbox: OutboxService,
    private readonly requests: ServiceRequestsService,
    private readonly surprise: SurpriseService,
  ) {}

  // ---------------------------------------------------------------- gérant

  async program(scope: Scope) {
    return this.prisma.loyaltyProgram.findUnique({ where: { establishmentId: scope.establishmentId } });
  }

  /** R1 et R7 : réglage de la carte, réservé aux formules qui comprennent la fidélité. */
  async saveProgram(scope: Scope, dto: LoyaltyProgramDto) {
    await this.plans.assertFeature(scope.tenantId, 'loyalty');
    const mode = dto.mode ?? 'classic';
    const current = await this.prisma.loyaltyProgram.findUnique({ where: { establishmentId: scope.establishmentId } });
    if (dto.rewardItemId !== undefined) {
      const reward = await this.prisma.menuItem.findFirst({
        where: { id: dto.rewardItemId, tenantId: scope.tenantId, establishmentId: scope.establishmentId, archivedAt: null },
        select: { id: true },
      });
      if (!reward) throw unprocessable('REWARD_NOT_FOUND', 'Choisissez une récompense parmi les plats de la carte.');
    }
    const surpriseMin = dto.surpriseMin ?? current?.surpriseMin ?? 2;
    const surpriseMax = dto.surpriseMax ?? current?.surpriseMax ?? 5;
    const isActive = dto.isActive ?? true;
    if (mode === 'surprise') {
      // Spec 046, R4 et R3 : un intervalle cohérent et un panier qui donne toujours quelque chose.
      if (surpriseMin > surpriseMax) throw unprocessable('INVALID_RANGE', 'Le minimum de commandes doit être inférieur ou égal au maximum.');
      if (isActive) await this.surprise.assertValidBasket(scope.establishmentId);
    }
    const data = {
      mode,
      stampsRequired: dto.stampsRequired ?? current?.stampsRequired ?? 10,
      minOrderMinor: dto.minOrderMinor,
      rewardItemId: dto.rewardItemId ?? current?.rewardItemId ?? null,
      surpriseMin,
      surpriseMax,
      giftValidityDays: dto.giftValidityDays ?? current?.giftValidityDays ?? 30,
      isActive,
    };
    const saved = await this.prisma.$transaction(async (tx) => {
      const program = await tx.loyaltyProgram.upsert({
        where: { establishmentId: scope.establishmentId },
        create: { tenantId: scope.tenantId, establishmentId: scope.establishmentId, ...data },
        update: data,
      });
      // Spec 046, R1 et Q10 : en passant en mode Surprise (ou en changeant l'intervalle), le prochain seuil est
      // retiré à partir des tampons en cours.
      if (mode === 'surprise' && (current?.mode !== 'surprise' || current.surpriseMin !== surpriseMin || current.surpriseMax !== surpriseMax)) {
        await tx.loyaltyCard.updateMany({ where: { establishmentId: scope.establishmentId }, data: { nextGiftAt: null } });
      }
      return program;
    });
    await this.audit.record({ action: 'loyalty.program_saved', tenantId: scope.tenantId, establishmentId: scope.establishmentId, actorId: scope.userId, metadata: data, ip: scope.ip });
    return saved;
  }

  /** R4 : récompenses en attente de validation, pour la fiche de table. */
  async pending(scope: Scope) {
    const rows = await this.prisma.loyaltyRedemption.findMany({
      where: { establishmentId: scope.establishmentId, tenantId: scope.tenantId, validatedAt: null },
      orderBy: { createdAt: 'desc' },
    });
    const items = new Map(
      (await this.prisma.menuItem.findMany({ where: { id: { in: rows.map((row) => row.rewardItemId) } }, select: { id: true, name: true, imageId: true } })).map((item) => [item.id, item]),
    );
    return rows.map((row) => ({ id: row.id, tableId: row.tableId, sessionId: row.sessionId, reward: items.get(row.rewardItemId) ?? null, createdAt: row.createdAt.toISOString() }));
  }

  /** R4 : le serveur valide ; la récompense devient une commande offerte, la carte repart à zéro (moins les tampons utilisés). */
  async validate(scope: Scope, redemptionId: string) {
    await this.prisma.$transaction(async (tx) => {
      const redemption = await tx.loyaltyRedemption.findFirst({ where: { id: redemptionId, establishmentId: scope.establishmentId, tenantId: scope.tenantId } });
      if (!redemption) throw notFound('REDEMPTION_NOT_FOUND', 'Récompense introuvable.');
      const program = await tx.loyaltyProgram.findUniqueOrThrow({ where: { establishmentId: scope.establishmentId } });
      const used = await tx.loyaltyRedemption.updateMany({
        where: { id: redemption.id, validatedAt: null },
        data: { validatedAt: new Date(), validatedById: scope.userId },
      });
      if (used.count !== 1) throw conflict('ALREADY_VALIDATED', 'Récompense déjà validée.');
      const card = await tx.loyaltyCard.updateMany({
        where: { id: redemption.cardId, stamps: { gte: program.stampsRequired } },
        data: { stamps: { decrement: program.stampsRequired }, rewardsRedeemed: { increment: 1 } },
      });
      if (card.count !== 1) throw conflict('CARD_NOT_FULL', 'La carte n’a pas assez de tampons.');
      const requestId = await this.requests.createRewardOrder(tx, redemption.sessionId, redemption.rewardItemId, staffActor(scope));
      await tx.loyaltyRedemption.update({ where: { id: redemption.id }, data: { requestId } });
      await this.audit.record(
        { action: 'loyalty.reward_validated', tenantId: scope.tenantId, establishmentId: scope.establishmentId, actorId: scope.userId, metadata: { redemptionId, requestId }, ip: scope.ip },
        tx,
      );
    });
    this.outbox.kick();
    return { validated: true };
  }

  // ---------------------------------------------------------------- client

  /**
   * R2 : le téléphone présente son jeton de carte ; sans jeton (ou jeton inconnu), une carte est créée et son jeton
   * rendu une seule fois. La session est rattachée à la carte, pour le tampon du règlement.
   */
  async attach(guest: GuestSession, token: string | undefined): Promise<GuestCardView | null> {
    const program = await this.activeProgram(guest);
    if (!program) return null;
    let card = token ? await this.prisma.loyaltyCard.findUnique({ where: { tokenHash: hashToken(token) } }) : null;
    let fresh: string | undefined;
    if (!card || card.establishmentId !== guest.establishmentId) {
      fresh = randomToken(32);
      card = await this.prisma.loyaltyCard.create({ data: { tenantId: guest.tenantId, establishmentId: guest.establishmentId, tokenHash: hashToken(fresh) } });
    }
    await this.prisma.tableSession.update({ where: { id: guest.id }, data: { loyaltyCardId: card.id } });
    return { ...(await this.view(guest, card.id, program)), ...(fresh ? { token: fresh } : {}) };
  }

  async card(guest: GuestSession): Promise<GuestCardView | null> {
    const program = await this.activeProgram(guest);
    if (!program) return null;
    const session = await this.prisma.tableSession.findUniqueOrThrow({ where: { id: guest.id }, select: { loyaltyCardId: true } });
    if (!session.loyaltyCardId) return null;
    return this.view(guest, session.loyaltyCardId, program);
  }

  /** R4 et R5 : carte pleine, une récompense par visite ; elle attend la validation d'un serveur. */
  async redeem(guest: GuestSession): Promise<GuestCardView> {
    const program = await this.activeProgram(guest);
    if (!program) throw unprocessable('LOYALTY_DISABLED', 'Pas de carte de fidélité ici.');
    if (program.mode !== 'classic' || !program.rewardItemId) throw unprocessable('LOYALTY_MODE', 'Ici, les cadeaux se gagnent en mode Surprise.');
    const rewardItemId = program.rewardItemId;
    const session = await this.prisma.tableSession.findUniqueOrThrow({ where: { id: guest.id }, select: { loyaltyCardId: true } });
    if (!session.loyaltyCardId) throw unprocessable('NO_CARD', 'Aucune carte sur ce téléphone.');
    const card = await this.prisma.loyaltyCard.findUniqueOrThrow({ where: { id: session.loyaltyCardId } });
    if (card.stamps < program.stampsRequired) throw unprocessable('CARD_NOT_FULL', 'La carte n’est pas encore pleine.');
    const created = await this.prisma.loyaltyRedemption.createMany({
      data: [{ tenantId: guest.tenantId, establishmentId: guest.establishmentId, cardId: card.id, sessionId: guest.id, tableId: guest.tableId, rewardItemId }],
      skipDuplicates: true,
    });
    if (created.count === 0) throw conflict('ALREADY_REDEEMED', 'Une récompense est déjà demandée pendant cette visite.');
    await this.audit.record({ action: 'loyalty.reward_requested', tenantId: guest.tenantId, establishmentId: guest.establishmentId, metadata: { cardId: card.id } });
    return this.view(guest, card.id, program);
  }

  private async activeProgram(guest: GuestSession) {
    const program = await this.prisma.loyaltyProgram.findUnique({ where: { establishmentId: guest.establishmentId } });
    return program?.isActive ? program : null;
  }

  /** Spec 046 : carte de la session, pour déballer et utiliser ses cadeaux. */
  async sessionCard(guest: GuestSession): Promise<string> {
    const program = await this.activeProgram(guest);
    if (!program) throw unprocessable('LOYALTY_DISABLED', 'Pas de carte de fidélité ici.');
    const session = await this.prisma.tableSession.findUniqueOrThrow({ where: { id: guest.id }, select: { loyaltyCardId: true } });
    if (!session.loyaltyCardId) throw unprocessable('NO_CARD', 'Aucune carte sur ce téléphone.');
    return session.loyaltyCardId;
  }

  private async view(
    guest: GuestSession,
    cardId: string,
    program: {
      mode: 'classic' | 'surprise';
      stampsRequired: number;
      minOrderMinor: number;
      rewardItemId: string | null;
      surpriseMin: number;
      surpriseMax: number;
    },
  ): Promise<GuestCardView> {
    const [card, redemption, stamp] = await Promise.all([
      this.prisma.loyaltyCard.findUniqueOrThrow({ where: { id: cardId }, select: { stamps: true, nextGiftAt: true } }),
      this.prisma.loyaltyRedemption.findUnique({ where: { sessionId: guest.id }, select: { id: true, validatedAt: true } }),
      this.prisma.loyaltyStamp.findUnique({ where: { sessionId: guest.id }, select: { id: true } }),
    ]);
    let surprise: SurpriseCardView | null = null;
    if (program.mode === 'surprise') {
      const nextAt = card.nextGiftAt ?? (await this.drawFirstThreshold(cardId, card.stamps, program));
      surprise = { ...(await this.surprise.cardView(cardId)), nextAt, remaining: Math.max(1, nextAt - card.stamps) };
    }
    return {
      mode: program.mode,
      stamps: card.stamps,
      stampsRequired: program.stampsRequired,
      minOrderMinor: program.minOrderMinor,
      rewardItemId: program.rewardItemId,
      surprise,
      visitStamped: stamp !== null,
      redemption: redemption ? { id: redemption.id, validated: redemption.validatedAt !== null } : null,
    };
  }

  /**
   * Spec 046, R5 (révisée) : le premier seuil est tiré dès que la carte existe en mode Surprise.
   * Q10 : les tampons en cours comptent ; s'ils dépassent déjà le seuil, la prochaine commande comptée débloque.
   */
  private async drawFirstThreshold(cardId: string, stamps: number, program: { surpriseMin: number; surpriseMax: number }): Promise<number> {
    const drawn = Math.max(drawThreshold(program.surpriseMin, program.surpriseMax), stamps + 1);
    await this.prisma.loyaltyCard.updateMany({ where: { id: cardId, nextGiftAt: null }, data: { nextGiftAt: drawn } });
    // Deux lectures simultanées : la première écriture gagne.
    return (await this.prisma.loyaltyCard.findUniqueOrThrow({ where: { id: cardId }, select: { nextGiftAt: true } })).nextGiftAt ?? drawn;
  }
}

@ApiTags('Fidélité')
@ApiBearerAuth()
@Controller({ path: 'establishments/:establishmentId/loyalty', version: '1' })
export class LoyaltyStaffController {
  constructor(
    private readonly loyalty: LoyaltyService,
    private readonly surprise: SurpriseService,
  ) {}

  @Get()
  @RequirePermissions('menu.manage')
  get(@CurrentScope() scope: Scope) {
    return this.loyalty.program(scope);
  }

  @Put()
  @RequirePermissions('menu.manage')
  @ApiOperation({ summary: 'Spec 043, R1 : régler la carte de fidélité' })
  save(@CurrentScope() scope: Scope, @Body() dto: LoyaltyProgramDto) {
    return this.loyalty.saveProgram(scope, dto);
  }

  @Get('redemptions')
  @RequirePermissions('requests.read')
  @ApiOperation({ summary: 'Spec 043, R4 et spec 046, R10 : récompenses et cadeaux à valider' })
  async pending(@CurrentScope() scope: Scope) {
    const [rewards, gifts] = await Promise.all([this.loyalty.pending(scope), this.surprise.pending(scope)]);
    return [...rewards.map((row) => ({ ...row, kind: 'reward' as const })), ...gifts].sort((a, b) => b.createdAt.localeCompare(a.createdAt)); // Spec 048 : le plus récent d'abord.
  }

  @Post('gifts/:id/validate')
  @HttpCode(200)
  @RequirePermissions('requests.handle')
  @ApiOperation({ summary: 'Spec 046, R10 : valider un cadeau (plat offert ou lot remis)' })
  validateGift(@CurrentScope() scope: Scope, @Param('id', ParseUUIDPipe) id: string) {
    return this.surprise.validate(scope, id);
  }

  @Get('prizes')
  @RequirePermissions('menu.manage')
  @ApiOperation({ summary: 'Spec 046, R2 : le panier de cadeaux' })
  prizes(@CurrentScope() scope: Scope) {
    return this.surprise.prizes(scope);
  }

  @Post('prizes')
  @RequirePermissions('menu.manage')
  @ApiOperation({ summary: 'Spec 046, R2 : ajouter un cadeau au panier' })
  createPrize(@CurrentScope() scope: Scope, @Body() dto: CreatePrizeDto) {
    return this.surprise.createPrize(scope, dto);
  }

  @Patch('prizes/:id')
  @RequirePermissions('menu.manage')
  updatePrize(@CurrentScope() scope: Scope, @Param('id', ParseUUIDPipe) id: string, @Body() dto: UpdatePrizeDto) {
    return this.surprise.updatePrize(scope, id, dto);
  }

  @Delete('prizes/:id')
  @HttpCode(204)
  @RequirePermissions('menu.manage')
  @ApiOperation({ summary: 'Spec 046, R2 : retirer un cadeau (archivé)' })
  async archivePrize(@CurrentScope() scope: Scope, @Param('id', ParseUUIDPipe) id: string): Promise<void> {
    await this.surprise.archivePrize(scope, id);
  }

  @Put('prizes/:id/image')
  @RequirePermissions('menu.manage')
  setPrizeImage(@CurrentScope() scope: Scope, @Param('id', ParseUUIDPipe) id: string, @Body() dto: MenuImageDto) {
    return this.surprise.setPrizeImage(scope, id, dto);
  }

  @Delete('prizes/:id/image')
  @RequirePermissions('menu.manage')
  removePrizeImage(@CurrentScope() scope: Scope, @Param('id', ParseUUIDPipe) id: string) {
    return this.surprise.removePrizeImage(scope, id);
  }

  @Post('redemptions/:id/validate')
  @HttpCode(200)
  @RequirePermissions('requests.handle')
  @ApiOperation({ summary: 'Spec 043, R4 : valider la récompense (commande offerte)' })
  validate(@CurrentScope() scope: Scope, @Param('id', ParseUUIDPipe) id: string) {
    return this.loyalty.validate(scope, id);
  }
}

@ApiTags('Parcours client (sans compte)')
@Public()
@UseGuards(GuestSessionGuard)
@ApiHeader({ name: SESSION_HEADER, required: true })
@Controller({ path: 'guest/loyalty', version: '1' })
export class LoyaltyGuestController {
  constructor(
    private readonly loyalty: LoyaltyService,
    private readonly surprise: SurpriseService,
  ) {}

  /** Spec 046, R7 : lisible aussi depuis « Réglé · Merci », pour fêter le cadeau débloqué au règlement. */
  @Get()
  @AllowSettledSession()
  card(@CurrentGuest() guest: GuestSession) {
    return this.loyalty.card(guest);
  }

  @Post('attach')
  @HttpCode(200)
  @ApiOperation({ summary: 'Spec 043, R2 : présenter sa carte (ou en recevoir une)' })
  attach(@CurrentGuest() guest: GuestSession, @Body() dto: AttachCardDto) {
    return this.loyalty.attach(guest, dto.token);
  }

  @Post('redeem')
  @HttpCode(200)
  @ApiOperation({ summary: 'Spec 043, R4 : utiliser une carte pleine' })
  redeem(@CurrentGuest() guest: GuestSession) {
    return this.loyalty.redeem(guest);
  }

  @Post('gifts/:id/reveal')
  @HttpCode(200)
  @AllowSettledSession()
  @ApiOperation({ summary: 'Spec 046, R9 : déballer un cadeau' })
  async reveal(@CurrentGuest() guest: GuestSession, @Param('id', ParseUUIDPipe) id: string) {
    return this.surprise.reveal(guest, await this.loyalty.sessionCard(guest), id);
  }

  @Post('gifts/:id/celebrated')
  @HttpCode(204)
  @AllowSettledSession()
  @ApiOperation({ summary: 'Spec 046, R7 : les feux d’artifice ont été joués' })
  async celebrated(@CurrentGuest() guest: GuestSession, @Param('id', ParseUUIDPipe) id: string): Promise<void> {
    await this.surprise.celebrated(guest, await this.loyalty.sessionCard(guest), id);
  }

  @Post('gifts/:id/use')
  @HttpCode(200)
  @ApiOperation({ summary: 'Spec 046, R10 : utiliser un cadeau (un par visite)' })
  async use(@CurrentGuest() guest: GuestSession, @Param('id', ParseUUIDPipe) id: string) {
    return this.surprise.use(guest, await this.loyalty.sessionCard(guest), id);
  }
}

@Module({ imports: [ServiceRequestsModule, RealtimeModule], controllers: [LoyaltyStaffController, LoyaltyGuestController], providers: [LoyaltyService, SurpriseService] })
export class LoyaltyModule {}
