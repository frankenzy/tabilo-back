import { drawPrize, drawThreshold, giftState, isAvailable, stockMonth } from './loyalty-draw';

/** Spec 046 — tirage côté serveur : seuil et lot. */
describe('Spec 046 — tirage', () => {
  it('CA-046-03 — le seuil tiré reste entre le minimum et le maximum', () => {
    const seen = new Set<number>();
    for (let index = 0; index < 2_000; index += 1) {
      const value = drawThreshold(2, 5);
      expect(value).toBeGreaterThanOrEqual(2);
      expect(value).toBeLessThanOrEqual(5);
      seen.add(value);
    }
    expect([...seen].sort()).toEqual([2, 3, 4, 5]);
    expect(drawThreshold(3, 3)).toBe(3);
  });

  it('CA-046-04 — un lot épuisé ce mois n’est jamais tiré', () => {
    const prizes = [
      { id: 'coca', weight: 90, monthlyStock: 5, drawnThisMonth: 5 },
      { id: 'bonbons', weight: 10, monthlyStock: null, drawnThisMonth: 0 },
    ];
    expect(isAvailable(prizes[0])).toBe(false);
    for (let index = 0; index < 500; index += 1) expect(drawPrize(prizes)?.id).toBe('bonbons');
    expect(drawPrize([{ id: 'x', weight: 10, monthlyStock: 1, drawnThisMonth: 1 }])).toBeNull();
  });

  it('CA-046-04 — le tirage suit les chances (50 / 40 / 10)', () => {
    const prizes = [
      { id: 'coca', weight: 50, monthlyStock: null, drawnThisMonth: 0 },
      { id: 'bonbons', weight: 40, monthlyStock: null, drawnThisMonth: 0 },
      { id: 'poulet', weight: 10, monthlyStock: null, drawnThisMonth: 0 },
    ];
    const counts: Record<string, number> = { coca: 0, bonbons: 0, poulet: 0 };
    const draws = 20_000;
    for (let index = 0; index < draws; index += 1) counts[drawPrize(prizes)!.id] += 1;
    expect(counts.coca / draws).toBeCloseTo(0.5, 1);
    expect(counts.bonbons / draws).toBeCloseTo(0.4, 1);
    expect(counts.poulet / draws).toBeCloseTo(0.1, 1);
  });

  it('CA-046-04 — tirage déterministe aux bornes du ticket', () => {
    const prizes = [
      { id: 'a', weight: 3, monthlyStock: null, drawnThisMonth: 0 },
      { id: 'b', weight: 7, monthlyStock: null, drawnThisMonth: 0 },
    ];
    expect(drawPrize(prizes, () => 1)?.id).toBe('a');
    expect(drawPrize(prizes, () => 3)?.id).toBe('a');
    expect(drawPrize(prizes, () => 4)?.id).toBe('b');
    expect(drawPrize(prizes, () => 10)?.id).toBe('b');
  });

  it('CA-046-10 — états d’un cadeau, expiré sauf s’il est déjà demandé', () => {
    const now = new Date('2026-12-01T12:00:00Z');
    const base = { revealedAt: null, requestedAt: null, usedAt: null, expiresAt: new Date('2026-12-10T00:00:00Z') };
    expect(giftState(base, now)).toBe('wrapped');
    expect(giftState({ ...base, revealedAt: now }, now)).toBe('won');
    expect(giftState({ ...base, revealedAt: now, expiresAt: new Date('2026-11-30T00:00:00Z') }, now)).toBe('expired');
    expect(giftState({ ...base, requestedAt: now, expiresAt: new Date('2026-11-30T00:00:00Z') }, now)).toBe('requested');
    expect(giftState({ ...base, requestedAt: now, usedAt: now }, now)).toBe('used');
    expect(stockMonth(now)).toBe('2026-12');
  });
});
