import { Inject, Injectable, Logger, OnApplicationShutdown, OnModuleInit } from '@nestjs/common';
import { Interval } from '@nestjs/schedule';
import { Job, Queue, Worker } from 'bullmq';
import { APP_ENV, AppEnv } from '../commons/config/env';
import { PrismaService } from '../commons/prisma/prisma.service';
import { RedisService } from '../commons/redis/redis.service';
import { EscalationService } from '../resources/escalation/escalation.service';
import { DomainEvent, OutboxService } from '../resources/outbox/outbox.service';

const QUEUE = 'tabilo-escalation';

/** Contexte tenant porté par chaque job : un job ne traite que la demande qu'il nomme. */
interface EscalationJob {
  tenantId: string;
  establishmentId: string;
  requestId: string;
}

/**
 * Traitements asynchrones.
 *
 * Deux mécanismes complémentaires :
 *  1. BullMQ (Redis) — un job différé par demande et par délai d'escalade, pour réagir à la seconde ;
 *  2. des balayages périodiques sur PostgreSQL — reprise de l'outbox, escalades dues,
 *     expiration des sessions. Ils ne dépendent pas de Redis.
 *
 * Si Redis ou le worker tombent, seul (1) est perdu : les escalades arrivent alors avec
 * au plus SWEEP_MS de retard, et aucune n'est oubliée.
 */
@Injectable()
export class TasksService implements OnModuleInit, OnApplicationShutdown {
  private readonly logger = new Logger(TasksService.name);
  private queue?: Queue<EscalationJob>;
  private worker?: Worker<EscalationJob>;
  private lastSweepAt: Date | null = null;

  constructor(
    @Inject(APP_ENV) private readonly env: AppEnv,
    private readonly prisma: PrismaService,
    private readonly redis: RedisService,
    private readonly outbox: OutboxService,
    private readonly escalation: EscalationService,
  ) {}

  onModuleInit(): void {
    if (this.env.nodeEnv === 'test') return;
    const connection = this.redis.connectionOptions();
    // Producteur : échoue vite si Redis est absent, pour ne jamais bloquer la diffusion.
    this.queue = new Queue<EscalationJob>(QUEUE, {
      connection: { ...connection, enableOfflineQueue: false, maxRetriesPerRequest: 1 },
      defaultJobOptions: {
        attempts: 3,
        backoff: { type: 'exponential', delay: 2000 },
        removeOnComplete: 500,
        removeOnFail: 1000,
      },
    });
    this.queue.on('error', () => undefined); // journalisé par RedisService
    this.outbox.registerHandler('escalation-scheduler', (event) => this.schedule(event));

    if (this.env.workerEnabled) {
      this.worker = new Worker<EscalationJob>(QUEUE, (job) => this.process(job), {
        connection: { ...connection, maxRetriesPerRequest: null },
        concurrency: 5,
      });
      this.worker.on('error', () => undefined);
      this.worker.on('failed', (job, error) =>
        this.logger.warn(`Job d'escalade ${job?.id ?? '?'} en échec : ${error.message}`),
      );
    }
  }

  /** À la création d'une demande : programme une vérification à chaque délai d'escalade. */
  private async schedule(event: DomainEvent): Promise<void> {
    if (event.type !== 'request.created' || !event.requestId || !this.queue) return;
    try {
      const request = await this.prisma.serviceRequest.findUnique({
        where: { id: event.requestId },
        select: { requestTypeId: true, createdAt: true },
      });
      if (!request) return;
      const delays = await this.escalation.delaysFor(event.establishmentId, request.requestTypeId);
      for (const seconds of delays) {
        const delay = Math.max(request.createdAt.getTime() + seconds * 1000 - Date.now(), 0) + 500;
        await this.queue.add(
          'check',
          { tenantId: event.tenantId, establishmentId: event.establishmentId, requestId: event.requestId },
          // Identifiant déterministe : un rejeu de l'événement ne duplique pas le job.
          { delay, jobId: `${event.requestId}-${seconds}` },
        );
      }
    } catch (error) {
      // Best effort : le balayage périodique prendra le relais.
      this.logger.debug(`Planification d'escalade ignorée : ${(error as Error).message}`);
    }
  }

  private async process(job: Job<EscalationJob>): Promise<void> {
    const request = await this.prisma.serviceRequest.findFirst({
      where: { id: job.data.requestId, tenantId: job.data.tenantId, establishmentId: job.data.establishmentId },
      select: { id: true },
    });
    if (!request) return;
    await this.escalation.evaluate(request.id);
  }

  @Interval(5_000)
  async relayOutbox(): Promise<void> {
    if (this.skip()) return;
    await this.guard('outbox', () => this.outbox.dispatchPending());
  }

  @Interval(20_000)
  async sweepEscalations(): Promise<void> {
    if (this.skip()) return;
    await this.guard('escalades', async () => {
      await this.escalation.evaluate();
      this.lastSweepAt = new Date();
    });
  }

  @Interval(60_000)
  async expireSessions(): Promise<void> {
    if (this.skip()) return;
    await this.guard('sessions', () =>
      this.prisma.tableSession.updateMany({
        where: { status: 'open', expiresAt: { lte: new Date() } },
        data: { status: 'expired', closedAt: new Date() },
      }),
    );
  }

  /** Purge quotidienne des données techniques sans valeur d'historique. */
  @Interval(24 * 3_600_000)
  async purge(): Promise<void> {
    if (this.skip()) return;
    const monthAgo = new Date(Date.now() - 30 * 86_400_000);
    await this.guard('purge', async () => {
      await this.prisma.outboxEvent.deleteMany({ where: { publishedAt: { lt: monthAgo } } });
      await this.prisma.refreshSession.deleteMany({ where: { expiresAt: { lt: monthAgo } } });
    });
  }

  async status() {
    let queue: Record<string, number> | null = null;
    try {
      if (this.queue && this.redis.isReady) {
        queue = await this.queue.getJobCounts('waiting', 'delayed', 'active', 'failed');
      }
    } catch {
      queue = null;
    }
    return {
      workerEnabled: this.env.workerEnabled,
      workerRunning: this.worker?.isRunning() ?? false,
      lastEscalationSweepAt: this.lastSweepAt ? this.lastSweepAt.toISOString() : null,
      queue,
    };
  }

  private skip(): boolean {
    return this.env.nodeEnv === 'test' || !this.env.workerEnabled;
  }

  private async guard(name: string, work: () => Promise<unknown>): Promise<void> {
    try {
      await work();
    } catch (error) {
      this.logger.error(`Tâche « ${name} » en échec`, (error as Error).stack);
    }
  }

  async onApplicationShutdown(): Promise<void> {
    await this.worker?.close().catch(() => undefined);
    await this.queue?.close().catch(() => undefined);
  }
}
