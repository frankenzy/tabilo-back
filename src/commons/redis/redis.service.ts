import { Inject, Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import Redis from 'ioredis';
import { APP_ENV, AppEnv } from '../config/env';

/**
 * Connexion Redis partagée. Redis n'est jamais une source de vérité : s'il est indisponible,
 * les appels échouent vite (pas de file d'attente hors ligne) et l'appelant se replie sur PostgreSQL.
 */
@Injectable()
export class RedisService implements OnModuleDestroy {
  private readonly logger = new Logger(RedisService.name);
  readonly client: Redis;
  private lastErrorLoggedAt = 0;

  constructor(@Inject(APP_ENV) private readonly env: AppEnv) {
    this.client = new Redis(env.redisUrl, {
      enableOfflineQueue: false,
      maxRetriesPerRequest: 1,
      connectTimeout: 2000,
      retryStrategy: (attempt) => Math.min(attempt * 500, 5000),
    });
    this.client.on('error', (error: Error) => {
      // Une ligne par minute au plus : une panne Redis ne doit pas noyer les logs.
      if (Date.now() - this.lastErrorLoggedAt > 60_000) {
        this.lastErrorLoggedAt = Date.now();
        this.logger.warn(`Redis indisponible : ${error.message}`);
      }
    });
    this.client.on('ready', () => this.logger.log('Redis connecté'));
  }

  get isReady(): boolean {
    return this.client.status === 'ready';
  }

  /** Options de connexion pour BullMQ, qui gère ses propres connexions. */
  connectionOptions(): { host: string; port: number; password?: string; username?: string; db?: number; tls?: object } {
    const url = new URL(this.env.redisUrl);
    return {
      host: url.hostname,
      port: Number(url.port || 6379),
      username: url.username || undefined,
      password: url.password || undefined,
      db: url.pathname.length > 1 ? Number(url.pathname.slice(1)) : undefined,
      // Redis hébergé (Redis Cloud, Upstash) : URL en rediss://, connexion chiffrée.
      tls: url.protocol === 'rediss:' ? {} : undefined,
    };
  }

  async ping(): Promise<boolean> {
    try {
      return (await this.client.ping()) === 'PONG';
    } catch {
      return false;
    }
  }

  async onModuleDestroy(): Promise<void> {
    this.client.disconnect();
  }
}
