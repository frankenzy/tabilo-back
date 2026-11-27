import type { Tx } from '../../commons/prisma/prisma.service';
import { drawPrize, drawThreshold, type DrawablePrize, stockMonth } from './loyalty-draw';

const DAY_MS = 86_400_000;

/**
 * Spec 043, R3 et R5 : au règlement, la visite (session) d'une carte reçoit un tampon si une commande réglée
 * atteint le montant minimum. Un seul tampon par visite : l'index unique sur `sessionId` le garantit.
 * Spec 046 : en mode Surprise, le tampon qui atteint le seuil tiré débloque un cadeau.
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
  const card = await tx.loyaltyCard.update({ where: { id: session.loyaltyCardId }, data: { stamps: { increment: 1 } } });
  if (program.mode === 'surprise') {
    await unlockGift(tx, { ...session, cardId: card.id, sessionId }, card, program);
  }
  return true;
}

interface SurpriseProgram {
  surpriseMin: number;
  surpriseMax: number;
  giftValidityDays: number;
}

/**
 * Spec 046, R4 à R6 : le seuil est tiré par le serveur au premier tampon du mode Surprise (les tampons en cours
 * comptent, Q10), puis à chaque déblocage. Le lot est tiré parmi les lots disponibles, selon leurs chances.
 */
async function unlockGift(
  tx: Tx,
  context: { tenantId: string; establishmentId: string; cardId: string; sessionId: string },
  card: { stamps: number; nextGiftAt: number | null },
  program: SurpriseProgram,
): Promise<void> {
  let nextGiftAt = card.nextGiftAt;
  if (nextGiftAt === null) {
    nextGiftAt = drawThreshold(program.surpriseMin, program.surpriseMax);
    await tx.loyaltyCard.update({ where: { id: context.cardId }, data: { nextGiftAt } });
  }
  if (card.stamps < nextGiftAt) return;

  const now = new Date();
  const month = stockMonth(now);
  const prizes = await tx.loyaltyPrize.findMany({
    where: { establishmentId: context.establishmentId, archivedAt: null },
    select: { id: true, weight: true, monthlyStock: true },
  });
  const counts = new Map(
    (await tx.loyaltyPrizeDraw.findMany({ where: { prizeId: { in: prizes.map((prize) => prize.id) }, month } })).map((row) => [row.prizeId, row.count]),
  );
  const pool: DrawablePrize[] = prizes.map((prize) => ({ ...prize, drawnThisMonth: counts.get(prize.id) ?? 0 }));

  // R6 : le stock baisse au tirage. Deux règlements simultanés ne dépassent pas le stock : on recompte après
  // l'incrément et, en cas de dépassement, on rend le tirage et on retire le lot.
  let prize = drawPrize(pool);
  while (prize) {
    const drawn = await tx.loyaltyPrizeDraw.upsert({
      where: { prizeId_month: { prizeId: prize.id, month } },
      create: { tenantId: context.tenantId, establishmentId: context.establishmentId, prizeId: prize.id, month, count: 1 },
      update: { count: { increment: 1 } },
    });
    if (prize.monthlyStock === null || drawn.count <= prize.monthlyStock) break;
    await tx.loyaltyPrizeDraw.update({ where: { id: drawn.id }, data: { count: { decrement: 1 } } });
    prize.drawnThisMonth = prize.monthlyStock;
    prize = drawPrize(pool);
  }

  if (!prize) {
    // R3 l'empêche (un lot sans limite est obligatoire) ; on le note sans bloquer le règlement.
    await tx.auditLog.create({ data: { action: 'loyalty.gift_unavailable', tenantId: context.tenantId, establishmentId: context.establishmentId, metadata: { cardId: context.cardId } } });
    return;
  }

  const gift = await tx.loyaltyGift.create({
    data: {
      tenantId: context.tenantId,
      establishmentId: context.establishmentId,
      cardId: context.cardId,
      prizeId: prize.id,
      unlockSessionId: context.sessionId,
      atStamp: card.stamps,
      unlockedAt: now,
      expiresAt: new Date(now.getTime() + program.giftValidityDays * DAY_MS),
    },
  });
  const threshold = drawThreshold(program.surpriseMin, program.surpriseMax);
  await tx.loyaltyCard.update({ where: { id: context.cardId }, data: { nextGiftAt: card.stamps + threshold } });
  // R13 : tirage du lot et du prochain seuil au journal.
  await tx.auditLog.create({
    data: {
      action: 'loyalty.gift_unlocked',
      tenantId: context.tenantId,
      establishmentId: context.establishmentId,
      entityType: 'LoyaltyGift',
      entityId: gift.id,
      metadata: { cardId: context.cardId, sessionId: context.sessionId, prizeId: prize.id, atStamp: card.stamps, nextGiftAt: card.stamps + threshold },
    },
  });
}
