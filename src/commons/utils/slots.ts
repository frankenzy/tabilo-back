/**
 * Spec 039 : créneaux horaires. Jours ISO (1 = lundi … 7 = dimanche), heures « HH:MM » au quart d'heure,
 * au fuseau de l'établissement. Un créneau dont la fin précède le début passe minuit (R1).
 */
export interface Slot {
  days: number[];
  start: string;
  end: string;
}

export const MAX_SLOTS = 3;
export const SLOT_TIME = /^([01]\d|2[0-3]):(00|15|30|45)$/;

const WEEKDAYS: Record<string, number> = { Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6, Sun: 7 };

const minutes = (time: string): number => Number(time.slice(0, 2)) * 60 + Number(time.slice(3, 5));

/** Jour ISO et minute du jour d'un instant, au fuseau donné. */
export function localTime(date: Date, timeZone: string): { day: number; minute: number } {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone, weekday: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(date);
  const get = (type: string) => parts.find((part) => part.type === type)?.value ?? '';
  return { day: WEEKDAYS[get('weekday')] ?? 1, minute: Number(get('hour')) * 60 + Number(get('minute')) };
}

/** R1 : l'instant tombe-t-il dans un des créneaux ? */
export function inSlots(slots: Slot[], date: Date, timeZone: string): boolean {
  const { day, minute } = localTime(date, timeZone);
  const previous = day === 1 ? 7 : day - 1;
  return slots.some((slot) => {
    const start = minutes(slot.start);
    const end = minutes(slot.end);
    if (start < end) return slot.days.includes(day) && minute >= start && minute < end;
    // Passe minuit : de « start » à minuit le jour même, puis de minuit à « end » le lendemain.
    return (slot.days.includes(day) && minute >= start) || (slot.days.includes(previous) && minute < end);
  });
}

/** R1 et CA-039-05 : 1 à 3 créneaux, au moins un jour, heures au quart d'heure, début ≠ fin. */
export function slotsError(slots: unknown): string | null {
  if (!Array.isArray(slots) || slots.length < 1 || slots.length > MAX_SLOTS) return `De 1 à ${MAX_SLOTS} créneaux.`;
  for (const slot of slots as Slot[]) {
    if (!slot || !Array.isArray(slot.days) || slot.days.length === 0 || slot.days.some((d) => !Number.isInteger(d) || d < 1 || d > 7)) {
      return 'Chaque créneau a au moins un jour.';
    }
    if (!SLOT_TIME.test(slot.start ?? '') || !SLOT_TIME.test(slot.end ?? '')) return 'Heures au quart d’heure (ex. 17:00, 19:15).';
    if (slot.start === slot.end) return 'Le début et la fin d’un créneau doivent différer.';
  }
  return null;
}

/** Créneaux lus en base (JSON) ; null = pas de créneau. */
export function readSlots(value: unknown): Slot[] | null {
  return Array.isArray(value) && value.length > 0 ? (value as Slot[]) : null;
}
