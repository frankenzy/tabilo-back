import type { RequestStatus } from '@prisma/client';
import {
  assertTransition,
  canTransition,
  InvalidTransitionError,
  isTerminal,
  TRANSITIONS,
} from './request-lifecycle';

const ALL: RequestStatus[] = ['pending', 'assigned', 'accepted', 'in_progress', 'ready', 'resolved', 'cancelled'];

describe('cycle de vie des demandes', () => {
  const allowed: [RequestStatus, RequestStatus][] = [
    ['pending', 'assigned'],
    ['pending', 'cancelled'],
    ['assigned', 'accepted'],
    ['assigned', 'pending'],
    ['accepted', 'in_progress'],
    ['accepted', 'cancelled'],
    ['in_progress', 'resolved'],
    ['in_progress', 'assigned'],
    // Spec 007 : étape « Prête », qu'on ne peut plus annuler (CA-007-11).
    ['in_progress', 'ready'],
    ['ready', 'resolved'],
  ];

  it.each(allowed)('autorise %s → %s', (from, to) => {
    expect(canTransition(from, to)).toBe(true);
    expect(() => assertTransition(from, to)).not.toThrow();
  });

  it('refuse toute transition hors de la liste', () => {
    const allowedKeys = new Set(allowed.map(([from, to]) => `${from}>${to}`));
    for (const from of ALL) {
      for (const to of ALL) {
        if (allowedKeys.has(`${from}>${to}`)) continue;
        expect(canTransition(from, to)).toBe(false);
        expect(() => assertTransition(from, to)).toThrow(InvalidTransitionError);
      }
    }
  });

  it('ne permet pas de sauter des étapes', () => {
    expect(canTransition('pending', 'accepted')).toBe(false);
    expect(canTransition('pending', 'resolved')).toBe(false);
    expect(canTransition('assigned', 'resolved')).toBe(false);
    expect(canTransition('accepted', 'resolved')).toBe(false);
  });

  it('traite resolved et cancelled comme terminaux', () => {
    expect(TRANSITIONS.resolved).toHaveLength(0);
    expect(TRANSITIONS.cancelled).toHaveLength(0);
    expect(isTerminal('resolved')).toBe(true);
    expect(isTerminal('cancelled')).toBe(true);
    expect(isTerminal('in_progress')).toBe(false);
  });
});
