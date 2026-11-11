import fastifyCookie from '@fastify/cookie';
import helmet from '@fastify/helmet';
import { ValidationPipe, VersioningType } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { FastifyAdapter, NestFastifyApplication } from '@nestjs/platform-fastify';
import { IoAdapter } from '@nestjs/platform-socket.io';
import { randomUUID } from 'node:crypto';
import { AppModule } from './app.module';
import { AppEnv, loadEnv } from './commons/config/env';

/** Construit l'application. Partagé par main.ts et les tests d'intégration. */
export async function createApp(): Promise<{ app: NestFastifyApplication; env: AppEnv }> {
  const env = loadEnv();
  const adapter = new FastifyAdapter({
    trustProxy: true,
    // Petits corps JSON ; le plafond laisse passer une photo d'article réduite (≤ 400 Ko en base64).
    bodyLimit: 600 * 1024,
    genReqId: () => randomUUID(),
  });
  const app = await NestFactory.create<NestFastifyApplication>(AppModule, adapter, {
    logger: env.nodeEnv === 'test' ? ['error', 'warn'] : ['log', 'warn', 'error'],
  });

  await app.register(helmet, {
    // L'API ne sert que du JSON ; la CSP stricte ne gêne que la page Swagger, hors production.
    contentSecurityPolicy: env.swaggerEnabled ? false : { directives: { defaultSrc: ["'none'"], frameAncestors: ["'none'"] } },
    hsts: env.nodeEnv === 'production' ? { maxAge: 31_536_000, includeSubDomains: true } : false,
    crossOriginResourcePolicy: { policy: 'same-site' },
  });
  await app.register(fastifyCookie);

  app.enableCors({
    origin: env.corsOrigins,
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'], // PUT : ordre de la carte et photos (spec 001)
    allowedHeaders: ['content-type', 'authorization', 'x-table-session', 'idempotency-key'],
    maxAge: 600,
  });
  app.setGlobalPrefix('api');
  app.enableVersioning({ type: VersioningType.URI });
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true, // les champs non déclarés sont retirés…
      forbidNonWhitelisted: true, // …et signalés : pas de mass assignment
      transform: true,
      transformOptions: { enableImplicitConversion: false },
    }),
  );
  app.useWebSocketAdapter(new IoAdapter(app));
  app.enableShutdownHooks();
  return { app, env };
}
