import { inSlots, slotsError } from './slots';

/** Spec 039 : créneaux au fuseau de l'établissement. */
describe('créneaux', () => {
  const tz = 'Africa/Abidjan'; // UTC+0
  const happy = [{ days: [1, 2, 3, 4, 5], start: '17:00', end: '19:00' }];

  it('CA-039-01 — mardi 18 h dans le créneau, 19 h 05 dehors, samedi dehors', () => {
    expect(inSlots(happy, new Date('2026-12-01T18:00:00Z'), tz)).toBe(true); // mardi
    expect(inSlots(happy, new Date('2026-12-01T19:05:00Z'), tz)).toBe(false);
    expect(inSlots(happy, new Date('2026-12-01T19:00:00Z'), tz)).toBe(false);
    expect(inSlots(happy, new Date('2026-12-05T18:00:00Z'), tz)).toBe(false); // samedi
  });

  it('CA-039-02 — un créneau qui passe minuit', () => {
    const night = [{ days: [5], start: '22:00', end: '02:00' }]; // vendredi
    expect(inSlots(night, new Date('2026-12-05T01:00:00Z'), tz)).toBe(true); // samedi 1 h
    expect(inSlots(night, new Date('2026-12-04T23:00:00Z'), tz)).toBe(true); // vendredi 23 h
    expect(inSlots(night, new Date('2026-12-05T03:00:00Z'), tz)).toBe(false);
    expect(inSlots(night, new Date('2026-12-04T01:00:00Z'), tz)).toBe(false); // vendredi 1 h : jeudi absent
  });

  it('CA-039-04 — fuseau de l’établissement', () => {
    // 17 h 30 à Paris (UTC+1) = 16 h 30 UTC : hors créneau à Abidjan, dans le créneau à Paris.
    const at = new Date('2026-12-01T16:30:00Z');
    expect(inSlots(happy, at, tz)).toBe(false);
    expect(inSlots(happy, at, 'Europe/Paris')).toBe(true);
  });

  it('CA-039-05 — contrôles', () => {
    expect(slotsError(happy)).toBeNull();
    expect(slotsError([])).not.toBeNull();
    expect(slotsError([{ days: [], start: '17:00', end: '19:00' }])).not.toBeNull();
    expect(slotsError([{ days: [1], start: '17:10', end: '19:00' }])).not.toBeNull();
    expect(slotsError([happy[0], happy[0], happy[0], happy[0]])).not.toBeNull();
  });
});
