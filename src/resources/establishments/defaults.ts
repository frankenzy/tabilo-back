import type { Tx } from '../../commons/prisma/prisma.service';

const DEFAULT_REQUEST_TYPES = [
  { label: 'Appeler un serveur', icon: 'bell', slaSeconds: 180, priority: 'normal' as const },
  { label: "De l'eau", icon: 'droplet', slaSeconds: 180, priority: 'normal' as const },
  { label: "L'addition", icon: 'receipt', slaSeconds: 240, priority: 'normal' as const },
  { label: 'Assistance', icon: 'life-buoy', slaSeconds: 120, priority: 'high' as const },
  { label: 'Autre demande', icon: 'message-circle', slaSeconds: 240, priority: 'normal' as const },
];

/**
 * Réglages de départ d'un nouvel établissement : types de demande usuels, type « Commande »
 * (un seul par établissement, utilisé par la carte) et deux règles d'escalade. Tout est modifiable.
 */
export async function createEstablishmentDefaults(
  tx: Tx,
  scope: { tenantId: string; establishmentId: string },
): Promise<void> {
  await tx.requestType.createMany({
    data: [
      ...DEFAULT_REQUEST_TYPES.map((type, position) => ({ ...scope, ...type, position })),
      { ...scope, label: 'Commande', kind: 'order' as const, icon: 'utensils', slaSeconds: 300, position: 100 },
    ],
  });
  await tx.escalationRule.createMany({
    data: [
      { ...scope, name: 'Non prise en charge après 5 min', trigger: 'not_accepted', afterSeconds: 300 },
      { ...scope, name: 'Non résolue après 15 min', trigger: 'not_resolved', afterSeconds: 900 },
    ],
  });
}
