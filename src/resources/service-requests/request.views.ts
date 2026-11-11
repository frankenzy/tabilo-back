import { Prisma } from '@prisma/client';

/** Projection chargée pour toute vue d'une demande. */
export const REQUEST_INCLUDE = {
  table: { select: { id: true, label: true } },
  area: { select: { id: true, name: true } },
  requestType: { select: { id: true, label: true, icon: true, kind: true } },
  assignee: { select: { id: true, firstName: true, lastName: true } },
  items: { select: { name: true, quantity: true, unitPriceMinor: true }, orderBy: { name: 'asc' } },
} satisfies Prisma.ServiceRequestInclude;

export type RequestWithRelations = Prisma.ServiceRequestGetPayload<{ include: typeof REQUEST_INCLUDE }>;

export interface OrderLineView {
  name: string;
  quantity: number;
  unitPriceMinor: number;
}

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
  type: { id: string; label: string; icon: string; kind: 'service' | 'order' };
  /** Lignes d'une commande (vide pour une demande de service). */
  items: OrderLineView[];
  /** Total d'une commande en unité mineure de la devise, sinon null. */
  totalMinor: number | null;
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
    items: request.items,
    totalMinor: request.totalMinor,
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
 * Le contenu d'une commande est visible de toute la table : c'est ce qui arrivera sur la table.
 */
export interface GuestRequestView {
  id: string;
  status: RequestWithRelations['status'];
  type: { id: string; label: string; icon: string; kind: 'service' | 'order' };
  items: OrderLineView[];
  totalMinor: number | null;
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
    items: request.items,
    totalMinor: request.totalMinor,
    handledBy: handled && request.assignee ? request.assignee.firstName : null,
    createdAt: request.createdAt.toISOString(),
    acceptedAt: iso(request.acceptedAt),
    startedAt: iso(request.startedAt),
    resolvedAt: iso(request.resolvedAt),
    cancelledAt: iso(request.cancelledAt),
  };
}
