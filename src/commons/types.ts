import type { FastifyRequest } from 'fastify';
import type { PermissionKey } from './constants/permissions';

/** Utilisateur identifié par son jeton d'accès. */
export interface AuthUser {
  id: string;
  tenantId: string;
}

/**
 * Périmètre d'une requête du personnel : toujours dérivé du serveur
 * (jeton + adhésion en base), jamais d'un identifiant fourni par le client.
 */
export interface Scope {
  userId: string;
  tenantId: string;
  establishmentId: string;
  roleKey: string;
  permissions: ReadonlySet<PermissionKey>;
  ip?: string;
}

/** Session de table authentifiée par son jeton opaque. */
export interface GuestSession {
  id: string;
  tenantId: string;
  establishmentId: string;
  tableId: string;
  /** Spec 027, R2 : repère de la session. */
  markerIndex: number;
}

export interface AppRequest extends FastifyRequest {
  user?: AuthUser;
  scope?: Scope;
  guest?: GuestSession;
}

export function can(scope: Scope, permission: PermissionKey): boolean {
  return scope.permissions.has(permission);
}
