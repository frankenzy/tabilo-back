import { distanceM, evaluateZone, freeMarker, MARKER_COUNT, roundDistance } from './zone';

// Centre de la zone : Plateau, Abidjan.
const zone = { zoneLatitude: 5.3197, zoneLongitude: -4.0167, zoneRadiusM: 150 };
/** Point à `meters` mètres au nord du centre (1° de latitude ≈ 111 195 m). */
const north = (meters: number, accuracyM = 20) => ({ latitude: zone.zoneLatitude + meters / 111_195, longitude: zone.zoneLongitude, accuracyM });

describe('Spec 027 — zone et repères', () => {
  it('distanceM : 1 km au nord ≈ 1 000 m', () => {
    expect(distanceM({ latitude: 5.3197, longitude: -4.0167 }, north(1000))).toBeCloseTo(1000, -1);
  });

  it('roundDistance : 10 m près sous 1 km, 100 m au-delà', () => {
    expect(roundDistance(234)).toBe(230);
    expect(roundDistance(999)).toBe(1000);
    expect(roundDistance(2049)).toBe(2000);
    expect(roundDistance(2051)).toBe(2100);
  });

  it('CA-027-10 — hors zone : distance arrondie', () => {
    expect(evaluateZone(zone, north(2000))).toEqual({ zoneCheck: 'outside', zoneDistanceM: 2000 });
  });

  it('dans la zone : aucune distance conservée', () => {
    expect(evaluateZone(zone, north(100))).toEqual({ zoneCheck: 'inside', zoneDistanceM: null });
  });

  it('CA-027-11 — sans position : refusée', () => {
    expect(evaluateZone(zone, null)).toEqual({ zoneCheck: 'denied', zoneDistanceM: null });
  });

  it('CA-027-12 — précision plus large que le rayon : imprécise', () => {
    expect(evaluateZone(zone, north(10, 400))).toEqual({ zoneCheck: 'imprecise', zoneDistanceM: null });
  });

  it('CA-027-13 — pas de zone : rien', () => {
    expect(evaluateZone({ zoneLatitude: null, zoneLongitude: null, zoneRadiusM: 150 }, north(5000))).toBeNull();
  });

  it('CA-027-24 — rayon réglé à 300 m', () => {
    const wide = { ...zone, zoneRadiusM: 300 };
    expect(evaluateZone(wide, north(250))?.zoneCheck).toBe('inside');
    expect(evaluateZone(wide, north(350))?.zoneCheck).toBe('outside');
  });

  it('CA-027-02 — repère : premier libre, null quand le catalogue est épuisé', () => {
    expect(freeMarker([])).toBe(0);
    expect(freeMarker([0, 1, 3])).toBe(2);
    expect(freeMarker(Array.from({ length: MARKER_COUNT }, (_, index) => index))).toBeNull();
  });

  it('CA-027-06 — repère : rotation après le dernier attribué, le client suivant change de repère', () => {
    expect(freeMarker([], 0)).toBe(1);
    expect(freeMarker([1, 2], 0)).toBe(3);
    expect(freeMarker([0], MARKER_COUNT - 1)).toBe(1);
  });
});
