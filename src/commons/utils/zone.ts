import type { ZoneCheck } from '@prisma/client';

/** Spec 027, R2 : nombre de repères du catalogue (forme + couleur). Au-delà, l'ouverture de session est refusée. */
export const MARKER_COUNT = 16;

/**
 * Repère d'une nouvelle session : le premier libre après `last` (dernier repère attribué sur la table),
 * en tournant dans le catalogue. Le client suivant ne reprend donc pas le repère du client qui vient de régler.
 * null si les 16 repères sont pris par des sessions ouvertes.
 */
export function freeMarker(used: Iterable<number>, last: number | null = null): number | null {
  const taken = new Set(used);
  const start = last === null ? 0 : last + 1;
  for (let step = 0; step < MARKER_COUNT; step += 1) {
    const index = (start + step) % MARKER_COUNT;
    if (!taken.has(index)) return index;
  }
  return null;
}

export interface ZoneSettings {
  zoneLatitude: number | null;
  zoneLongitude: number | null;
  zoneRadiusM: number;
}

/** Position envoyée par le téléphone au moment de commander. Jamais conservée. */
export interface ClientLocation {
  latitude: number;
  longitude: number;
  accuracyM: number;
}

export interface ZoneResult {
  zoneCheck: ZoneCheck;
  /** Distance arrondie, seulement hors zone. */
  zoneDistanceM: number | null;
}

const EARTH_RADIUS_M = 6_371_000;
const rad = (degrees: number) => (degrees * Math.PI) / 180;

/** Distance à vol d'oiseau (haversine), en mètres. */
export function distanceM(a: { latitude: number; longitude: number }, b: { latitude: number; longitude: number }): number {
  const dLat = rad(b.latitude - a.latitude);
  const dLon = rad(b.longitude - a.longitude);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.latitude)) * Math.cos(rad(b.latitude)) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(h)));
}

/** Spec 027, R8 : à 10 m près sous 1 km, à 100 m près au-delà. */
export function roundDistance(meters: number): number {
  return meters < 1000 ? Math.round(meters / 10) * 10 : Math.round(meters / 100) * 100;
}

/**
 * Spec 027, R8 : résultat de la vérification de zone. Sans zone enregistrée : null (rien n'est signalé).
 * Sans position (refus, délai, navigateur sans géolocalisation) : `denied`. Précision plus large que le rayon : `imprecise`.
 */
export function evaluateZone(zone: ZoneSettings, location: ClientLocation | null): ZoneResult | null {
  if (zone.zoneLatitude === null || zone.zoneLongitude === null) return null;
  if (!location) return { zoneCheck: 'denied', zoneDistanceM: null };
  if (location.accuracyM > zone.zoneRadiusM) return { zoneCheck: 'imprecise', zoneDistanceM: null };
  const meters = distanceM({ latitude: zone.zoneLatitude, longitude: zone.zoneLongitude }, location);
  if (meters <= zone.zoneRadiusM) return { zoneCheck: 'inside', zoneDistanceM: null };
  return { zoneCheck: 'outside', zoneDistanceM: roundDistance(meters) };
}
