import { Controller, Get, Injectable, Module, Param, ParseUUIDPipe } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import type { AccountState, PaymentMethod, PlanKey, Prisma } from '@prisma/client';
import { FEATURE_LABELS, GRACE_DAYS, PLAN_ORDER, PLANS, TABILO_WHATSAPP } from '../../commons/constants/plans';
import { AllowSuspended, CurrentScope } from '../../commons/decorators';
import { PrismaService, Tx } from '../../commons/prisma/prisma.service';
import { AuditService } from '../../commons/services/audit.service';
import type { Scope } from '../../commons/types';
import { forbidden, notFound } from '../../commons/utils/errors';

const DAY_MS = 86_400_000;

/**
 * Spec 035, R1 : l'état d'un compte se déduit de son échéance.
 * Suspension décidée par l'éditeur (spec 036) > dans l'échéance (essai tant qu'aucun paiement) > grâce > suspendu.
 */
export function accountStateFor(paidUntil: Date, now: Date, hasPayment: boolean, manuallySuspended: boolean): AccountState {
  if (manuallySuspended) return 'suspended';
  if (now.getTime() <= paidUntil.getTime()) return hasPayment ? 'active' : 'trial';
  if (now.getTime() <= paidUntil.getTime() + GRACE_DAYS * DAY_MS) return 'past_due';
  return 'suspended';
}

/** Spec 037, R2 : ajoute des mois, sans déborder sur le mois suivant (31 janvier + 1 mois = 28 ou 29 février). */
export function addMonths(date: Date, months: number): Date {
  const result = new Date(date);
  const day = result.getUTCDate();
  result.setUTCDate(1);
  result.setUTCMonth(result.getUTCMonth() + months);
  const last = new Date(Date.UTC(result.getUTCFullYear(), result.getUTCMonth() + 1, 0)).getUTCDate();
  result.setUTCDate(Math.min(day, last));
  return result;
}

export interface ReceiptView {
  id: string;
  number: string;
  amountMinor: number;
  method: PaymentMethod;
  reference: string | null;
  months: number;
  plan: PlanKey;
  planName: string;
  periodStart: string;
  periodEnd: string;
  createdAt: string;
  cancelledAt: string | null;
  cancelReason: string | null;
  tenantName: string;
}

type PaymentRow = Prisma.SubscriptionPaymentGetPayload<{ include: { tenant: { select: { name: true } } } }>;

export function toReceiptView(payment: PaymentRow): ReceiptView {
  return {
    id: payment.id,
    number: payment.number,
    amountMinor: payment.amountMinor,
    method: payment.method,
    reference: payment.reference,
    months: payment.months,
    plan: payment.plan,
    planName: PLANS[payment.plan].name,
    periodStart: payment.periodStart.toISOString(),
    periodEnd: payment.periodEnd.toISOString(),
    createdAt: payment.createdAt.toISOString(),
    cancelledAt: payment.cancelledAt?.toISOString() ?? null,
    cancelReason: payment.cancelReason,
    tenantName: payment.tenant.name,
  };
}

