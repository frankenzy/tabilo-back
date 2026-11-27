import { Body, Controller, Get, HttpCode, Injectable, Module, Param, ParseUUIDPipe, Post, Put, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiHeader, ApiOperation, ApiProperty, ApiPropertyOptional, ApiTags } from '@nestjs/swagger';
import { IsBoolean, IsInt, IsOptional, IsString, IsUUID, Max, MaxLength, Min, MinLength } from 'class-validator';
import { CurrentGuest, CurrentScope, Public, RequirePermissions } from '../../commons/decorators';
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

/** Spec 043, R1 : la carte de fidélité de l'établissement. */
export class LoyaltyProgramDto {
  @ApiProperty({ minimum: 5, maximum: 20 }) @IsInt() @Min(5) @Max(20)
  stampsRequired: number;

  @ApiProperty({ description: 'Montant minimum d’une commande réglée pour un tampon (unité mineure)' }) @IsInt() @Min(0) @Max(100_000_000)
  minOrderMinor: number;

  @ApiProperty() @IsUUID()
  rewardItemId: string;

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
  stamps: number;
  stampsRequired: number;
  minOrderMinor: number;
  rewardItemId: string;
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
  ) {}

  // ---------------------------------------------------------------- gérant

  async program(scope: Scope) {
    return this.prisma.loyaltyProgram.findUnique({ where: { establishmentId: scope.establishmentId } });
  }

  /** R1 et R7 : réglage de la carte, réservé aux formules qui comprennent la fidélité. */
  async saveProgram(scope: Scope, dto: LoyaltyProgramDto) {
    await this.plans.assertFeature(scope.tenantId, 'loyalty');
    const reward = await this.prisma.menuItem.findFirst({
      where: { id: dto.rewardItemId, tenantId: scope.tenantId, establishmentId: scope.establishmentId, archivedAt: null },
      select: { id: true },
    });
    if (!reward) throw unprocessable('REWARD_NOT_FOUND', 'Choisissez une récompense parmi les plats de la carte.');
    const data = { stampsRequired: dto.stampsRequired, minOrderMinor: dto.minOrderMinor, rewardItemId: dto.rewardItemId, isActive: dto.isActive ?? true };
    const saved = await this.prisma.loyaltyProgram.upsert({
      where: { establishmentId: scope.establishmentId },
      create: { tenantId: scope.tenantId, establishmentId: scope.establishmentId, ...data },
      update: data,
    });
    await this.audit.record({ action: 'loyalty.program_saved', tenantId: scope.tenantId, establishmentId: scope.establishmentId, actorId: scope.userId, metadata: data, ip: scope.ip });
    return saved;
  }

  /** R4 : récompenses en attente de validation, pour la fiche de table. */
  async pending(scope: Scope) {
    const rows = await this.prisma.loyaltyRedemption.findMany({
      where: { establishmentId: scope.establishmentId, tenantId: scope.tenantId, validatedAt: null },
      orderBy: { createdAt: 'asc' },
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
    const session = await this.prisma.tableSession.findUniqueOrThrow({ where: { id: guest.id }, select: { loyaltyCardId: true } });
    if (!session.loyaltyCardId) throw unprocessable('NO_CARD', 'Aucune carte sur ce téléphone.');
    const card = await this.prisma.loyaltyCard.findUniqueOrThrow({ where: { id: session.loyaltyCardId } });
    if (card.stamps < program.stampsRequired) throw unprocessable('CARD_NOT_FULL', 'La carte n’est pas encore pleine.');
    const created = await this.prisma.loyaltyRedemption.createMany({
      data: [{ tenantId: guest.tenantId, establishmentId: guest.establishmentId, cardId: card.id, sessionId: guest.id, tableId: guest.tableId, rewardItemId: program.rewardItemId }],
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

  private async view(guest: GuestSession, cardId: string, program: { stampsRequired: number; minOrderMinor: number; rewardItemId: string }): Promise<GuestCardView> {
    const [card, redemption] = await Promise.all([
      this.prisma.loyaltyCard.findUniqueOrThrow({ where: { id: cardId }, select: { stamps: true } }),
      this.prisma.loyaltyRedemption.findUnique({ where: { sessionId: guest.id }, select: { id: true, validatedAt: true } }),
    ]);
    return {
      stamps: card.stamps,
      stampsRequired: program.stampsRequired,
      minOrderMinor: program.minOrderMinor,
      rewardItemId: program.rewardItemId,
      redemption: redemption ? { id: redemption.id, validated: redemption.validatedAt !== null } : null,
    };
  }
}

@ApiTags('Fidélité')
@ApiBearerAuth()
@Controller({ path: 'establishments/:establishmentId/loyalty', version: '1' })
export class LoyaltyStaffController {
  constructor(private readonly loyalty: LoyaltyService) {}

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
  @ApiOperation({ summary: 'Spec 043, R4 : récompenses à valider' })
  pending(@CurrentScope() scope: Scope) {
    return this.loyalty.pending(scope);
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
  constructor(private readonly loyalty: LoyaltyService) {}

  @Get()
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
}

@Module({ imports: [ServiceRequestsModule, RealtimeModule], controllers: [LoyaltyStaffController, LoyaltyGuestController], providers: [LoyaltyService] })
export class LoyaltyModule {}
