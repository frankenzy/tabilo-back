import { Injectable, OnModuleInit } from '@nestjs/common';
import { PrismaService, Tx } from '../../commons/prisma/prisma.service';
import type { Scope } from '../../commons/types';
import { Page, PaginationQuery, skipTake, toPage } from '../../commons/utils/pagination';
import { DomainEvent, OutboxService } from '../outbox/outbox.service';

export interface NotificationView {
  id: string;
  type: string;
  title: string;
  body: string | null;
  requestId: string | null;
  createdAt: string;
  readAt: string | null;
}

/**
 * Notifications persistées du personnel. Créées par le diffuseur de l'outbox, donc
 * après validation de l'opération métier ; (userId, sourceEventId) est unique :
 * un rejeu ne crée pas de doublon.
 */
@Injectable()
export class NotificationsService implements OnModuleInit {
  constructor(
    private readonly prisma: PrismaService,
    private readonly outbox: OutboxService,
  ) {}

  onModuleInit(): void {
    this.outbox.registerHandler('notifications', (event, tx) => this.onEvent(event, tx));
  }

  private async onEvent(event: DomainEvent, tx: Tx): Promise<void> {
    if (!event.requestId) return;
    const isAssignment = event.type === 'request.assigned' || event.type === 'request.transferred';
    if (!isAssignment && event.type !== 'request.escalated') return;

    const request = await tx.serviceRequest.findUnique({
      where: { id: event.requestId },
      select: { table: { select: { label: true } }, requestType: { select: { label: true } } },
    });
    if (!request) return;
    const subject = `Table ${request.table.label} · ${request.requestType.label}`;

    let recipients: string[];
    let title: string;
    if (isAssignment) {
      // Pas de notification pour une auto-affectation.
      if (!event.assigneeId || event.assigneeId === event.actorId) return;
      recipients = [event.assigneeId];
      title = event.type === 'request.transferred' ? 'Demande transférée' : 'Demande affectée';
    } else {
      const supervisors = await tx.membership.findMany({
        where: {
          establishmentId: event.establishmentId,
          tenantId: event.tenantId,
          user: { status: 'active' },
          role: { permissions: { has: 'requests.supervise' } },
        },
        select: { userId: true },
      });
      recipients = supervisors.map((m) => m.userId);
      title = 'Demande escaladée';
    }
    if (recipients.length === 0) return;
    await tx.notification.createMany({
      data: recipients.map((userId) => ({
        tenantId: event.tenantId,
        establishmentId: event.establishmentId,
        userId,
        type: event.type,
        title,
        body: subject,
        requestId: event.requestId,
        sourceEventId: BigInt(event.eventId),
      })),
      skipDuplicates: true,
    });
  }

  async list(scope: Scope, query: PaginationQuery): Promise<Page<NotificationView> & { unread: number }> {
    const where = { userId: scope.userId, establishmentId: scope.establishmentId };
    const [rows, total, unread] = await Promise.all([
      this.prisma.notification.findMany({ where, orderBy: { createdAt: 'desc' }, ...skipTake(query) }),
      this.prisma.notification.count({ where }),
      this.prisma.notification.count({ where: { ...where, readAt: null } }),
    ]);
    const items = rows.map((n) => ({
      id: n.id,
      type: n.type,
      title: n.title,
      body: n.body,
      requestId: n.requestId,
      createdAt: n.createdAt.toISOString(),
      readAt: n.readAt ? n.readAt.toISOString() : null,
    }));
    return { ...toPage(items, total, query), unread };
  }

  async markAllRead(scope: Scope): Promise<{ updated: number }> {
    const result = await this.prisma.notification.updateMany({
      where: { userId: scope.userId, establishmentId: scope.establishmentId, readAt: null },
      data: { readAt: new Date() },
    });
    return { updated: result.count };
  }
}
