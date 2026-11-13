import { Injectable, Logger } from '@nestjs/common';
import { EscalationTrigger } from '@prisma/client';
import { PrismaService } from '../../commons/prisma/prisma.service';
import { AuditService } from '../../commons/services/audit.service';
import type { Scope } from '../../commons/types';
import { notFound, unprocessable } from '../../commons/utils/errors';
import { OutboxService } from '../outbox/outbox.service';
import { ServiceRequestsService } from '../service-requests/service-requests.service';

export interface RuleInput {
  name: string;
  trigger: EscalationTrigger;
  afterSeconds: number;
  requestTypeId?: string | null;
  isActive?: boolean;
}

const SELECT = { id: true, name: true, trigger: true, afterSeconds: true, requestTypeId: true, isActive: true } as const;

interface DueRow {
  id: string;
  ruleName: string;
}

/**
 * Escalade : une règle déclenche une alerte de supervision quand une demande reste
 * trop longtemps sans prise en charge (not_accepted) ou sans résolution (not_resolved).
 *
 * L'évaluation se fait entièrement en base (`evaluate`) : elle ne dépend d'aucun état en
 * mémoire ni de Redis. Les jobs BullMQ ne servent qu'à la déclencher à l'instant précis ;
 * le balayage périodique rattrape tout ce qu'un job aurait manqué.
 */
@Injectable()
export class EscalationService {
  private readonly logger = new Logger(EscalationService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly outbox: OutboxService,
    private readonly requests: ServiceRequestsService,
  ) {}

  list(scope: Scope) {
    return this.prisma.escalationRule.findMany({
      where: { ...this.where(scope), archivedAt: null },
      orderBy: { afterSeconds: 'asc' },
      select: SELECT,
    });
  }

  async create(scope: Scope, dto: RuleInput) {
    await this.assertType(scope, dto.requestTypeId);
    return this.prisma.$transaction(async (tx) => {
      const rule = await tx.escalationRule.create({ data: { ...this.where(scope), ...dto }, select: SELECT });
      await this.audit.record({ action: 'escalation_rule.created', ...this.ctx(scope), entityType: 'EscalationRule', entityId: rule.id }, tx);
      return rule;
    });
  }

  async update(scope: Scope, id: string, dto: Partial<RuleInput>) {
    await this.find(scope, id);
    await this.assertType(scope, dto.requestTypeId);
    return this.prisma.$transaction(async (tx) => {
      const rule = await tx.escalationRule.update({ where: { id }, data: dto, select: SELECT });
      await this.audit.record({ action: 'escalation_rule.updated', ...this.ctx(scope), entityType: 'EscalationRule', entityId: id }, tx);
      return rule;
    });
  }

  async archive(scope: Scope, id: string): Promise<void> {
    await this.find(scope, id);
    await this.prisma.$transaction(async (tx) => {
      await tx.escalationRule.update({ where: { id }, data: { archivedAt: new Date(), isActive: false } });
      await this.audit.record({ action: 'escalation_rule.archived', ...this.ctx(scope), entityType: 'EscalationRule', entityId: id }, tx);
    });
  }

  /** Délais (en secondes) auxquels une demande de ce type peut devoir être escaladée. */
  async delaysFor(establishmentId: string, requestTypeId: string): Promise<number[]> {
    const rules = await this.prisma.escalationRule.findMany({
      where: {
        establishmentId,
        isActive: true,
        archivedAt: null,
        OR: [{ requestTypeId: null }, { requestTypeId }],
      },
      select: { afterSeconds: true },
    });
    return [...new Set(rules.map((r) => r.afterSeconds))];
  }

  /**
   * Escalade les demandes dues. `requestId` restreint l'évaluation à une demande (job ciblé) ;
   * sans lui, toute la base est balayée. Idempotent : une demande n'est escaladée qu'une fois.
   */
  async evaluate(requestId?: string): Promise<number> {
    const due = await this.prisma.$queryRaw<DueRow[]>`
      SELECT DISTINCT ON (r.id) r.id, e.name AS "ruleName"
      FROM "ServiceRequest" r
      JOIN "EscalationRule" e
        ON e."establishmentId" = r."establishmentId"
       AND e."isActive" AND e."archivedAt" IS NULL
       AND (e."requestTypeId" IS NULL OR e."requestTypeId" = r."requestTypeId")
      WHERE r."escalationStatus" = 'none'
        AND r.status IN ('pending', 'assigned', 'accepted', 'in_progress', 'ready')
        AND (${requestId ?? null}::uuid IS NULL OR r.id = ${requestId ?? null}::uuid)
        AND r."createdAt" + make_interval(secs => e."afterSeconds") <= now()
        AND (
          (e.trigger = 'not_accepted' AND r."acceptedAt" IS NULL)
          OR e.trigger = 'not_resolved'
        )
      ORDER BY r.id, e."afterSeconds" ASC
      LIMIT 500`;
    let escalated = 0;
    for (const row of due) {
      try {
        const done = await this.prisma.$transaction((tx) => this.requests.escalate(tx, row.id, row.ruleName));
        if (done) escalated += 1;
      } catch (error) {
        this.logger.error(`Escalade de ${row.id} impossible`, (error as Error).stack);
      }
    }
    if (escalated > 0) this.outbox.kick();
    return escalated;
  }

  private async find(scope: Scope, id: string) {
    const rule = await this.prisma.escalationRule.findFirst({ where: { id, ...this.where(scope), archivedAt: null } });
    if (!rule) throw notFound('RULE_NOT_FOUND', 'Règle introuvable.');
    return rule;
  }

  private async assertType(scope: Scope, requestTypeId?: string | null): Promise<void> {
    if (!requestTypeId) return;
    const type = await this.prisma.requestType.findFirst({
      where: { id: requestTypeId, ...this.where(scope), archivedAt: null },
      select: { id: true },
    });
    if (!type) throw unprocessable('REQUEST_TYPE_NOT_FOUND', 'Type de demande introuvable.');
  }

  private where(scope: Scope) {
    return { tenantId: scope.tenantId, establishmentId: scope.establishmentId };
  }

  private ctx(scope: Scope) {
    return { ...this.where(scope), actorId: scope.userId, ip: scope.ip };
  }
}
