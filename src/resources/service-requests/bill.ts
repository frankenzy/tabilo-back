import { Prisma } from '@prisma/client';
import type { Tx } from '../../commons/prisma/prisma.service';
import type { OutboxService } from '../outbox/outbox.service';
import { ACTIVE_STATUSES } from './request-lifecycle';

/** Spec 028, R6 : comment une demande d'addition s'est close. */
export type BillCloseReason = 'settled' | 'released' | 'expired' | 'walked_out';

/** Spec 028, R5 : ce que la carte « Demande d'addition » montre au personnel. */
export interface BillSummary {
  /** Commandes servies, non réglées et non marquées impayées de la session. */
  dueMinor: number;
  /** Commandes de la session pas encore servies, donc pas encore comptées. */
  pendingOrders: number;
}

type Reader = Pick<Tx, 'serviceRequest'>;

/** Montant dû et commandes en cours, par session. */
export async function billSummaries(db: Reader, sessionIds: string[]): Promise<Map<string, BillSummary>> {
  const summaries = new Map<string, BillSummary>(sessionIds.map((id) => [id, { dueMinor: 0, pendingOrders: 0 }]));
  if (sessionIds.length === 0) return summaries;
  const [due, pending] = await Promise.all([
    db.serviceRequest.groupBy({
      by: ['sessionId'],
      where: { sessionId: { in: sessionIds }, status: 'resolved', totalMinor: { not: null }, paidAt: null, writtenOffAt: null },
      _sum: { totalMinor: true },
    }),
    db.serviceRequest.groupBy({
      by: ['sessionId'],
      where: { sessionId: { in: sessionIds }, status: { in: [...ACTIVE_STATUSES] }, totalMinor: { not: null } },
      _count: { _all: true },
    }),
  ]);
  for (const row of due) if (row.sessionId) summaries.get(row.sessionId)!.dueMinor = row._sum.totalMinor ?? 0;
  for (const row of pending) if (row.sessionId) summaries.get(row.sessionId)!.pendingOrders = row._count._all;
  return summaries;
}

/**
 * Spec 028, R6 : clôt les demandes d'addition ouvertes des sessions, sans geste dédié.
 * Réglée → « résolue » ; libération, expiration, « Parti sans payer » → « annulée ». La raison va au journal.
 */
export async function closeBillRequests(
  tx: Tx,
  outbox: OutboxService,
  sessionIds: string[],
  reason: BillCloseReason,
  actor: { type: 'staff' | 'system'; id: string | null },
): Promise<void> {
  if (sessionIds.length === 0) return;
  const open = await tx.serviceRequest.findMany({
    where: { sessionId: { in: sessionIds }, status: { in: [...ACTIVE_STATUSES] }, requestType: { kind: 'bill' } },
  });
  const now = new Date();
  const to = reason === 'settled' ? 'resolved' : 'cancelled';
  for (const request of open) {
    const updated = await tx.serviceRequest.updateMany({
      where: { id: request.id, status: request.status, version: request.version },
      data: { status: to, ...(to === 'resolved' ? { resolvedAt: now } : { cancelledAt: now }), version: { increment: 1 } },
    });
    if (updated.count !== 1) continue;
    await tx.serviceAssignment.updateMany({ where: { requestId: request.id, endedAt: null }, data: { endedAt: now } });
    const eventType = to === 'resolved' ? 'request.resolved' : 'request.cancelled';
    await tx.serviceRequestEvent.create({
      data: {
        tenantId: request.tenantId,
        establishmentId: request.establishmentId,
        requestId: request.id,
        type: eventType,
        fromStatus: request.status,
        toStatus: to,
        actorType: actor.type,
        actorId: actor.id,
        payload: { billClosedBy: reason } satisfies Prisma.InputJsonObject,
      },
    });
    await outbox.add(tx, request, eventType, { requestId: request.id, actorId: actor.id });
  }
}
