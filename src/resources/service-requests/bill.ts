import { Prisma, ServiceRequest } from '@prisma/client';
import type { Tx } from '../../commons/prisma/prisma.service';
import type { OutboxService } from '../outbox/outbox.service';
import { ACTIVE_STATUSES } from './request-lifecycle';

/** Statuts où une commande « Régler quand on veut » se règle déjà (spec 030, R4). */
const IN_SERVICE = ['pending', 'assigned', 'accepted', 'in_progress', 'ready'] as const;

/**
 * Spec 030 : une commande se règle si elle n'est ni réglée ni « Parti sans payer », et si elle est servie,
 * à encaisser (« Caisse d'abord »), ou en cours avec la façon de servir « Régler quand on veut ».
 * Seule définition du reste à régler : à combiner par `AND` (elle porte son propre `OR`).
 */
export const PAYABLE = {
  totalMinor: { not: null },
  paidAt: null,
  writtenOffAt: null,
  OR: [
    { status: { in: ['resolved', 'awaiting_payment'] } },
    { serviceMode: 'pay_anytime', status: { in: [...IN_SERVICE] } },
  ],
} satisfies Prisma.ServiceRequestWhereInput;

/** Même règle que `PAYABLE`, en SQL, pour une demande aliasée `r`. */
export const PAYABLE_SQL = Prisma.sql`(r."totalMinor" IS NOT NULL AND r."paidAt" IS NULL AND r."writtenOffAt" IS NULL
  AND (r.status IN ('resolved', 'awaiting_payment')
    OR (r."serviceMode" = 'pay_anytime' AND r.status IN ('pending', 'assigned', 'accepted', 'in_progress', 'ready'))))`;

/** Même règle que `PAYABLE`, sur une demande déjà chargée. */
export function isPayable(request: Pick<ServiceRequest, 'totalMinor' | 'paidAt' | 'writtenOffAt' | 'status' | 'serviceMode'>): boolean {
  if (request.totalMinor === null || request.paidAt || request.writtenOffAt) return false;
  if (request.status === 'resolved' || request.status === 'awaiting_payment') return true;
  return request.serviceMode === 'pay_anytime' && (IN_SERVICE as readonly string[]).includes(request.status);
}

/** Spec 028, R6 : comment une demande d'addition s'est close. */
export type BillCloseReason = 'settled' | 'released' | 'expired' | 'walked_out';

/** Spec 028, R5 : ce que la carte « Demande d'addition » montre au personnel. */
export interface BillSummary {
  /** Ce qui se règle dans la session (`PAYABLE`) : commandes servies non réglées, et en cours selon la façon de servir. */
  dueMinor: number;
  /** Commandes de la session en cours et pas encore comptées. */
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
      where: { sessionId: { in: sessionIds }, AND: [PAYABLE] },
      _sum: { totalMinor: true },
    }),
    db.serviceRequest.groupBy({
      by: ['sessionId'],
      where: { sessionId: { in: sessionIds }, status: { in: [...ACTIVE_STATUSES] }, totalMinor: { not: null }, NOT: PAYABLE },
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
