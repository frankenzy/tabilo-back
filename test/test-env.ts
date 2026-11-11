/** Environnement des tests d'intégration : base et secret dédiés, sans lien avec le développement. */
export const TEST_DATABASE_URL =
  process.env.TEST_DATABASE_URL ?? 'postgresql://tabilo:tabilo_local@127.0.0.1:5434/tabilo_test?schema=public';

process.env.NODE_ENV = 'test';
process.env.DATABASE_URL = TEST_DATABASE_URL;
process.env.REDIS_URL = process.env.TEST_REDIS_URL ?? 'redis://127.0.0.1:6381/1';
process.env.JWT_ACCESS_SECRET = 'test-only-secret-test-only-secret-test-only';
process.env.CORS_ORIGINS = 'http://localhost:3004';
process.env.PUBLIC_WEB_URL = 'http://localhost:3004';
process.env.COOKIE_SECURE = 'false';
process.env.SWAGGER_ENABLED = 'false';
