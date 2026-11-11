import { Prisma } from '@prisma/client';

/** Projection chargée pour toute vue d'une demande. */
export const REQUEST_INCLUDE = {
  table: { select: { id: true, label: true } },
  area: { select: { id: true, name: true } },
  requestType: { select: { id: true, label: true, icon: true } },
  assignee: { select: { id: true, firstName: true, lastName: true } },
} satisfies Prisma.ServiceRequestInclude;

export type RequestWithRelations = Prisma.ServiceRequestGetPayload<{ include: typeof REQUEST_INCLUDE }>;

/** Vue destinée au personnel. */
export interface RequestView {
  id: string;
  status: RequestWithRelations['status'];
  escalationStatus: RequestWithRelations['escalationStatus'];
  priority: RequestWithRelations['priority'];
  source: RequestWithRelations['source'];
  note: string | null;
  table: { id: string; label: string };
  area: { id: string; name: string };
  type: { id: string; label: string; icon: string };
  assignee: { id: string; firstName: string; lastName: string } | null;
  version: number;
  createdAt: string;
  dueAt: string;
  assignedAt: string | null;
  acceptedAt: string | null;
  startedAt: string | null;
  resolvedAt: string | null;
  cancelledAt: string | null;
  escalatedAt: string | null;
}

const iso = (date: Date | null): string | null => (date ? date.toISOString() : null);

export function toRequestView(request: RequestWithRelations): RequestView {
  return {
    id: request.id,
    status: request.status,
    escalationStatus: request.escalationStatus,
    priority: request.priority,
    source: request.source,
    note: request.note,
    table: request.table,
    area: request.area,
    type: request.requestType,
    assignee: request.assignee,
    version: request.version,
    createdAt: request.createdAt.toISOString(),
    dueAt: request.dueAt.toISOString(),
    assignedAt: iso(request.assignedAt),
    acceptedAt: iso(request.acceptedAt),
    startedAt: iso(request.startedAt),
    resolvedAt: iso(request.resolvedAt),
    cancelledAt: iso(request.cancelledAt),
    escalatedAt: iso(request.escalatedAt),
  };
}

/**
 * Vue destinée au client à table : le strict nécessaire au suivi.
 * Ni note (qui peut venir d'un autre téléphone), ni nom complet du personnel, ni données internes.
 */
export interface GuestRequestView {
  id: string;
  status: RequestWithRelations['status'];
  type: { id: string; label: string; icon: string };
  handledBy: string | null;
  createdAt: string;
  acceptedAt: string | null;
  startedAt: string | null;
  resolvedAt: string | null;
  cancelledAt: string | null;
}

export function toGuestRequestView(request: RequestWithRelations): GuestRequestView {
  const handled = request.status === 'accepted' || request.status === 'in_progress' || request.status === 'resolved';
  return {
    id: request.id,
    status: request.status,
    type: request.requestType,
    handledBy: handled && request.assignee ? request.assignee.firstName : null,
    createdAt: request.createdAt.toISOString(),
    acceptedAt: iso(request.acceptedAt),
    startedAt: iso(request.startedAt),
    resolvedAt: iso(request.resolvedAt),
    cancelledAt: iso(request.cancelledAt),
  };
}
