import type { Tx } from '../../commons/prisma/prisma.service';

const DEFAULT_REQUEST_TYPES = [
  // Spec 029, R1 : l'appel et le message, les deux ronds du bouton « Serveur ».
  { label: 'Appeler un serveur', kind: 'call' as const, icon: 'bell', slaSeconds: 180, priority: 'normal' as const, allowNote: false },
  { label: "De l'eau", icon: 'droplet', slaSeconds: 180, priority: 'normal' as const },
  // Spec 027, R6 et spec 028, R1 : chaque client demande sa propre addition, demande à part.
  { label: "L'addition", kind: 'bill' as const, icon: 'receipt', slaSeconds: 240, priority: 'normal' as const, perSession: true, allowNote: false },
  { label: 'Assistance', icon: 'life-buoy', slaSeconds: 120, priority: 'high' as const },
  { label: 'Message', kind: 'message' as const, icon: 'message-circle', slaSeconds: 240, priority: 'normal' as const, perSession: true, allowNote: true },
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
