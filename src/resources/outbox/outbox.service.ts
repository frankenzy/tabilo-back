import { Injectable, Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService, Tx } from '../../commons/prisma/prisma.service';

export type DomainEventType =
  | 'request.created'
  | 'request.assigned'
  | 'request.accepted'
  | 'request.started'
  | 'request.ready'
  | 'request.resolved'
  | 'request.cancelled'
  | 'request.transferred'
  | 'request.released'
  | 'request.escalated'
  | 'request.escalation_acknowledged'
  /** Spec 026 : commande servie réglée. */
  | 'request.paid'
  /** Spec 027, R9 : commande marquée « Parti sans payer ». */
  | 'request.written_off'
  /** Spec 033, R4 et R5 : une ligne offerte, ou son cadeau retiré. */
  | 'request.offered'
  | 'session.closed'
  /** Spec 027, R4 : toutes les commandes de la session sont servies et réglées. */
  | 'session.settled'
  /** Spec 027, R9 : alerte de départ sans payer créée ou traitée. */
  | 'alert.changed'
  /** Spec 047, R6 : un client réglé a libéré la table. */
  | 'session.left';

export interface DomainEventPayload {
  requestId?: string;
  sessionIds?: string[];
  actorId?: string | null;
  assigneeId?: string | null;
  previousAssigneeId?: string | null;
  ruleName?: string;
  alertId?: string;
  /** Spec 047, R6 : nom de la table et table libre après le départ. */
  tableLabel?: string;
  tableFree?: boolean;
}

export interface DomainEvent extends DomainEventPayload {
  /** Identifiant monotone : sert à la déduplication côté client et au rattrapage. */
  eventId: string;
  type: DomainEventType;
  tenantId: string;
  establishmentId: string;
  occurredAt: Date;
}

export type DomainEventHandler = (event: DomainEvent, tx: Tx) => Promise<void>;

const MAX_ATTEMPTS = 10;
const BATCH_SIZE = 100;

/**
 * Transactional outbox.
 *  - `add` écrit l'événement dans la transaction métier : pas d'événement sans changement validé,
 *    pas de changement validé sans événement.
 *  - `kick` déclenche une diffusion immédiate après validation ;
 *  - `dispatchPending` est aussi appelé périodiquement (tasks/) : un événement non diffusé
 *    (crash, redémarrage) est repris. La diffusion est donc « au moins une fois » :
 *    les consommateurs sont idempotents (eventId).
 */
@Injectable()
export class OutboxService {
  private readonly logger = new Logger(OutboxService.name);
  private readonly handlers: { name: string; handle: DomainEventHandler }[] = [];
  private current: Promise<number> | null = null;
  private rerun = false;

  constructor(private readonly prisma: PrismaService) {}

  registerHandler(name: string, handle: DomainEventHandler): void {
    this.handlers.push({ name, handle });
  }

  async add(
    tx: Tx,
    scope: { tenantId: string; establishmentId: string },
    type: DomainEventType,
    payload: DomainEventPayload,
  ): Promise<void> {
    await tx.outboxEvent.create({
      data: {
        tenantId: scope.tenantId,
        establishmentId: scope.establishmentId,
        type,
        payload: payload as Prisma.InputJsonObject,
      },
    });
  }

  /** À appeler après la validation de la transaction. Ne lève jamais. */
  kick(): void {
    setImmediate(() => {
      this.dispatchPending().catch((error: Error) =>
        this.logger.error('Diffusion des événements impossible', error.stack),
      );
    });
  }

  /**
   * Diffuse tout ce qui est en attente. Un seul passage à la fois par instance : un appel
   * concurrent demande un passage supplémentaire et attend la fin du passage en cours.
   */
  async dispatchPending(): Promise<number> {
    if (this.current) {
      this.rerun = true;
      return this.current;
    }
    this.current = this.drain().finally(() => {
      this.current = null;
    });
    return this.current;
  }

  private async drain(): Promise<number> {
    let dispatched = 0;
    do {
      this.rerun = false;
      const pending = await this.prisma.outboxEvent.findMany({
        where: { publishedAt: null, attempts: { lt: MAX_ATTEMPTS } },
        orderBy: { id: 'asc' },
        take: BATCH_SIZE,
        select: { id: true },
      });
      for (const { id } of pending) {
        if (await this.dispatchOne(id)) dispatched += 1;
      }
      if (pending.length === BATCH_SIZE) this.rerun = true;
    } while (this.rerun);
    return dispatched;
  }

  private async dispatchOne(id: bigint): Promise<boolean> {
    try {
      return await this.prisma.$transaction(async (tx) => {
        // Verrou de ligne : deux instances ne diffusent pas le même événement en même temps.
        const locked = await tx.$queryRaw<{ id: bigint }[]>`
          SELECT id FROM "OutboxEvent"
          WHERE id = ${id} AND "publishedAt" IS NULL
          FOR UPDATE SKIP LOCKED`;
        if (locked.length === 0) return false;
        const row = await tx.outboxEvent.findUniqueOrThrow({ where: { id } });
        const event: DomainEvent = {
          ...(row.payload as DomainEventPayload),
          eventId: row.id.toString(),
          type: row.type as DomainEventType,
          tenantId: row.tenantId,
          establishmentId: row.establishmentId,
          occurredAt: row.createdAt,
        };
        for (const handler of this.handlers) {
          await handler.handle(event, tx);
        }
        await tx.outboxEvent.update({ where: { id }, data: { publishedAt: new Date() } });
        return true;
      });
    } catch (error) {
      this.logger.warn(`Événement ${id} non diffusé, nouvel essai planifié : ${(error as Error).message}`);
      await this.prisma.outboxEvent
        .update({ where: { id }, data: { attempts: { increment: 1 } } })
        .catch(() => undefined);
      return false;
    }
  }

  /** Supervision : nombre d'événements en attente et âge du plus ancien. */
  async backlog(): Promise<{ pending: number; oldestSeconds: number | null }> {
    const [pending, oldest] = await Promise.all([
      this.prisma.outboxEvent.count({ where: { publishedAt: null } }),
      this.prisma.outboxEvent.findFirst({
        where: { publishedAt: null },
        orderBy: { id: 'asc' },
        select: { createdAt: true },
      }),
    ]);
    return {
      pending,
      oldestSeconds: oldest ? Math.round((Date.now() - oldest.createdAt.getTime()) / 1000) : null,
    };
  }
}
