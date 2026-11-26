import {
  Body, CanActivate, Controller, ExecutionContext, Get, HttpCode, Inject, Injectable, Module, Param, ParseUUIDPipe, Post, Query, Req, Res, UseGuards,
} from '@nestjs/common';
import { ApiOperation, ApiProperty, ApiPropertyOptional, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { PaymentMethod, PlanKey, Prisma } from '@prisma/client';
import * as argon2 from 'argon2';
import { Transform } from 'class-transformer';
import { IsEmail, IsEnum, IsIn, IsInt, IsOptional, IsString, Max, MaxLength, Min, MinLength } from 'class-validator';
import type { FastifyReply, FastifyRequest } from 'fastify';
// Types de `request.cookies` et `reply.setCookie` (plugin enregistré dans app.setup.ts).
import type {} from '@fastify/cookie';
import { APP_ENV, AppEnv } from '../../commons/config/env';
import { ERASE_DELAY_DEFAULT_DAYS, ERASE_DELAY_MAX_DAYS } from '../../commons/constants/legal';
import { PLANS } from '../../commons/constants/plans';
import { Public } from '../../commons/decorators';
import { PrismaService, Tx } from '../../commons/prisma/prisma.service';
import { AuditService } from '../../commons/services/audit.service';
import { hashToken, randomToken } from '../../commons/utils/crypto';
import { conflict, notFound, unauthorized, unprocessable } from '../../commons/utils/errors';
import { rateLimit } from '../../commons/utils/rate-limit';
import { addMonths, SubscriptionModule, SubscriptionService, toReceiptView } from '../subscription/subscription';

/** Spec 036, R7 : session de 8 heures, cookie HttpOnly limité aux routes de la plateforme. */
export const PLATFORM_COOKIE = 'tabilo_pf';
const COOKIE_PATH = '/api/v1/platform';
const SESSION_HOURS = 8;
const MAX_FAILED = 5;
const LOCK_MINUTES = 15;
const RESET_HOURS = 24;

const trim = ({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() : value);

// ------------------------------------------------------------------ DTO

export class PlatformLoginDto {
  @ApiProperty() @Transform(({ value }) => (typeof value === 'string' ? value.trim().toLowerCase() : value)) @IsEmail()
  email: string;

  @ApiProperty() @IsString() @MinLength(1) @MaxLength(128)
  password: string;
}

export class ChangePlanDto {
  @ApiProperty({ enum: PlanKey }) @IsEnum(PlanKey)
  plan: PlanKey;
}

export class ExtendDto {
  @ApiProperty({ minimum: 1, maximum: 90 }) @IsInt() @Min(1) @Max(90)
  days: number;

  @ApiPropertyOptional() @IsOptional() @Transform(trim) @IsString() @MaxLength(200)
  reason?: string;
}

export class ReasonDto {
  @ApiProperty() @Transform(trim) @IsString() @MinLength(3) @MaxLength(200)
  reason: string;
}

export class RecordPaymentDto {
  @ApiProperty({ description: 'Montant en F CFA, entier' }) @IsInt() @Min(1) @Max(100_000_000)
  amountMinor: number;

  @ApiProperty({ enum: PaymentMethod }) @IsEnum(PaymentMethod)
  method: PaymentMethod;

  @ApiPropertyOptional() @IsOptional() @Transform(trim) @IsString() @MaxLength(80)
  reference?: string;

  @ApiProperty({ enum: [1, 3, 6, 12] }) @IsIn([1, 3, 6, 12])
  months: number;

  @ApiProperty({ enum: PlanKey }) @IsEnum(PlanKey)
  plan: PlanKey;
}

/** Spec 041, R4 : fermer un compte — nom recopié pour confirmer, motif, délai avant effacement. */
export class CloseTenantDto {
  @ApiProperty() @Transform(trim) @IsString() @MinLength(1) @MaxLength(80)
  confirmName: string;

  @ApiProperty() @Transform(trim) @IsString() @MinLength(3) @MaxLength(200)
  reason: string;

  @ApiPropertyOptional({ minimum: 1, maximum: ERASE_DELAY_MAX_DAYS, default: ERASE_DELAY_DEFAULT_DAYS }) @IsOptional() @IsInt() @Min(1) @Max(ERASE_DELAY_MAX_DAYS)
  days?: number;
}

export class ListTenantsQuery {
  @ApiPropertyOptional({ enum: ['trial', 'active', 'past_due', 'suspended'] })
  @IsOptional() @IsIn(['trial', 'active', 'past_due', 'suspended'])
  state?: 'trial' | 'active' | 'past_due' | 'suspended';

  @ApiPropertyOptional() @IsOptional() @Transform(trim) @IsString() @MaxLength(80)
  q?: string;
}

// ------------------------------------------------------------------ garde

interface PlatformRequest extends FastifyRequest {
  platformAdmin?: { id: string; name: string; email: string };
}

/**
 * Spec 036, R2 : n'accepte qu'une session de la console. Sans elle, la route répond 404, comme si elle n'existait pas ;
 * un jeton d'un compte client n'y ouvre rien.
 */
@Injectable()
export class PlatformGuard implements CanActivate {
  constructor(private readonly prisma: PrismaService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<PlatformRequest>();
    const token = (request.cookies as Record<string, string | undefined> | undefined)?.[PLATFORM_COOKIE];
    const session = token
      ? await this.prisma.platformSession.findUnique({ where: { tokenHash: hashToken(token) }, include: { admin: { select: { id: true, name: true, email: true } } } })
      : null;
    if (!session || session.revokedAt || session.expiresAt <= new Date()) throw notFound('NOT_FOUND', 'Introuvable.');
    request.platformAdmin = session.admin;
    return true;
  }
}

function adminOf(request: FastifyRequest): { id: string; name: string; email: string } {
  const admin = (request as PlatformRequest).platformAdmin;
  if (!admin) throw new Error('PlatformGuard absent');
  return admin;
}

// ---------------------------------------------------------------- service

@Injectable()
export class PlatformService {
  private readonly dummyHash = argon2.hash(randomToken(), { type: argon2.argon2id });

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly subscriptions: SubscriptionService,
    @Inject(APP_ENV) private readonly env: AppEnv,
  ) {}

  /** R7 : mot de passe, verrouillage après 5 échecs, session de 8 heures. */
  async login(dto: PlatformLoginDto): Promise<{ token: string; expiresAt: Date; admin: { id: string; name: string; email: string } }> {
    const admin = await this.prisma.platformAdmin.findUnique({ where: { email: dto.email } });
    const invalid = () => unauthorized('INVALID_CREDENTIALS', 'E-mail ou mot de passe incorrect.');
    if (!admin) {
      await argon2.verify(await this.dummyHash, dto.password);
      throw invalid();
    }
    if (admin.lockedUntil && admin.lockedUntil > new Date()) {
      throw unauthorized('ACCOUNT_LOCKED', `Trop de tentatives. Réessayez dans ${LOCK_MINUTES} minutes.`);
    }
    if (!(await argon2.verify(admin.passwordHash, dto.password))) {
      const failed = admin.failedLoginCount + 1;
      const lock = failed >= MAX_FAILED;
      await this.prisma.platformAdmin.update({
        where: { id: admin.id },
        data: { failedLoginCount: lock ? 0 : failed, lockedUntil: lock ? new Date(Date.now() + LOCK_MINUTES * 60_000) : null },
      });
      throw invalid();
    }
    const token = randomToken(48);
    const expiresAt = new Date(Date.now() + SESSION_HOURS * 3_600_000);
    await this.prisma.$transaction([
      this.prisma.platformAdmin.update({ where: { id: admin.id }, data: { failedLoginCount: 0, lockedUntil: null, lastLoginAt: new Date() } }),
      this.prisma.platformSession.create({ data: { adminId: admin.id, tokenHash: hashToken(token), expiresAt } }),
      this.prisma.platformAuditLog.create({ data: { adminId: admin.id, action: 'platform.login' } }),
    ]);
    return { token, expiresAt, admin: { id: admin.id, name: admin.name, email: admin.email } };
  }

  async logout(token: string | undefined): Promise<void> {
    if (!token) return;
    await this.prisma.platformSession.updateMany({ where: { tokenHash: hashToken(token), revokedAt: null }, data: { revokedAt: new Date() } });
  }

  /** R3 : des chiffres agrégés seulement, jamais de commande, de carte ni de client. */
  async listTenants(query: ListTenantsQuery) {
    const tenants = await this.prisma.tenant.findMany({
      where: {
        accountState: query.state,
        ...(query.q ? { name: { contains: query.q, mode: 'insensitive' as const } } : {}),
      },
      orderBy: { paidUntil: 'asc' },
      take: 500,
      select: {
        id: true, name: true, plan: true, accountState: true, paidUntil: true, manuallySuspended: true, createdAt: true,
        closedAt: true, deleteAfter: true, erasedAt: true,
      },
    });
    const ids = tenants.map((tenant) => tenant.id);
    if (ids.length === 0) return [];
    const since = new Date(Date.now() - 30 * 86_400_000);
    const stats = await this.prisma.$queryRaw<{ tenantId: string; establishments: number; tables: number; orders: number; lastActivity: Date | null }[]>`
      SELECT t.id AS "tenantId",
        (SELECT count(*)::int FROM "Establishment" e WHERE e."tenantId" = t.id AND e."archivedAt" IS NULL) AS establishments,
        (SELECT count(*)::int FROM "DiningTable" d WHERE d."tenantId" = t.id AND d."archivedAt" IS NULL) AS tables,
        (SELECT count(*)::int FROM "ServiceRequest" r WHERE r."tenantId" = t.id AND r."totalMinor" IS NOT NULL AND r."createdAt" >= ${since}) AS orders,
        (SELECT max(r."createdAt") FROM "ServiceRequest" r WHERE r."tenantId" = t.id) AS "lastActivity"
      FROM "Tenant" t WHERE t.id = ANY(${ids}::uuid[])`;
    const byId = new Map(stats.map((row) => [row.tenantId, row]));
    return tenants.map((tenant) => {
      const row = byId.get(tenant.id);
      return {
        ...tenant,
        planName: PLANS[tenant.plan].name,
        paidUntil: tenant.paidUntil.toISOString(),
        createdAt: tenant.createdAt.toISOString(),
        closedAt: tenant.closedAt?.toISOString() ?? null,
        deleteAfter: tenant.deleteAfter?.toISOString() ?? null,
        erasedAt: tenant.erasedAt?.toISOString() ?? null,
        establishments: row?.establishments ?? 0,
        tables: row?.tables ?? 0,
        orders30d: row?.orders ?? 0,
        lastActivity: row?.lastActivity?.toISOString() ?? null,
      };
    });
  }

  async getTenant(id: string) {
    const tenant = await this.prisma.tenant.findUnique({
      where: { id },
      select: {
        id: true, name: true, plan: true, accountState: true, paidUntil: true, manuallySuspended: true, createdAt: true,
        establishments: { where: { archivedAt: null }, select: { id: true, name: true, phone: true, address: true } },
        payments: { orderBy: { createdAt: 'desc' }, include: { tenant: { select: { name: true } } } },
      },
    });
    if (!tenant) throw notFound('TENANT_NOT_FOUND', 'Compte introuvable.');
    const [owners, log, [summary]] = await Promise.all([
      this.prisma.user.findMany({
        where: { tenantId: id, memberships: { some: { role: { key: 'owner', tenantId: null } } } },
        select: { id: true, firstName: true, lastName: true, email: true, status: true },
      }),
      this.prisma.platformAuditLog.findMany({ where: { tenantId: id }, orderBy: { createdAt: 'desc' }, take: 50 }),
      this.listTenants({}).then((list) => list.filter((row) => row.id === id)),
    ]);
    const admins = new Map(
      (await this.prisma.platformAdmin.findMany({ where: { id: { in: [...new Set(log.map((entry) => entry.adminId))] } }, select: { id: true, name: true } })).map(
        (admin) => [admin.id, admin.name],
      ),
    );
    return {
      ...summary,
      establishmentsList: tenant.establishments,
      owners,
      payments: tenant.payments.map(toReceiptView),
      log: log.map((entry) => ({ ...entry, adminName: admins.get(entry.adminId) ?? null, createdAt: entry.createdAt.toISOString() })),
    };
  }

  /** R4 : changer la formule (spec 034). */
  async changePlan(adminId: string, tenantId: string, plan: PlanKey) {
    return this.change(adminId, tenantId, 'plan_changed', undefined, async (tx, before) => {
      if (before.plan === plan) throw conflict('SAME_PLAN', 'Le compte a déjà cette formule.');
      await tx.tenant.update({ where: { id: tenantId }, data: { plan } });
    });
  }

  /** R4 : prolonger l'essai ou l'échéance de 1 à 90 jours, à partir d'aujourd'hui si elle est passée. */
  async extend(adminId: string, tenantId: string, days: number, reason?: string) {
    return this.change(adminId, tenantId, 'extended', reason, async (tx, before) => {
      const base = Math.max(before.paidUntil.getTime(), Date.now());
      await tx.tenant.update({ where: { id: tenantId }, data: { paidUntil: new Date(base + days * 86_400_000) } });
    });
  }

  /** R4 : suspendre avec un motif ; la tâche quotidienne ne lève pas cette suspension. */
  async suspend(adminId: string, tenantId: string, reason: string) {
    return this.change(adminId, tenantId, 'suspended', reason, async (tx, before) => {
      if (before.manuallySuspended) throw conflict('ALREADY_SUSPENDED', 'Le compte est déjà suspendu.');
      await tx.tenant.update({ where: { id: tenantId }, data: { manuallySuspended: true } });
    });
  }

  /** R4 : réactiver ; l'état suit ensuite l'échéance (une échéance dépassée se prolonge ou se paie). */
  async reactivate(adminId: string, tenantId: string, reason: string) {
    return this.change(adminId, tenantId, 'reactivated', reason, async (tx, before) => {
      if (!before.manuallySuspended && before.accountState !== 'suspended') throw conflict('NOT_SUSPENDED', "Le compte n'est pas suspendu.");
      await tx.tenant.update({ where: { id: tenantId }, data: { manuallySuspended: false } });
    });
  }

  /**
   * Spec 041, R4 : fermer un compte à la demande du client. Plus personne ne s'y connecte, les QR sont indisponibles ;
   * il sera effacé à la fin du délai (7 jours par défaut).
   */
  async close(adminId: string, tenantId: string, dto: CloseTenantDto) {
    const tenant = await this.prisma.tenant.findUnique({ where: { id: tenantId }, select: { name: true, closedAt: true, erasedAt: true } });
    if (!tenant) throw notFound('TENANT_NOT_FOUND', 'Compte introuvable.');
    if (tenant.closedAt || tenant.erasedAt) throw conflict('ALREADY_CLOSED', 'Ce compte est déjà fermé.');
    if (dto.confirmName.trim().toLowerCase() !== tenant.name.trim().toLowerCase()) {
      throw unprocessable('CONFIRM_NAME_MISMATCH', 'Recopiez exactement le nom du compte pour confirmer.');
    }
    const days = dto.days ?? ERASE_DELAY_DEFAULT_DAYS;
    return this.change(adminId, tenantId, 'closed', dto.reason, async (tx) => {
      const now = new Date();
      await tx.tenant.update({
        where: { id: tenantId },
        data: { status: 'suspended', closedAt: now, closeReason: dto.reason, deleteAfter: new Date(now.getTime() + days * 86_400_000) },
      });
      await tx.refreshSession.updateMany({ where: { user: { tenantId }, revokedAt: null }, data: { revokedAt: now } });
    });
  }

  /** Spec 041, R5 : rétablir un compte fermé, avant son effacement. */
  async restore(adminId: string, tenantId: string, reason: string) {
    const tenant = await this.prisma.tenant.findUnique({ where: { id: tenantId }, select: { closedAt: true, erasedAt: true } });
    if (!tenant) throw notFound('TENANT_NOT_FOUND', 'Compte introuvable.');
    if (tenant.erasedAt) throw conflict('ALREADY_ERASED', 'Ce compte est déjà effacé.');
    if (!tenant.closedAt) throw conflict('NOT_CLOSED', "Ce compte n'est pas fermé.");
    return this.change(adminId, tenantId, 'restored', reason, async (tx) => {
      await tx.tenant.update({ where: { id: tenantId }, data: { status: 'active', closedAt: null, closeReason: null, deleteAfter: null } });
    });
  }

  /**
   * R5 : lien de réinitialisation du mot de passe du propriétaire — à usage unique, 24 heures, affiché une seule fois.
   * Le jeton n'est conservé qu'haché.
   */
  async resetLink(adminId: string, tenantId: string, userId: string) {
    const owner = await this.prisma.user.findFirst({
      where: { id: userId, tenantId, memberships: { some: { role: { key: 'owner', tenantId: null } } } },
      select: { id: true, email: true },
    });
    if (!owner) throw notFound('OWNER_NOT_FOUND', 'Propriétaire introuvable.');
    const token = randomToken(32);
    const expiresAt = new Date(Date.now() + RESET_HOURS * 3_600_000);
    await this.prisma.$transaction(async (tx) => {
      await tx.passwordResetToken.updateMany({ where: { userId: owner.id, usedAt: null }, data: { usedAt: new Date() } });
      await tx.passwordResetToken.create({ data: { userId: owner.id, tokenHash: hashToken(token), expiresAt, createdById: adminId } });
      await this.log(tx, adminId, tenantId, 'reset_link_created', undefined, null, { userId: owner.id });
    });
    return { url: `${this.env.publicWebUrl}/reinitialiser?jeton=${token}`, expiresAt: expiresAt.toISOString(), email: owner.email };
  }

  /** Spec 037, R1 à R4 : un paiement prolonge l'échéance et crée un reçu numéroté sans trou. */
  async recordPayment(adminId: string, tenantId: string, dto: RecordPaymentDto) {
    const payment = await this.prisma.$transaction(async (tx) => {
      const [tenant] = await tx.$queryRaw<{ paidUntil: Date; plan: PlanKey; accountState: string }[]>`
        SELECT "paidUntil", plan::text AS plan, "accountState"::text AS "accountState" FROM "Tenant" WHERE id = ${tenantId}::uuid FOR UPDATE`;
      if (!tenant) throw notFound('TENANT_NOT_FOUND', 'Compte introuvable.');
      const now = new Date();
      const start = tenant.paidUntil > now ? tenant.paidUntil : now;
      const end = addMonths(start, dto.months);
      const year = now.getUTCFullYear();
      // R4 : numéro réservé dans la même transaction ; la ligne verrouillée sérialise les paiements simultanés.
      const [counter] = await tx.$queryRaw<{ last: number }[]>`
        INSERT INTO "ReceiptCounter" ("year", "last") VALUES (${year}, 1)
        ON CONFLICT ("year") DO UPDATE SET "last" = "ReceiptCounter"."last" + 1
        RETURNING "last"`;
      const created = await tx.subscriptionPayment.create({
        data: {
          tenantId,
          number: `${year}-${String(counter.last).padStart(4, '0')}`,
          amountMinor: dto.amountMinor,
          method: dto.method,
          reference: dto.reference || null,
          months: dto.months,
          plan: dto.plan,
          periodStart: start,
          periodEnd: end,
          previousPaidUntil: tenant.paidUntil,
          createdById: adminId,
        },
        include: { tenant: { select: { name: true } } },
      });
      // R2 et R3 : nouvelle échéance, formule payée, compte actif (une suspension de l'éditeur est levée par le paiement).
      await tx.tenant.update({ where: { id: tenantId }, data: { paidUntil: end, plan: dto.plan, manuallySuspended: false } });
      await this.subscriptions.refreshState(tx, tenantId, now, 'payment');
      await this.log(tx, adminId, tenantId, 'payment_recorded', undefined, { paidUntil: tenant.paidUntil, plan: tenant.plan }, {
        number: created.number, amountMinor: created.amountMinor, method: created.method, months: created.months, paidUntil: end, plan: dto.plan,
      });
      return created;
    });
    return toReceiptView(payment);
  }

  /** Spec 037, R5 : annuler un paiement saisi par erreur ; le reçu garde son numéro, l'échéance est recalculée. */
  async cancelPayment(adminId: string, paymentId: string, reason: string) {
    const payment = await this.prisma.$transaction(async (tx) => {
      const current = await tx.subscriptionPayment.findUnique({ where: { id: paymentId } });
      if (!current) throw notFound('PAYMENT_NOT_FOUND', 'Paiement introuvable.');
      if (current.cancelledAt) throw conflict('ALREADY_CANCELLED', 'Ce paiement est déjà annulé.');
      const [tenant] = await tx.$queryRaw<{ paidUntil: Date }[]>`SELECT "paidUntil" FROM "Tenant" WHERE id = ${current.tenantId}::uuid FOR UPDATE`;
      const later = await tx.subscriptionPayment.count({ where: { tenantId: current.tenantId, cancelledAt: null, createdAt: { gt: current.createdAt } } });
      // Dernier paiement : l'échéance revient à sa valeur d'avant ; sinon, on retire la durée payée.
      const paidUntil = later === 0 ? current.previousPaidUntil : addMonths(tenant.paidUntil, -current.months);
      const cancelled = await tx.subscriptionPayment.update({
        where: { id: paymentId },
        data: { cancelledAt: new Date(), cancelReason: reason },
        include: { tenant: { select: { name: true } } },
      });
      await tx.tenant.update({ where: { id: current.tenantId }, data: { paidUntil } });
      await this.subscriptions.refreshState(tx, current.tenantId, new Date(), 'payment_cancelled');
      await this.log(tx, adminId, current.tenantId, 'payment_cancelled', reason, { paidUntil: tenant.paidUntil }, { number: current.number, paidUntil });
      return cancelled;
    });
    return toReceiptView(payment);
  }

  private async change(
    adminId: string,
    tenantId: string,
    action: string,
    reason: string | undefined,
    work: (tx: Tx, before: { plan: PlanKey; paidUntil: Date; accountState: string; manuallySuspended: boolean }) => Promise<void>,
  ) {
    await this.prisma.$transaction(async (tx) => {
      const before = await tx.tenant.findUnique({ where: { id: tenantId }, select: { plan: true, paidUntil: true, accountState: true, manuallySuspended: true } });
      if (!before) throw notFound('TENANT_NOT_FOUND', 'Compte introuvable.');
      await work(tx, before);
      const state = await this.subscriptions.refreshState(tx, tenantId, new Date(), `platform.${action}`);
      const after = await tx.tenant.findUniqueOrThrow({ where: { id: tenantId }, select: { plan: true, paidUntil: true, manuallySuspended: true } });
      await this.log(tx, adminId, tenantId, action, reason, before, { ...after, accountState: state });
    });
    return this.getTenant(tenantId);
  }

  /**
   * R6 : journal plateforme (auteur, compte, action, motif, avant, après), et journal du compte client,
   * sans le nom de l'administrateur.
   */
  private async log(tx: Tx, adminId: string, tenantId: string, action: string, reason: string | undefined, before: unknown, after: unknown) {
    const json = (value: unknown) => (value === null || value === undefined ? Prisma.DbNull : (JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue));
    await tx.platformAuditLog.create({ data: { adminId, tenantId, action: `platform.${action}`, reason: reason ?? null, before: json(before), after: json(after) } });
    await this.audit.record(
      { action: `platform.${action}`, tenantId, entityType: 'Tenant', entityId: tenantId, metadata: { reason: reason ?? null } },
      tx,
    );
  }
}

// ------------------------------------------------------------ contrôleurs

@ApiTags('Plateforme')
@Public()
@Controller({ path: 'platform', version: '1' })
export class PlatformAuthController {
  constructor(
    private readonly platform: PlatformService,
    @Inject(APP_ENV) private readonly env: AppEnv,
  ) {}

  @Post('auth/login')
  @HttpCode(200)
  @Throttle(rateLimit(10, 900_000))
  @ApiOperation({ summary: 'Spec 036 : connexion à la console (cookie HttpOnly, 8 heures)' })
  async login(@Body() dto: PlatformLoginDto, @Res({ passthrough: true }) reply: FastifyReply) {
    const { token, expiresAt, admin } = await this.platform.login(dto);
    void reply.setCookie(PLATFORM_COOKIE, token, { httpOnly: true, secure: this.env.cookieSecure, sameSite: 'strict', path: COOKIE_PATH, expires: expiresAt });
    return { admin, expiresAt: expiresAt.toISOString() };
  }

  @Post('auth/logout')
  @HttpCode(204)
  async logout(@Req() req: FastifyRequest, @Res({ passthrough: true }) reply: FastifyReply) {
    await this.platform.logout((req.cookies as Record<string, string | undefined>)[PLATFORM_COOKIE]);
    void reply.clearCookie(PLATFORM_COOKIE, { path: COOKIE_PATH });
  }
}

@ApiTags('Plateforme')
@Public()
@UseGuards(PlatformGuard)
@Controller({ path: 'platform', version: '1' })
export class PlatformController {
  constructor(private readonly platform: PlatformService) {}

  @Get('me')
  me(@Req() req: FastifyRequest) {
    return adminOf(req);
  }

  @Get('tenants')
  @ApiOperation({ summary: 'Spec 036, P1 : comptes clients, état et activité' })
  list(@Query() query: ListTenantsQuery) {
    return this.platform.listTenants(query);
  }

  @Get('tenants/:id')
  get(@Param('id', ParseUUIDPipe) id: string) {
    return this.platform.getTenant(id);
  }

  @Post('tenants/:id/plan')
  @HttpCode(200)
  changePlan(@Req() req: FastifyRequest, @Param('id', ParseUUIDPipe) id: string, @Body() dto: ChangePlanDto) {
    return this.platform.changePlan(adminOf(req).id, id, dto.plan);
  }

  @Post('tenants/:id/extend')
  @HttpCode(200)
  extend(@Req() req: FastifyRequest, @Param('id', ParseUUIDPipe) id: string, @Body() dto: ExtendDto) {
    return this.platform.extend(adminOf(req).id, id, dto.days, dto.reason);
  }

  @Post('tenants/:id/suspend')
  @HttpCode(200)
  suspend(@Req() req: FastifyRequest, @Param('id', ParseUUIDPipe) id: string, @Body() dto: ReasonDto) {
    return this.platform.suspend(adminOf(req).id, id, dto.reason);
  }

  @Post('tenants/:id/reactivate')
  @HttpCode(200)
  reactivate(@Req() req: FastifyRequest, @Param('id', ParseUUIDPipe) id: string, @Body() dto: ReasonDto) {
    return this.platform.reactivate(adminOf(req).id, id, dto.reason);
  }

  @Post('tenants/:id/close')
  @HttpCode(200)
  @ApiOperation({ summary: 'Spec 041, R4 : fermer un compte, effacé à la fin du délai' })
  close(@Req() req: FastifyRequest, @Param('id', ParseUUIDPipe) id: string, @Body() dto: CloseTenantDto) {
    return this.platform.close(adminOf(req).id, id, dto);
  }

  @Post('tenants/:id/restore')
  @HttpCode(200)
  @ApiOperation({ summary: 'Spec 041, R5 : rétablir un compte fermé' })
  restore(@Req() req: FastifyRequest, @Param('id', ParseUUIDPipe) id: string, @Body() dto: ReasonDto) {
    return this.platform.restore(adminOf(req).id, id, dto.reason);
  }

  @Post('tenants/:id/owners/:userId/reset-link')
  @HttpCode(200)
  @ApiOperation({ summary: 'Spec 036, R5 : lien de réinitialisation du mot de passe, affiché une seule fois' })
  resetLink(@Req() req: FastifyRequest, @Param('id', ParseUUIDPipe) id: string, @Param('userId', ParseUUIDPipe) userId: string) {
    return this.platform.resetLink(adminOf(req).id, id, userId);
  }

  @Post('tenants/:id/payments')
  @HttpCode(201)
  @ApiOperation({ summary: 'Spec 037 : enregistrer un paiement d’abonnement' })
  recordPayment(@Req() req: FastifyRequest, @Param('id', ParseUUIDPipe) id: string, @Body() dto: RecordPaymentDto) {
    return this.platform.recordPayment(adminOf(req).id, id, dto);
  }

  @Post('payments/:id/cancel')
  @HttpCode(200)
  @ApiOperation({ summary: 'Spec 037, R5 : annuler un paiement saisi par erreur' })
  cancelPayment(@Req() req: FastifyRequest, @Param('id', ParseUUIDPipe) id: string, @Body() dto: ReasonDto) {
    return this.platform.cancelPayment(adminOf(req).id, id, dto.reason);
  }
}

@Module({
  imports: [SubscriptionModule],
  controllers: [PlatformAuthController, PlatformController],
  providers: [PlatformService, PlatformGuard],
})
export class PlatformModule {}

export { createPlatformAdmin, PLATFORM_PASSWORD_MIN } from './platform-admin';
