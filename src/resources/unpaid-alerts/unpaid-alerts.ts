import { Body, Controller, Get, HttpCode, Injectable, Module, Param, ParseUUIDPipe, Post } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiProperty, ApiTags } from '@nestjs/swagger';
import { UnpaidAlertReason, UnpaidAlertResolution } from '@prisma/client';
import { IsIn } from 'class-validator';
import { CurrentScope, RequirePermissions } from '../../commons/decorators';
import { PrismaService, Tx } from '../../commons/prisma/prisma.service';
import { AuditService } from '../../commons/services/audit.service';
import type { Scope } from '../../commons/types';
import { conflict, notFound } from '../../commons/utils/errors';
import { OutboxService } from '../outbox/outbox.service';
import { closeBillRequests } from '../service-requests/bill';
import { ServiceRequestsModule } from '../service-requests/service-requests.module';
import { ServiceRequestsService, staffActor } from '../service-requests/service-requests.service';

const RESOLUTIONS = ['paid', 'still_here', 'walked_out'] as const satisfies readonly UnpaidAlertResolution[];

export class ResolveUnpaidAlertDto {
  @ApiProperty({ enum: RESOLUTIONS, description: '« Réglé », « Client encore là » ou « Parti sans payer »' })
  @IsIn([...RESOLUTIONS])
  resolution: UnpaidAlertResolution;
}

/** Spec 027, R9 : alerte telle que la voit le tableau de bord. */
export interface UnpaidAlertView {
  id: string;
  table: { id: string; label: string };
  sessionId: string;
  marker: number;
  amountMinor: number;
  reason: UnpaidAlertReason;
  createdAt: string;
  /** Dernière activité de la session : « non réglés depuis 20 min ». */
  lastActivityAt: string;
}

/** Montant servi, non réglé et non marqué impayé d'une session. */
async function dueAmount(tx: Tx, sessionId: string): Promise<number> {
  const due = await tx.serviceRequest.aggregate({
    where: { sessionId, status: 'resolved', totalMinor: { not: null }, paidAt: null, writtenOffAt: null },
    _sum: { totalMinor: true },
  });
  return due._sum.totalMinor ?? 0;
}

/**
 * Spec 027, R9 : crée une alerte pour chaque session qui a encore à régler, s'il n'y en a pas déjà une ouverte.
 * Appelée dans la transaction métier : libération de la table, expiration, balayage d'inactivité.
 */
export async function raiseUnpaidAlerts(tx: Tx, outbox: OutboxService, sessionIds: string[], reason: UnpaidAlertReason): Promise<number> {
  let raised = 0;
  for (const sessionId of sessionIds) {
    const amountMinor = await dueAmount(tx, sessionId);
    if (amountMinor === 0) continue;
    const session = await tx.tableSession.findUnique({
      where: { id: sessionId },
      select: { tenantId: true, establishmentId: true, tableId: true },
    });
    if (!session) continue;
    // Index partiel unique « une alerte ouverte par session » : un doublon concurrent est ignoré.
    const inserted = await tx.$queryRaw<{ id: string }[]>`
      INSERT INTO "UnpaidAlert" (id, "tenantId", "establishmentId", "tableId", "sessionId", "amountMinor", reason)
      VALUES (gen_random_uuid(), ${session.tenantId}::uuid, ${session.establishmentId}::uuid, ${session.tableId}::uuid,
              ${sessionId}::uuid, ${amountMinor}, ${reason}::"UnpaidAlertReason")
      ON CONFLICT ("sessionId") WHERE "resolvedAt" IS NULL DO NOTHING
      RETURNING id`;
    if (inserted.length === 0) continue;
    await outbox.add(tx, session, 'alert.changed', { alertId: inserted[0].id });
    raised += 1;
  }
  return raised;
}

