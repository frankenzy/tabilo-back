import type { AppEnv } from '../config/env';

/**
 * Origines autorisées pour l'API et le temps réel.
 * - Toujours : la liste CORS_ORIGINS.
 * - Hors production seulement : les adresses locales (localhost, 127.0.0.1) et celles du réseau
 *   local (10.x, 172.16-31.x, 192.168.x), pour tester la page client depuis un téléphone
 *   ou par une autre adresse que localhost. En production, seule la liste fait foi.
 */
export function isAllowedOrigin(origin: string | undefined, env: Pick<AppEnv, 'corsOrigins' | 'nodeEnv'>): boolean {
  if (!origin) return true; // requêtes sans origine (outils, serveur à serveur) : pas de CORS en jeu
  if (env.corsOrigins.includes(origin)) return true;
  if (env.nodeEnv === 'production') return false;
  let host: string;
  try {
    host = new URL(origin).hostname;
  } catch {
    return false;
  }
  return (
    host === 'localhost' ||
    host === '127.0.0.1' ||
    host === '[::1]' ||
    /^10\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host) ||
    /^192\.168\.\d{1,3}\.\d{1,3}$/.test(host) ||
    /^172\.(1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3}$/.test(host)
  );
}
