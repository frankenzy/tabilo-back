/**
 * Catalogue des permissions. Source de vérité unique, versionnée avec le code.
 * Les rôles (système ou personnalisés) référencent ces clés.
 */
export const PERMISSIONS = {
  'establishment.update': "Modifier les informations et réglages de l'établissement",
  'floor.read': 'Consulter les zones et les tables',
  'floor.manage': 'Créer, modifier et archiver les zones et les tables',
  'qr.manage': 'Générer, télécharger et révoquer les QR codes',
  'sessions.manage': 'Fermer les sessions de table',
  'request_types.manage': 'Configurer les types de demande',
  'menu.manage': 'Gérer la carte : rubriques, articles, prix et photos',
  'requests.read': "Consulter les demandes de l'établissement",
  'requests.create': 'Créer une demande pour une table',
  'requests.handle': 'Accepter, traiter et résoudre des demandes',
  'requests.assign': 'Affecter, réaffecter et transférer toute demande',
  'requests.cancel': 'Annuler une demande',
  'requests.supervise': 'Recevoir et acquitter les escalades',
  'staff.read': "Consulter l'équipe",
  'staff.manage': "Gérer les membres de l'équipe",
  'roles.manage': 'Créer et modifier les rôles personnalisés',
  'escalation.manage': "Configurer les règles d'escalade",
  'analytics.read': 'Consulter les indicateurs',
  'audit.read': "Consulter le journal d'audit",
} as const;

export type PermissionKey = keyof typeof PERMISSIONS;

export const ALL_PERMISSIONS = Object.keys(PERMISSIONS) as PermissionKey[];

export function isPermissionKey(value: string): value is PermissionKey {
  return Object.prototype.hasOwnProperty.call(PERMISSIONS, value);
}

/**
 * Spec 010, R1 : permissions effectives d'un employé = celles de son rôle, moins celles qu'on lui a retirées.
 * Un retrait ne peut jamais ajouter : le résultat est toujours inclus dans le rôle.
 */
export function effectivePermissions(rolePermissions: readonly string[], revoked: readonly string[] = []): PermissionKey[] {
  const removed = new Set(revoked);
  return rolePermissions.filter(isPermissionKey).filter((permission) => !removed.has(permission));
}

export interface SystemRoleDefinition {
  key: 'owner' | 'manager' | 'waiter';
  name: string;
  permissions: PermissionKey[];
}

/** Matrice des rôles système. Voir documentation/PERMISSIONS.md. */
export const SYSTEM_ROLES: SystemRoleDefinition[] = [
  { key: 'owner', name: 'Propriétaire', permissions: ALL_PERMISSIONS },
  {
    key: 'manager',
    name: 'Gérant',
    permissions: ALL_PERMISSIONS.filter((permission) => permission !== 'roles.manage'),
  },
  {
    key: 'waiter',
    name: 'Serveur',
    permissions: [
      'floor.read',
      'sessions.manage',
      'requests.read',
      'requests.create',
      'requests.handle',
      'staff.read',
    ],
  },
];
