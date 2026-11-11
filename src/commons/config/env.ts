/**
 * Lecture et validation des variables d'environnement.
 * L'application refuse de démarrer si une valeur obligatoire manque ou est faible :
 * aucun secret par défaut n'est embarqué dans le code.
 */
export interface AppEnv {
  nodeEnv: 'development' | 'test' | 'production';
  port: number;
  databaseUrl: string;
  redisUrl: string;
  jwtAccessSecret: string;
  jwtAccessTtlSeconds: number;
  refreshTtlDays: number;
  corsOrigins: string[];
  publicWebUrl: string;
  cookieSecure: boolean;
  swaggerEnabled: boolean;
  workerEnabled: boolean;
}

function required(source: NodeJS.ProcessEnv, key: string): string {
  const value = source[key];
  if (!value || value.trim() === '') {
    throw new Error(`Variable d'environnement manquante : ${key}`);
  }
  return value.trim();
}

function integer(source: NodeJS.ProcessEnv, key: string, fallback: number): number {
  const raw = source[key];
  if (raw === undefined || raw === '') return fallback;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`Variable d'environnement invalide : ${key}`);
  }
  return parsed;
}

function bool(source: NodeJS.ProcessEnv, key: string, fallback: boolean): boolean {
  const raw = source[key];
  if (raw === undefined || raw === '') return fallback;
  return raw === 'true' || raw === '1';
}

export function loadEnv(source: NodeJS.ProcessEnv = process.env): AppEnv {
  const nodeEnv = (source.NODE_ENV ?? 'development') as AppEnv['nodeEnv'];
  if (!['development', 'test', 'production'].includes(nodeEnv)) {
    throw new Error('NODE_ENV doit valoir development, test ou production');
  }
  const jwtAccessSecret = required(source, 'JWT_ACCESS_SECRET');
  if (jwtAccessSecret.length < 32) {
    throw new Error('JWT_ACCESS_SECRET doit contenir au moins 32 caractères');
  }
  const corsOrigins = required(source, 'CORS_ORIGINS')
    .split(',')
    .map((origin) => origin.trim().replace(/\/$/, ''))
    .filter(Boolean);
  if (corsOrigins.includes('*')) {
    throw new Error('CORS_ORIGINS ne peut pas contenir « * »');
  }
  const cookieSecure = bool(source, 'COOKIE_SECURE', nodeEnv === 'production');
  if (nodeEnv === 'production' && !cookieSecure) {
    throw new Error('COOKIE_SECURE doit être true en production (HTTPS obligatoire)');
  }
  return {
    nodeEnv,
    port: integer(source, 'APP_PORT', 3090),
    databaseUrl: required(source, 'DATABASE_URL'),
    redisUrl: required(source, 'REDIS_URL'),
    jwtAccessSecret,
    jwtAccessTtlSeconds: integer(source, 'JWT_ACCESS_TTL_SECONDS', 900),
    refreshTtlDays: integer(source, 'REFRESH_TTL_DAYS', 14),
    corsOrigins,
    publicWebUrl: required(source, 'PUBLIC_WEB_URL').replace(/\/$/, ''),
    cookieSecure,
    swaggerEnabled: bool(source, 'SWAGGER_ENABLED', nodeEnv !== 'production'),
    workerEnabled: bool(source, 'WORKER_ENABLED', true),
  };
}

export const APP_ENV = Symbol('APP_ENV');