@Injectable()
export class UnpaidAlertsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly outbox: OutboxService,
    private readonly requests: ServiceRequestsService,
    private readonly audit: AuditService,
  ) {}

  async list(scope: Scope): Promise<UnpaidAlertView[]> {
    const alerts = await this.prisma.unpaidAlert.findMany({
      where: { tenantId: scope.tenantId, establishmentId: scope.establishmentId, resolvedAt: null },
      orderBy: { createdAt: 'asc' },
      include: { session: { select: { markerIndex: true, lastActivityAt: true, table: { select: { id: true, label: true } } } } },
    });
    return alerts.map((alert) => ({
      id: alert.id,
      table: alert.session.table,
      sessionId: alert.sessionId,
      marker: alert.session.markerIndex,
      amountMinor: alert.amountMinor,
      reason: alert.reason,
      createdAt: alert.createdAt.toISOString(),
      lastActivityAt: alert.session.lastActivityAt.toISOString(),
    }));
  }

  /** Spec 027, R9 : « Réglé », « Client encore là » ou « Parti sans payer ». Une seule personne traite l'alerte. */
  async resolve(scope: Scope, alertId: string, resolution: UnpaidAlertResolution): Promise<{ resolution: UnpaidAlertResolution }> {
    await this.prisma.$transaction(async (tx) => {
      const alert = await tx.unpaidAlert.findFirst({
        where: { id: alertId, tenantId: scope.tenantId, establishmentId: scope.establishmentId },
        include: { establishment: { select: { unpaidAlertMinutes: true } } },
      });
      if (!alert) throw notFound('ALERT_NOT_FOUND', 'Alerte introuvable.');
      const now = new Date();
      const claimed = await tx.unpaidAlert.updateMany({
        where: { id: alert.id, resolvedAt: null },
        data: { resolvedAt: now, resolution, resolvedById: scope.userId },
      });
      if (claimed.count !== 1) throw conflict('ALERT_RESOLVED', 'Cette alerte a déjà été traitée.');

      if (resolution === 'paid') {
        await this.requests.settleSessionTx(tx, alert.sessionId, staffActor(scope));
      } else if (resolution === 'still_here') {
        // L'alerte ne revient qu'après un nouveau délai sans activité.
        await tx.tableSession.update({
          where: { id: alert.sessionId },
          data: { alertSnoozedUntil: new Date(now.getTime() + alert.establishment.unpaidAlertMinutes * 60_000) },
        });
      } else {
        await this.writeOff(tx, scope, alert.sessionId, now);
      }
      await this.audit.record(
        {
          action: 'unpaid_alert.resolved',
          tenantId: scope.tenantId,
          establishmentId: scope.establishmentId,
          actorId: scope.userId,
          entityType: 'UnpaidAlert',
          entityId: alert.id,
          metadata: { resolution, amountMinor: alert.amountMinor },
          ip: scope.ip,
        },
        tx,
      );
      await this.outbox.add(tx, alert, 'alert.changed', { alertId: alert.id, actorId: scope.userId });
    });
    this.outbox.kick();
    return { resolution };
  }

  /** « Parti sans payer » : les commandes servies non réglées de la session sortent du reste à encaisser. */
  private async writeOff(tx: Tx, scope: Scope, sessionId: string, now: Date): Promise<void> {
    const due = await tx.serviceRequest.findMany({
      where: { sessionId, status: 'resolved', totalMinor: { not: null }, paidAt: null, writtenOffAt: null },
    });
    for (const request of due) {
      const updated = await tx.serviceRequest.updateMany({
        where: { id: request.id, paidAt: null, writtenOffAt: null },
        data: { writtenOffAt: now, writtenOffById: scope.userId, version: { increment: 1 } },
      });
      if (updated.count !== 1) continue;
      await tx.serviceRequestEvent.create({
        data: {
          tenantId: request.tenantId,
          establishmentId: request.establishmentId,
          requestId: request.id,
          type: 'request.written_off',
          actorType: 'staff',
          actorId: scope.userId,
          payload: { amountMinor: request.totalMinor },
        },
      });
      await this.outbox.add(tx, request, 'request.written_off', { requestId: request.id, actorId: scope.userId });
    }
    // Spec 028, R6 : « Parti sans payer » clôt la demande d'addition, s'il y en avait une.
    await closeBillRequests(tx, this.outbox, [sessionId], 'walked_out', { type: 'staff', id: scope.userId });
    await this.requests.endSessionIfDone(tx, sessionId);
  }

  /**
   * Spec 027, R9 : sessions ouvertes avec une commande servie à régler et sans activité depuis le délai
   * de l'établissement (hors suspension « Client encore là ») → alerte « inactivity ». `now` sert aux tests.
   */
  async sweep(now = new Date()): Promise<number> {
    const candidates = await this.prisma.$queryRaw<{ id: string }[]>`
      SELECT s.id FROM "TableSession" s
      JOIN "Establishment" e ON e.id = s."establishmentId"
      WHERE s.status = 'open'
        AND s."lastActivityAt" <= ${now}::timestamptz - make_interval(mins => e."unpaidAlertMinutes")
        AND (s."alertSnoozedUntil" IS NULL OR s."alertSnoozedUntil" <= ${now}::timestamptz)
        AND NOT EXISTS (SELECT 1 FROM "UnpaidAlert" a WHERE a."sessionId" = s.id AND a."resolvedAt" IS NULL)
        AND EXISTS (
          SELECT 1 FROM "ServiceRequest" r
          WHERE r."sessionId" = s.id AND r.status = 'resolved' AND r."totalMinor" IS NOT NULL
            AND r."paidAt" IS NULL AND r."writtenOffAt" IS NULL)
      LIMIT 500`;
    if (candidates.length === 0) return 0;
    const raised = await this.prisma.$transaction((tx) => raiseUnpaidAlerts(tx, this.outbox, candidates.map((c) => c.id), 'inactivity'));
    if (raised > 0) this.outbox.kick();
    return raised;
  }
}

@ApiTags('Alertes de départ sans payer')
@ApiBearerAuth()
@Controller({ path: 'establishments/:establishmentId/unpaid-alerts', version: '1' })
export class UnpaidAlertsController {
  constructor(private readonly alerts: UnpaidAlertsService) {}

  @Get()
  @RequirePermissions('analytics.read')
  @ApiOperation({ summary: 'Alertes ouvertes de départ sans payer (spec 027)' })
  list(@CurrentScope() scope: Scope) {
    return this.alerts.list(scope);
  }

  @Post(':alertId/resolve')
  @HttpCode(200)
  @RequirePermissions('analytics.read')
  @ApiOperation({ summary: '« Réglé », « Client encore là » ou « Parti sans payer » (spec 027)' })
  resolve(@CurrentScope() scope: Scope, @Param('alertId', ParseUUIDPipe) alertId: string, @Body() dto: ResolveUnpaidAlertDto) {
    return this.alerts.resolve(scope, alertId, dto.resolution);
  }
}

@Module({
  imports: [ServiceRequestsModule],
  controllers: [UnpaidAlertsController],
  providers: [UnpaidAlertsService],
  exports: [UnpaidAlertsService],
})
export class UnpaidAlertsModule {}
