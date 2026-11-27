import { randomInt } from 'node:crypto';

/** Tire un entier dans [min, max] (bornes comprises). */
export type Rng = (min: number, max: number) => number;

/** Spec 046, exigence « Hasard » : générateur cryptographique du serveur. */
export const cryptoRng: Rng = (min, max) => randomInt(min, max + 1);

/** Spec 046, R4 et R5 : nombre de commandes jusqu'au prochain cadeau, entre le minimum et le maximum. */
export function drawThreshold(min: number, max: number, rng: Rng = cryptoRng): number {
  const low = Math.max(1, Math.min(min, max));
  const high = Math.max(low, max);
  return rng(low, high);
}

export interface DrawablePrize {
  id: string;
  weight: number;
  monthlyStock: number | null;
  /** Tirages du mois en cours. */
  drawnThisMonth: number;
}

/** Spec 046, R6 : un lot sans limite, ou dont le stock du mois n'est pas épuisé. */
export function isAvailable(prize: DrawablePrize): boolean {
  return prize.weight > 0 && (prize.monthlyStock === null || prize.drawnThisMonth < prize.monthlyStock);
}

/** Spec 046, R5 et R6 : tirage pondéré parmi les lots disponibles ; null si aucun ne l'est. */
export function drawPrize<T extends DrawablePrize>(prizes: T[], rng: Rng = cryptoRng): T | null {
  const available = prizes.filter(isAvailable);
  const total = available.reduce((sum, prize) => sum + prize.weight, 0);
  if (total === 0) return null;
  let ticket = rng(1, total);
  for (const prize of available) {
    ticket -= prize.weight;
    if (ticket <= 0) return prize;
  }
  return available[available.length - 1];
}

/** Mois de stock (« 2026-11 »), en temps universel, l'heure de l'Afrique de l'Ouest. */
export function stockMonth(date: Date): string {
  return date.toISOString().slice(0, 7);
}

export type GiftState = 'wrapped' | 'won' | 'requested' | 'used' | 'expired';

/** Spec 046, R11 et R12 : état d'un cadeau. Un cadeau demandé avant l'échéance reste valable. */
export function giftState(
  gift: { revealedAt: Date | null; requestedAt: Date | null; usedAt: Date | null; expiresAt: Date },
  now: Date,
): GiftState {
  if (gift.usedAt) return 'used';
  if (gift.requestedAt) return 'requested';
  if (gift.expiresAt <= now) return 'expired';
  return gift.revealedAt ? 'won' : 'wrapped';
}
