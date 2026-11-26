import { accountStateFor, addMonths } from './subscription';

/** Specs 035 et 037 : état du compte selon l'échéance, et prolongation en mois. */
describe('abonnement', () => {
  const day = 86_400_000;
  const due = new Date('2026-12-08T12:00:00Z');

  it('CA-035-01 — dans l’échéance : essai sans paiement, actif avec', () => {
    expect(accountStateFor(due, new Date(due.getTime() - day), false, false)).toBe('trial');
    expect(accountStateFor(due, new Date(due.getTime() - day), true, false)).toBe('active');
  });

  it('CA-035-03 — en retard pendant 7 jours, puis suspendu', () => {
    expect(accountStateFor(due, new Date(due.getTime() + day), false, false)).toBe('past_due');
    expect(accountStateFor(due, new Date(due.getTime() + 7 * day), true, false)).toBe('past_due');
    expect(accountStateFor(due, new Date(due.getTime() + 7 * day + 1), true, false)).toBe('suspended');
  });

  it('spec 036, R4 — une suspension de l’éditeur l’emporte', () => {
    expect(accountStateFor(due, new Date(due.getTime() - day), true, true)).toBe('suspended');
  });

  it('CA-037-01 et CA-037-02 — prolonger de mois, sans déborder', () => {
    expect(addMonths(new Date('2026-12-31T10:00:00Z'), 1).toISOString()).toBe('2027-01-31T10:00:00.000Z');
    expect(addMonths(new Date('2027-01-10T10:00:00Z'), 1).toISOString()).toBe('2027-02-10T10:00:00.000Z');
    expect(addMonths(new Date('2027-01-31T10:00:00Z'), 1).toISOString()).toBe('2027-02-28T10:00:00.000Z');
    expect(addMonths(new Date('2027-01-31T10:00:00Z'), 12).toISOString()).toBe('2028-01-31T10:00:00.000Z');
    expect(addMonths(new Date('2027-03-31T10:00:00Z'), -1).toISOString()).toBe('2027-02-28T10:00:00.000Z');
  });
});
