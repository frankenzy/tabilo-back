/**
 * Options pour @Throttle. Les plafonds par route sont neutralisés pendant les tests
 * automatisés, qui enchaînent des centaines d'appels depuis la même adresse.
 */
export function rateLimit(limit: number, ttlMs: number): { default: { limit: number; ttl: number } } {
  return { default: { limit: process.env.NODE_ENV === 'test' ? 100_000 : limit, ttl: ttlMs } };
}
