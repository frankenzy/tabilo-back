import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Photos libres de droits de la carte de démonstration (voir CREDITS.md).
 * Clé : nom de l'article ou de la rubrique tel qu'il figure dans le jeu de démonstration.
 */
const BY_NAME: Record<string, string> = {
  // rubriques
  Plats: 'rubrique-plats',
  Boissons: 'rubrique-boissons',
  Desserts: 'rubrique-desserts',
  // articles
  Garba: 'garba',
  'Alloco poulet': 'alloco-poulet',
  'Attiéké poisson braisé': 'attieke-poisson',
  'Kedjenou de poulet': 'kedjenou',
  Bissap: 'bissap',
  Gnamakoudji: 'gnamakoudji',
  'Eau minérale 1,5 L': 'eau',
  'Bière locale 65 cl': 'biere',
  Dêguê: 'degue',
  'Salade de fruits': 'salade-fruits',
};

/** Photo JPEG d'un article ou d'une rubrique de démonstration, ou null si aucune n'est prévue. */
export function demoPhoto(name: string): Buffer<ArrayBuffer> | null {
  const slug = BY_NAME[name];
  return slug ? (readFileSync(join(__dirname, `${slug}.jpg`)) as Buffer<ArrayBuffer>) : null;
}
