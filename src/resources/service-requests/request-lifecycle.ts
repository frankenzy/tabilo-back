import type { RequestStatus } from '@prisma/client';

/**
 * Machine à états des demandes. Seule référence des transitions autorisées :
 * tout changement de statut passe par `assertTransition`, côté serveur.
 *
 *   awaiting_payment → in_progress (encaissée, spec 030) | cancelled
 *   pending     → assigned | cancelled
 *   assigned    → accepted | pending (libération justifiée)
 *   accepted    → in_progress | cancelled (selon permissions)
 *   in_progress → ready | resolved | assigned (transfert)
 *   ready       → resolved (spec 007 : commande prête, servie par n'importe quel membre)
 *   resolved, cancelled : terminaux
 *
 * L'escalade est un axe distinct (none → escalated → acknowledged) : une demande
 * peut être en cours de traitement et escaladée.
 */
export const TRANSITIONS: Readonly<Record<RequestStatus, readonly RequestStatus[]>> = {
  awaiting_payment: ['in_progress', 'cancelled'],
  pending: ['assigned', 'cancelled'],
  assigned: ['accepted', 'pending'],
  accepted: ['in_progress', 'cancelled'],
  in_progress: ['ready', 'resolved', 'assigned'],
  ready: ['resolved'],
  resolved: [],
  cancelled: [],
};

export const TERMINAL_STATUSES: readonly RequestStatus[] = ['resolved', 'cancelled'];
export const ACTIVE_STATUSES: readonly RequestStatus[] = ['awaiting_payment', 'pending', 'assigned', 'accepted', 'in_progress', 'ready'];

export function canTransition(from: RequestStatus, to: RequestStatus): boolean {
  return TRANSITIONS[from].includes(to);
}

export function isTerminal(status: RequestStatus): boolean {
  return TERMINAL_STATUSES.includes(status);
}

export class InvalidTransitionError extends Error {
  constructor(
    readonly from: RequestStatus,
    readonly to: RequestStatus,
  ) {
    super(`Transition interdite : ${from} → ${to}`);
  }
}

export function assertTransition(from: RequestStatus, to: RequestStatus): void {
  if (!canTransition(from, to)) throw new InvalidTransitionError(from, to);
}