@Injectable()
export class SubscriptionService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  /**
   * Recalcule et enregistre l'état d'un compte (spec 035, R4). Retourne le nouvel état.
   * Chaque changement d'état est inscrit au journal du compte.
   */
  async refreshState(tx: Tx, tenantId: string, now = new Date(), reason = 'schedule'): Promise<AccountState> {
    const tenant = await tx.tenant.findUniqueOrThrow({ where: { id: tenantId }, select: { accountState: true, paidUntil: true, manuallySuspended: true } });
    const paid = await tx.subscriptionPayment.count({ where: { tenantId, cancelledAt: null } });
    const next = accountStateFor(tenant.paidUntil, now, paid > 0, tenant.manuallySuspended);
    if (next !== tenant.accountState) {
      await tx.tenant.update({ where: { id: tenantId }, data: { accountState: next } });
      await this.audit.record(
        { action: 'subscription.state_changed', tenantId, entityType: 'Tenant', entityId: tenantId, metadata: { from: tenant.accountState, to: next, reason } },
        tx,
      );
    }
    return next;
  }

  /** Spec 035, R4 : passage automatique des comptes arrivés à échéance ; rejouable sans effet en double. */
  async sweep(now = new Date()): Promise<number> {
    const graceStart = new Date(now.getTime() - GRACE_DAYS * DAY_MS);
    const due = await this.prisma.tenant.findMany({
      where: {
        manuallySuspended: false,
        OR: [
          { accountState: { in: ['trial', 'active'] }, paidUntil: { lt: now } },
          { accountState: 'past_due', paidUntil: { lt: graceStart } },
        ],
      },
      select: { id: true },
      take: 500,
    });
    for (const tenant of due) await this.prisma.$transaction((tx) => this.refreshState(tx, tenant.id, now));
    return due.length;
  }

  /** Spec 034, R8 et spec 037, R6 : la page « Abonnement », réservée au propriétaire. */
  async overview(scope: Scope) {
    this.assertOwner(scope);
    const [tenant, establishments, tables, staff, payments] = await Promise.all([
      this.prisma.tenant.findUniqueOrThrow({ where: { id: scope.tenantId }, select: { name: true, plan: true, accountState: true, paidUntil: true } }),
      this.prisma.establishment.count({ where: { tenantId: scope.tenantId, archivedAt: null } }),
      this.prisma.diningTable.count({ where: { tenantId: scope.tenantId, establishmentId: scope.establishmentId, archivedAt: null } }),
      this.prisma.membership.count({ where: { tenantId: scope.tenantId, establishmentId: scope.establishmentId, user: { status: 'active' } } }),
      this.prisma.subscriptionPayment.findMany({ where: { tenantId: scope.tenantId }, orderBy: { createdAt: 'desc' }, include: { tenant: { select: { name: true } } } }),
    ]);
    const plan = PLANS[tenant.plan];
    return {
      plan: tenant.plan,
      planName: plan.name,
      state: tenant.accountState,
      paidUntil: tenant.paidUntil.toISOString(),
      graceUntil: new Date(tenant.paidUntil.getTime() + GRACE_DAYS * DAY_MS).toISOString(),
      contact: TABILO_WHATSAPP,
      usage: {
        establishments: { used: establishments, max: plan.limits.establishments },
        tables: { used: tables, max: plan.limits.tablesPerEstablishment },
        staff: { used: staff, max: plan.limits.staffPerEstablishment },
      },
      features: Object.entries(FEATURE_LABELS).map(([key, label]) => ({
        key,
        label,
        included: plan.features.includes(key as never),
        // La plus petite formule qui comprend le module (« Avec Pro »).
        availableIn: PLAN_ORDER.map((k) => PLANS[k]).find((p) => p.features.includes(key as never))?.name ?? null,
      })),
      catalog: PLAN_ORDER.map((key) => ({ ...PLANS[key], current: key === tenant.plan })),
      payments: payments.map(toReceiptView),
    };
  }

  /** Spec 037, R4 et R6 : un reçu du compte, imprimable. */
  async receipt(scope: Scope, id: string): Promise<ReceiptView> {
    this.assertOwner(scope);
    const payment = await this.prisma.subscriptionPayment.findFirst({ where: { id, tenantId: scope.tenantId }, include: { tenant: { select: { name: true } } } });
    if (!payment) throw notFound('RECEIPT_NOT_FOUND', 'Reçu introuvable.');
    return toReceiptView(payment);
  }

  private assertOwner(scope: Scope): void {
    if (scope.roleKey !== 'owner') throw forbidden('OWNER_ONLY', 'Seul le propriétaire consulte l’abonnement.');
  }
}

@ApiTags('Abonnement')
@ApiBearerAuth()
@Controller({ path: 'establishments/:establishmentId/subscription', version: '1' })
export class SubscriptionController {
  constructor(private readonly subscriptions: SubscriptionService) {}

  @Get()
  @AllowSuspended()
  @ApiOperation({ summary: 'Spec 034 et 037 : formule, consommation, échéance et paiements (propriétaire)' })
  overview(@CurrentScope() scope: Scope) {
    return this.subscriptions.overview(scope);
  }

  @Get('receipts/:id')
  @AllowSuspended()
  @ApiOperation({ summary: 'Spec 037 : un reçu de paiement (propriétaire)' })
  receipt(@CurrentScope() scope: Scope, @Param('id', ParseUUIDPipe) id: string) {
    return this.subscriptions.receipt(scope, id);
  }
}

@Module({ controllers: [SubscriptionController], providers: [SubscriptionService], exports: [SubscriptionService] })
export class SubscriptionModule {}
