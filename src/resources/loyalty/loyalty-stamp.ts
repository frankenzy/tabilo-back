import type { Tx } from '../../commons/prisma/prisma.service';

/**
 * Spec 043, R3 et R5 : au règlement, la visite (session) d'une carte reçoit un tampon si une commande réglée
 * atteint le montant minimum. Un seul tampon par visite : l'index unique sur `sessionId` le garantit.
 */
export async function stampSession(tx: Tx, sessionId: string): Promise<boolean> {
  const session = await tx.tableSession.findUnique({ where: { id: sessionId }, select: { loyaltyCardId: true, establishmentId: true, tenantId: true } });
  if (!session?.loyaltyCardId) return false;
  const program = await tx.loyaltyProgram.findUnique({ where: { establishmentId: session.establishmentId } });
  if (!program?.isActive) return false;
  const qualifying = await tx.serviceRequest.count({
    where: { sessionId, paidAt: { not: null }, totalMinor: { gte: Math.max(program.minOrderMinor, 1) } },
  });
  if (qualifying === 0) return false;
  const created = await tx.loyaltyStamp.createMany({
    data: [{ tenantId: session.tenantId, establishmentId: session.establishmentId, cardId: session.loyaltyCardId, sessionId }],
    skipDuplicates: true,
  });
  if (created.count === 0) return false;
  await tx.loyaltyCard.update({ where: { id: session.loyaltyCardId }, data: { stamps: { increment: 1 } } });
  return true;
}
