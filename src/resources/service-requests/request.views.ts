import { Prisma, RequestTypeKind } from '@prisma/client';
import type { BillSummary } from './bill';

/** Projection chargée pour toute vue d'une demande. */
export const REQUEST_INCLUDE = {
  table: { select: { id: true, label: true } },
  area: { select: { id: true, name: true } },
  requestType: { select: { id: true, label: true, icon: true, kind: true, perSession: true } },
  // Spec 027, R2 : repère de la session qui a passé la demande.
  session: { select: { markerIndex: true } },
  assignee: { select: { id: true, firstName: true, lastName: true } },
  items: {
    select: {
      id: true, menuItemId: true, name: true, quantity: true, unitPriceMinor: true, choices: true, options: true, listPriceMinor: true,
      offer: { select: { createdAt: true } },
    },
    orderBy: { name: 'asc' },
  },
} satisfies Prisma.ServiceRequestInclude;

export type RequestWithRelations = Prisma.ServiceRequestGetPayload<{ include: typeof REQUEST_INCLUDE }>;

export interface OrderLineView {
  /** Spec 007 : retrouver la photo du plat dans la carte (écran « Commandes »). */
  menuItemId: string;
  name: string;
  quantity: number;
  unitPriceMinor: number;
  /** Spec 032, R5 : choix d'une formule, figés à la commande ; null pour un plat. */
  choices: Prisma.JsonValue | null;
  /** Spec 038, R5 : options choisies, figées ; null sans option. */
  options: Prisma.JsonValue | null;
  /** Spec 033 : identifiant de la ligne (pour l'offrir), prix de la carte si promotion, ligne offerte. */
  id: string;
  listPriceMinor: number | null;
  offeredAt: Date | null;
}

/** Vue destinée au personnel. */
export interface RequestView {
  id: string;
  status: RequestWithRelations['status'];
  escalationStatus: RequestWithRelations['escalationStatus'];
  priority: RequestWithRelations['priority'];
  source: RequestWithRelations['source'];
  note: string | null;
  /** Quantité demandée (ex. 2 bouteilles d'eau), sinon null. */
  quantity: number | null;
  table: { id: string; label: string };
  area: { id: string; name: string };
  type: { id: string; label: string; icon: string; kind: RequestTypeKind };
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
  readyAt: string | null;
  resolvedAt: string | null;
  cancelledAt: string | null;
  escalatedAt: string | null;
  /** Spec 026 : commande servie réglée ; null = à régler (ou pas encore servie). */
  paidAt: string | null;
  /** Spec 027, R2 : repère de la session du client ; null pour une demande créée par le personnel. */
  marker: number | null;
  /** Spec 027, R8 : signalement de zone ; null sans zone (ou demande de service). */
  zone: { status: 'inside' | 'outside' | 'imprecise' | 'denied'; distanceM: number | null } | null;
  /** Spec 027, R9 : marquée « Parti sans payer ». */
  writtenOffAt: string | null;
  /** Spec 028, R5 : demande d'addition — montant dû du client et commandes pas encore comptées ; null sinon. */
  bill: BillSummary | null;
}

const iso = (date: Date | null): string | null => (date ? date.toISOString() : null);

/** Spec 033 : une ligne offerte porte la date de son « Offert » (table à part, la ligne restant figée). */
function toLineView({ offer, ...line }: RequestWithRelations['items'][number]): OrderLineView {
  return { ...line, offeredAt: offer?.createdAt ?? null };
}

export function toRequestView(request: RequestWithRelations, bill?: BillSummary): RequestView {
  return {
    id: request.id,
    status: request.status,
    escalationStatus: request.escalationStatus,
    priority: request.priority,
    source: request.source,
    note: request.note,
    quantity: request.quantity,
    table: request.table,
    area: request.area,
    type: typeOf(request),
    items: request.items.map(toLineView),
    totalMinor: request.totalMinor,
    assignee: request.assignee,
    version: request.version,
    createdAt: request.createdAt.toISOString(),
    dueAt: request.dueAt.toISOString(),
    assignedAt: iso(request.assignedAt),
    acceptedAt: iso(request.acceptedAt),
    startedAt: iso(request.startedAt),
    readyAt: iso(request.readyAt),
    resolvedAt: iso(request.resolvedAt),
    cancelledAt: iso(request.cancelledAt),
    escalatedAt: iso(request.escalatedAt),
    paidAt: iso(request.paidAt),
    marker: request.session?.markerIndex ?? null,
    zone: request.zoneCheck ? { status: request.zoneCheck, distanceM: request.zoneDistanceM } : null,
    writtenOffAt: iso(request.writtenOffAt),
    bill: request.requestType.kind === 'bill' ? (bill ?? { dueMinor: 0, pendingOrders: 0 }) : null,
  };
}

/** Le type exposé : sans le réglage interne `perSession`. */
function typeOf(request: RequestWithRelations): RequestView['type'] {
  const { id, label, icon, kind } = request.requestType;
  return { id, label, icon, kind };
}

/**
 * Spec 027, R1 : un événement destiné au client ne va qu'au téléphone concerné pour une commande
 * ou une demande propre au client (« L'addition ») ; les autres demandes de service restent communes à la table.
 */
export function isPerSession(request: RequestWithRelations): boolean {
  // Spec 029 : l'appel reste commun à la table ; le message ne va qu'au téléphone qui l'a écrit.
  const shared = request.requestType.kind === 'service' || request.requestType.kind === 'call';
  return request.sessionId !== null && (!shared || request.requestType.perSession);
}

/**
 * Vue destinée au client à table : le strict nécessaire au suivi.
 * Ni note (qui peut venir d'un autre téléphone ; seul le message, propre à son auteur, rend la sienne), ni nom complet du personnel, ni données internes.
 * Spec 027, R1 : le client ne voit que les commandes de sa session ; les demandes de service communes restent visibles de la table.
 */
export interface GuestRequestView {
  id: string;
  status: RequestWithRelations['status'];
  type: { id: string; label: string; icon: string; kind: RequestTypeKind };
  items: OrderLineView[];
  totalMinor: number | null;
  quantity: number | null;
  handledBy: string | null;
  createdAt: string;
  acceptedAt: string | null;
  startedAt: string | null;
  resolvedAt: string | null;
  cancelledAt: string | null;
  /** Spec 026, R8 : commande réglée. */
  paidAt: string | null;
  /** Spec 029, R5 : le texte d'un message, rendu au seul téléphone qui l'a écrit. */
  note: string | null;
}

export function toGuestRequestView(request: RequestWithRelations): GuestRequestView {
  const handled = request.status === 'accepted' || request.status === 'in_progress' || request.status === 'ready' || request.status === 'resolved';
  return {
    id: request.id,
    // Spec 007, Q2 : le client reste sur « En préparation » jusqu'au service.
    status: request.status === 'ready' ? 'in_progress' : request.status,
    type: typeOf(request),
    items: request.items.map(toLineView),
    totalMinor: request.totalMinor,
    quantity: request.quantity,
    handledBy: handled && request.assignee ? request.assignee.firstName : null,
    createdAt: request.createdAt.toISOString(),
    acceptedAt: iso(request.acceptedAt),
    startedAt: iso(request.startedAt),
    resolvedAt: iso(request.resolvedAt),
    cancelledAt: iso(request.cancelledAt),
    paidAt: iso(request.paidAt),
    note: request.requestType.kind === 'message' ? request.note : null,
  };
}
