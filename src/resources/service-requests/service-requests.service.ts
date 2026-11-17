import { Injectable } from '@nestjs/common';
import { ActorType, Prisma, RequestStatus, ServiceRequest } from '@prisma/client';
import { PrismaService, Tx } from '../../commons/prisma/prisma.service';
import { can, GuestSession, Scope } from '../../commons/types';
import { conflict, forbidden, notFound, tooMany, unprocessable } from '../../commons/utils/errors';
import { Page, skipTake, toPage } from '../../commons/utils/pagination';
import { DomainEventType, OutboxService } from '../outbox/outbox.service';
import { AssignRequestDto, CreateStaffRequestDto, ListRequestsQuery } from './dto';
import { ACTIVE_STATUSES, canTransition, TERMINAL_STATUSES } from './request-lifecycle';
import {
  GuestRequestView,
  REQUEST_INCLUDE,
  RequestView,
  toGuestRequestView,
  toRequestView,
} from './request.views';

const STATUS_LABELS: Record<RequestStatus, string> = {
  pending: 'en attente',
  assigned: 'affectée',
  accepted: 'acceptée',
  in_progress: 'en cours',
  ready: 'prête',
  resolved: 'résolue',
  cancelled: 'annulée',
};

interface Actor {
  type: ActorType;
  id: string | null;
}

interface StepOptions {
  eventType: DomainEventType;
  actor: Actor;
  payload?: Prisma.InputJsonObject;
  /** Étape intermédiaire d'une opération composée : historisée, mais non diffusée seule. */
  silent?: boolean;
  outbox?: { assigneeId?: string | null; previousAssigneeId?: string | null };
}

export interface RequestEventView {
  id: string;
  type: string;
  fromStatus: RequestStatus | null;
  toStatus: RequestStatus | null;
  actorType: ActorType;
  actorName: string | null;
  payload: Prisma.JsonValue | null;
  createdAt: string;
}

export interface OrderLineInput {
  menuItemId: string;
  quantity: number;
}

/** Ce qu'un client peut créer : une demande de service, ou une commande depuis la carte. */
export type GuestCreateInput =
  | { kind: 'service'; requestTypeId: string; note?: string; quantity?: number }
  | { kind: 'order'; items: OrderLineInput[]; note?: string };

interface ResolvedLine {
  menuItemId: string;
  name: string;
  unitPriceMinor: number;
  quantity: number;
}

export interface GuestCreateResult {
  request: GuestRequestView;
  /** true si une demande existante a été renvoyée (rejeu idempotent ou doublon actif). */
  deduplicated: boolean;
}

const staffActor = (scope: Scope): Actor => ({ type: 'staff', id: scope.userId });

@Injectable()
export class ServiceRequestsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly outbox: OutboxService,
  ) {}

  // ---------------------------------------------------------------- lecture

  async list(scope: Scope, query: ListRequestsQuery): Promise<Page<RequestView>> {
    const where: Prisma.ServiceRequestWhereInput = {
      tenantId: scope.tenantId,
      establishmentId: scope.establishmentId,
      areaId: query.areaId,
      tableId: query.tableId,
      requestTypeId: query.requestTypeId,
      assigneeId: query.assigneeId,
    };
    if (query.status) where.status = query.status;
    else if (query.scope === 'unpaid') {
      // Spec 026 : commandes servies non réglées.
      where.status = 'resolved';
      where.totalMinor = { not: null };
      where.paidAt = null;
    } else if (query.scope === 'active') where.status = { in: [...ACTIVE_STATUSES] };
    else if (query.scope === 'closed') where.status = { in: [...TERMINAL_STATUSES] };
    if (query.late) {
      where.acceptedAt = null;
      where.status = { in: ['pending', 'assigned'] };
      where.dueAt = { lt: new Date() };
    }
    if (query.escalated) where.escalationStatus = { not: 'none' };
    if (query.from || query.to) where.createdAt = { gte: query.from, lte: query.to };

    const [rows, total] = await Promise.all([
      this.prisma.serviceRequest.findMany({
        where,
        include: REQUEST_INCLUDE,
        orderBy: { createdAt: (query.scope === 'active' || query.scope === 'unpaid') && !query.status ? 'asc' : 'desc' },
        ...skipTake(query),
      }),
      this.prisma.serviceRequest.count({ where }),
    ]);
    return toPage(rows.map(toRequestView), total, query);
  }

  async get(scope: Scope, id: string): Promise<RequestView & { events: RequestEventView[] }> {
    const request = await this.prisma.serviceRequest.findFirst({
      where: { id, tenantId: scope.tenantId, establishmentId: scope.establishmentId },
      include: { ...REQUEST_INCLUDE, events: { orderBy: { createdAt: 'asc' } } },
    });
    if (!request) throw this.requestNotFound();
    const actorIds = [...new Set(request.events.map((e) => e.actorId).filter((v): v is string => !!v))];
    const actors = await this.prisma.user.findMany({
      where: { id: { in: actorIds }, tenantId: scope.tenantId },
      select: { id: true, firstName: true, lastName: true },
    });
    const names = new Map(actors.map((a) => [a.id, `${a.firstName} ${a.lastName}`]));
    return {
      ...toRequestView(request),
      events: request.events.map((event) => ({
        id: event.id,
        type: event.type,
        fromStatus: event.fromStatus,
        toStatus: event.toStatus,
        actorType: event.actorType,
        actorName: event.actorId ? (names.get(event.actorId) ?? null) : null,
        payload: event.payload,
        createdAt: event.createdAt.toISOString(),
      })),
    };
  }

  /** Vue par identifiant, sans contrôle de périmètre : réservée aux diffuseurs internes. */
  async loadForBroadcast(tx: Tx, requestId: string) {
    return tx.serviceRequest.findUnique({ where: { id: requestId }, include: REQUEST_INCLUDE });
  }

  // ------------------------------------------------------ création (personnel)

  async createByStaff(scope: Scope, dto: CreateStaffRequestDto): Promise<RequestView> {
    const id = await this.prisma.$transaction(async (tx) => {
      const table = await tx.diningTable.findFirst({
        where: { id: dto.tableId, establishmentId: scope.establishmentId, tenantId: scope.tenantId, archivedAt: null },
        select: { id: true, areaId: true },
      });
      if (!table) throw notFound('TABLE_NOT_FOUND', 'Table introuvable.');
      const type = await this.loadServiceType(tx, scope.establishmentId, dto.requestTypeId);
      const created = await this.insert(tx, {
        scope,
        table,
        type,
        note: dto.note,
        source: 'staff',
        actor: staffActor(scope),
        sessionId: null,
        idempotencyKey: null,
      });
      if (dto.takeIt) {
        if (!can(scope, 'requests.handle')) {
          throw forbidden('PERMISSION_DENIED', "Vous n'avez pas les droits pour traiter une demande.");
        }
        const assigned = await this.stepAssign(tx, created, scope.userId, staffActor(scope), { silent: true });
        await this.stepAccept(tx, assigned, staffActor(scope));
      }
      return created.id;
    });
    this.outbox.kick();
    return this.view(id);
  }

  // --------------------------------------------------------- création (client)

  async createByGuest(
    guest: GuestSession,
    input: GuestCreateInput,
    idempotencyKey: string | null,
  ): Promise<GuestCreateResult> {
    const result = await this.prisma.$transaction(async (tx) => {
      // Verrou sur la session : sérialise les soumissions concurrentes d'un même téléphone.
      const [session] = await tx.$queryRaw<
        { status: string; expiresAt: Date; requestCount: number; lastRequestAt: Date | null }[]
      >`SELECT status::text, "expiresAt", "requestCount", "lastRequestAt"
        FROM "TableSession" WHERE id = ${guest.id}::uuid FOR UPDATE`;
      if (!session || session.status !== 'open' || session.expiresAt <= new Date()) {
        throw forbidden('TABLE_SESSION_CLOSED', 'Cette session de table est fermée. Scannez à nouveau le QR code.');
      }

      if (idempotencyKey) {
        const replay = await tx.serviceRequest.findUnique({
          where: {
            establishmentId_idempotencyKey: { establishmentId: guest.establishmentId, idempotencyKey },
          },
          select: { id: true, sessionId: true },
        });
        if (replay) {
          if (replay.sessionId !== guest.id) throw conflict('IDEMPOTENCY_KEY_REUSED', 'Clé déjà utilisée.');
          return { id: replay.id, deduplicated: true };
        }
      }

      let type: Awaited<ReturnType<ServiceRequestsService['loadServiceType']>>;
      let lines: ResolvedLine[] = [];
      if (input.kind === 'service') {
        type = await this.loadServiceType(tx, guest.establishmentId, input.requestTypeId);
        // Une seule demande active par table et par type : un second appui renvoie l'existante.
        const duplicate = await tx.serviceRequest.findFirst({
          where: { tableId: guest.tableId, requestTypeId: type.id, status: { in: [...ACTIVE_STATUSES] } },
          select: { id: true },
        });
        if (duplicate) return { id: duplicate.id, deduplicated: true };
      } else {
        // Plusieurs commandes peuvent coexister : pas de dédoublonnage, l'idempotence suffit.
        type = await this.loadOrderType(tx, guest.establishmentId);
        lines = await this.resolveLines(tx, guest.establishmentId, input.items);
      }

      const [establishment, table, activeOnTable] = await Promise.all([
        tx.establishment.findUniqueOrThrow({
          where: { id: guest.establishmentId },
          select: { maxActiveRequestsPerTable: true, maxRequestsPerSession: true, requestCooldownSeconds: true },
        }),
        tx.diningTable.findFirst({
          where: { id: guest.tableId, establishmentId: guest.establishmentId, archivedAt: null },
          select: { id: true, areaId: true },
        }),
        tx.serviceRequest.count({ where: { tableId: guest.tableId, status: { in: [...ACTIVE_STATUSES] } } }),
      ]);
      if (!table) throw notFound('TABLE_NOT_FOUND', 'Table introuvable.');
      if (activeOnTable >= establishment.maxActiveRequestsPerTable) {
        throw tooMany('TOO_MANY_ACTIVE_REQUESTS', 'Plusieurs demandes sont déjà en cours pour cette table.');
      }
      if (session.requestCount >= establishment.maxRequestsPerSession) {
        throw tooMany('SESSION_LIMIT_REACHED', 'Limite de demandes atteinte. Adressez-vous au personnel.');
      }
      const cooldownMs = establishment.requestCooldownSeconds * 1000;
      if (session.lastRequestAt && Date.now() - session.lastRequestAt.getTime() < cooldownMs) {
        throw tooMany('REQUEST_COOLDOWN', 'Merci de patienter quelques secondes avant une nouvelle demande.');
      }

      const created = await this.insert(tx, {
        scope: { tenantId: guest.tenantId, establishmentId: guest.establishmentId },
        table,
        type,
        note: type.allowNote ? input.note : undefined,
        quantity: input.kind === 'service' ? input.quantity : undefined,
        lines,
        source: 'customer',
        actor: { type: 'customer', id: null },
        sessionId: guest.id,
        idempotencyKey,
      });
      await tx.tableSession.update({
        where: { id: guest.id },
        data: { requestCount: { increment: 1 }, lastRequestAt: new Date() },
      });
      return { id: created.id, deduplicated: false };
    });
    if (!result.deduplicated) this.outbox.kick();
    const request = await this.prisma.serviceRequest.findUniqueOrThrow({
      where: { id: result.id },
      include: REQUEST_INCLUDE,
    });
    return { request: toGuestRequestView(request), deduplicated: result.deduplicated };
  }

  /** Demandes visibles depuis une table : celles encore actives et celles de la session. */
  async listForGuest(guest: GuestSession): Promise<GuestRequestView[]> {
    const rows = await this.prisma.serviceRequest.findMany({
      where: {
        tableId: guest.tableId,
        establishmentId: guest.establishmentId,
        OR: [{ sessionId: guest.id }, { status: { in: [...ACTIVE_STATUSES] } }],
      },
      include: REQUEST_INCLUDE,
      orderBy: { createdAt: 'desc' },
      // Spec 018, R8 : toute la soirée, pour que le total servi soit juste.
      take: 50,
    });
    return rows.map(toGuestRequestView);
  }

  async cancelByGuest(guest: GuestSession, id: string): Promise<GuestRequestView> {
    await this.prisma.$transaction(async (tx) => {
      const current = await tx.serviceRequest.findFirst({ where: { id, sessionId: guest.id } });
      if (!current) throw this.requestNotFound();
      if (current.status !== 'pending') {
        throw conflict('REQUEST_ALREADY_HANDLED', 'Cette demande est déjà prise en charge.');
      }
      await this.step(tx, current, 'cancelled', { cancelledAt: new Date() }, {
        eventType: 'request.cancelled',
        actor: { type: 'customer', id: null },
      });
    });
    this.outbox.kick();
    const request = await this.prisma.serviceRequest.findUniqueOrThrow({ where: { id }, include: REQUEST_INCLUDE });
    return toGuestRequestView(request);
  }

  // ------------------------------------------------------------- transitions

  /** Accepter : depuis « en attente » (auto-affectation) ou depuis « affectée » (par son destinataire). */
  async accept(scope: Scope, id: string): Promise<RequestView> {
    return this.mutate(scope, id, async (tx, current) => {
      let request = current;
      if (request.status === 'pending') {
        request = await this.stepAssign(tx, request, scope.userId, staffActor(scope), { silent: true });
      } else if (request.status === 'assigned' && request.assigneeId !== scope.userId) {
        throw conflict('ASSIGNED_TO_SOMEONE_ELSE', 'Cette demande est affectée à un autre membre.');
      }
      await this.stepAccept(tx, request, staffActor(scope));
    });
  }

  async start(scope: Scope, id: string): Promise<RequestView> {
    return this.mutate(scope, id, async (tx, current) => {
      this.assertOwnerOrSupervisor(scope, current);
      await this.step(tx, current, 'in_progress', { startedAt: current.startedAt ?? new Date() }, {
        eventType: 'request.started',
        actor: staffActor(scope),
      });
    });
  }

  /**
   * Spec 007 : « Préparer » accepte et démarre une commande en un seul geste.
   * Depuis « en attente » (auto-affectation), ou depuis « affectée » / « acceptée » par soi.
   */
  async prepare(scope: Scope, id: string): Promise<RequestView> {
    return this.mutate(scope, id, async (tx, current) => {
      if (current.totalMinor === null) throw unprocessable('NOT_AN_ORDER', "Seule une commande se prépare depuis l'écran « Commandes ».");
      const takenByOther = current.assigneeId !== null && current.assigneeId !== scope.userId;
      if (takenByOther || !['pending', 'assigned', 'accepted'].includes(current.status)) {
        const holder = current.assigneeId
          ? await tx.user.findUnique({ where: { id: current.assigneeId }, select: { firstName: true } })
          : null;
        throw conflict('ALREADY_TAKEN', holder ? `Déjà prise par ${holder.firstName}.` : `Action impossible : la commande est ${STATUS_LABELS[current.status]}.`);
      }
      let request = current;
      if (request.status === 'pending') {
        request = await this.stepAssign(tx, request, scope.userId, staffActor(scope), { silent: true });
      }
      if (request.status === 'assigned') request = await this.stepAccept(tx, request, staffActor(scope));
      await this.step(tx, request, 'in_progress', { startedAt: request.startedAt ?? new Date() }, {
        eventType: 'request.started',
        actor: staffActor(scope),
      });
    });
  }

  /** Spec 007 : la cuisine signale la commande prête (établissements à cuisine séparée seulement). */
  async markReady(scope: Scope, id: string): Promise<RequestView> {
    return this.mutate(scope, id, async (tx, current) => {
      const establishment = await tx.establishment.findUniqueOrThrow({
        where: { id: current.establishmentId },
        select: { separateKitchen: true },
      });
      if (!establishment.separateKitchen) {
        throw conflict('READY_DISABLED', "L'étape « Prête » n'est pas activée pour cet établissement.");
      }
      this.assertOwnerOrSupervisor(scope, current);
      await this.step(tx, current, 'ready', { readyAt: new Date() }, {
        eventType: 'request.ready',
        actor: staffActor(scope),
      });
    });
  }

  async resolve(scope: Scope, id: string): Promise<RequestView> {
    return this.mutate(scope, id, async (tx, current) => {
      // Spec 007 : une commande prête est servie par le serveur, qui n'est pas forcément celui qui l'a préparée.
      if (current.status !== 'ready') this.assertOwnerOrSupervisor(scope, current);
      await this.step(tx, current, 'resolved', { resolvedAt: new Date() }, {
        eventType: 'request.resolved',
        actor: staffActor(scope),
      });
      await this.closeAssignment(tx, current.id);
    });
  }

  /** Spec 026, R1 : régler une commande servie. Une seule personne réussit si deux règlent en même temps. */
  async settle(scope: Scope, id: string): Promise<RequestView> {
    return this.mutate(scope, id, async (tx, current) => {
      if (current.totalMinor === null) throw unprocessable('NOT_AN_ORDER', 'Seule une commande se règle.');
      if (current.status !== 'resolved') {
        throw conflict('NOT_SERVED', `Action impossible : la commande est ${STATUS_LABELS[current.status]}, pas encore servie.`);
      }
      if (!(await this.markPaid(tx, current, staffActor(scope)))) throw conflict('ALREADY_PAID', 'Déjà réglée.');
    });
  }

  /**
   * Spec 026, R4 : régler toutes les commandes servies non réglées de l'occupation en cours d'une table.
   * Début de l'occupation : même règle que la fiche de table (spec 020) — plus ancienne session ouverte
   * ou plus ancienne demande encore en cours. Les commandes réglées ou non servies ne changent pas.
   */
  async settleTable(scope: Scope, tableId: string): Promise<{ settled: number; amountMinor: number }> {
    const result = await this.prisma.$transaction(async (tx) => {
      const where = { tenantId: scope.tenantId, establishmentId: scope.establishmentId, tableId };
      const table = await tx.diningTable.findFirst({ where: { id: tableId, tenantId: scope.tenantId, establishmentId: scope.establishmentId, archivedAt: null } });
      if (!table) throw notFound('TABLE_NOT_FOUND', 'Table introuvable.');
      const now = new Date();
      const [session, active] = await Promise.all([
        tx.tableSession.findFirst({ where: { ...where, status: 'open', expiresAt: { gt: now } }, orderBy: { openedAt: 'asc' }, select: { openedAt: true } }),
        tx.serviceRequest.findFirst({ where: { ...where, status: { in: [...ACTIVE_STATUSES] } }, orderBy: { createdAt: 'asc' }, select: { createdAt: true } }),
      ]);
      const starts = [session?.openedAt, active?.createdAt].filter((date): date is Date => !!date).map((date) => date.getTime());
      if (starts.length === 0) throw conflict('NOTHING_TO_SETTLE', 'La table est libre : rien à régler.');
      const unpaid = await tx.serviceRequest.findMany({
        where: { ...where, status: 'resolved', totalMinor: { not: null }, paidAt: null, createdAt: { gte: new Date(Math.min(...starts)) } },
      });
      if (unpaid.length === 0) throw conflict('NOTHING_TO_SETTLE', 'Rien à régler sur cette table.');
      let settled = 0;
      let amountMinor = 0;
      for (const request of unpaid) {
        if (await this.markPaid(tx, request, staffActor(scope))) {
          settled += 1;
          amountMinor += request.totalMinor ?? 0;
        }
      }
      return { settled, amountMinor };
    });
    this.outbox.kick();
    return result;
  }

  async cancel(scope: Scope, id: string, reason?: string): Promise<RequestView> {
    return this.mutate(scope, id, async (tx, current) => {
      await this.step(tx, current, 'cancelled', { cancelledAt: new Date() }, {
        eventType: 'request.cancelled',
        actor: staffActor(scope),
        payload: reason ? { reason } : undefined,
      });
      await this.closeAssignment(tx, current.id);
    });
  }

  /** Libérer une demande affectée (assigned → pending). Le motif est obligatoire. */
  async release(scope: Scope, id: string, reason: string): Promise<RequestView> {
    return this.mutate(scope, id, async (tx, current) => {
      this.assertOwnerOrSupervisor(scope, current);
      await this.stepRelease(tx, current, staffActor(scope), reason, false);
    });
  }

  /**
   * Affecter ou réaffecter (permission requests.assign) :
   *  - en attente → affectée ;
   *  - affectée à quelqu'un d'autre → libération justifiée puis nouvelle affectation ;
   *  - en cours → transfert.
   */
  async assign(scope: Scope, id: string, dto: AssignRequestDto): Promise<RequestView> {
    return this.mutate(scope, id, async (tx, current) => {
      await this.assertAssignable(tx, scope, dto.assigneeId);
      if (current.assigneeId === dto.assigneeId && current.status !== 'pending') {
        throw conflict('ALREADY_ASSIGNED', 'La demande est déjà affectée à cette personne.');
      }
      if (current.status === 'pending') {
        await this.stepAssign(tx, current, dto.assigneeId, staffActor(scope), { reason: dto.reason });
        return;
      }
      if (!dto.reason) throw unprocessable('REASON_REQUIRED', 'Un motif est requis pour réaffecter.');
      if (current.status === 'assigned') {
        const released = await this.stepRelease(tx, current, staffActor(scope), dto.reason, true);
        await this.stepAssign(tx, released, dto.assigneeId, staffActor(scope), {
          reason: dto.reason,
          previousAssigneeId: current.assigneeId,
        });
        return;
      }
      await this.stepTransfer(tx, current, dto.assigneeId, staffActor(scope), dto.reason);
    });
  }

  /** Transférer une demande en cours à un collègue (in_progress → assigned). */
  async transfer(scope: Scope, id: string, dto: AssignRequestDto): Promise<RequestView> {
    return this.mutate(scope, id, async (tx, current) => {
      this.assertOwnerOrSupervisor(scope, current);
      if (!dto.reason) throw unprocessable('REASON_REQUIRED', 'Un motif est requis pour transférer.');
      if (current.assigneeId === dto.assigneeId) {
        throw conflict('ALREADY_ASSIGNED', 'La demande est déjà affectée à cette personne.');
      }
      await this.assertAssignable(tx, scope, dto.assigneeId);
      await this.stepTransfer(tx, current, dto.assigneeId, staffActor(scope), dto.reason);
    });
  }

  async acknowledgeEscalation(scope: Scope, id: string): Promise<RequestView> {
    return this.mutate(scope, id, async (tx, current) => {
      const updated = await tx.serviceRequest.updateMany({
        where: { id: current.id, establishmentId: current.establishmentId, escalationStatus: 'escalated' },
        data: { escalationStatus: 'acknowledged' },
      });
      if (updated.count !== 1) {
        throw conflict('NOT_ESCALATED', "Cette demande n'a pas d'escalade à acquitter.");
      }
      await tx.serviceRequestEvent.create({
        data: {
          tenantId: current.tenantId,
          establishmentId: current.establishmentId,
          requestId: current.id,
          type: 'request.escalation_acknowledged',
          actorType: 'staff',
          actorId: scope.userId,
        },
      });
      await this.outbox.add(tx, current, 'request.escalation_acknowledged', {
        requestId: current.id,
        actorId: scope.userId,
      });
    });
  }

  /**
   * Escalade par le système (voir escalation/). Idempotente : sans effet si la demande
   * est terminée ou déjà escaladée. N'altère pas le statut opérationnel.
   */
  async escalate(tx: Tx, requestId: string, ruleName: string): Promise<boolean> {
    const updated = await tx.serviceRequest.updateMany({
      where: { id: requestId, escalationStatus: 'none', status: { in: [...ACTIVE_STATUSES] } },
      data: { escalationStatus: 'escalated', escalatedAt: new Date() },
    });
    if (updated.count !== 1) return false;
    const request = await tx.serviceRequest.findUniqueOrThrow({
      where: { id: requestId },
      select: { tenantId: true, establishmentId: true },
    });
    await tx.serviceRequestEvent.create({
      data: {
        tenantId: request.tenantId,
        establishmentId: request.establishmentId,
        requestId,
        type: 'request.escalated',
        actorType: 'system',
        payload: { rule: ruleName },
      },
    });
    await this.outbox.add(tx, request, 'request.escalated', { requestId, ruleName });
    return true;
  }

  // ------------------------------------------------------------------ étapes

  private async mutate(
    scope: Scope,
    id: string,
    work: (tx: Tx, current: ServiceRequest) => Promise<void>,
  ): Promise<RequestView> {
    await this.prisma.$transaction(async (tx) => {
      const current = await tx.serviceRequest.findFirst({
        where: { id, tenantId: scope.tenantId, establishmentId: scope.establishmentId },
      });
      if (!current) throw this.requestNotFound();
      await work(tx, current);
    });
    this.outbox.kick();
    return this.view(id);
  }

  /**
   * Applique une transition. La mise à jour est conditionnée au statut ET à la version lus :
   * si une autre transaction est passée entre-temps, aucune ligne n'est modifiée et l'appelant
   * reçoit un conflit. C'est ce qui empêche deux serveurs d'accepter la même demande.
   */
  private async step(
    tx: Tx,
    current: ServiceRequest,
    to: RequestStatus,
    data: Prisma.ServiceRequestUncheckedUpdateManyInput,
    options: StepOptions,
  ): Promise<ServiceRequest> {
    if (!canTransition(current.status, to)) {
      throw conflict(
        'INVALID_TRANSITION',
        `Action impossible : la demande est ${STATUS_LABELS[current.status]}.`,
      );
    }
    const updated = await tx.serviceRequest.updateMany({
      where: {
        id: current.id,
        establishmentId: current.establishmentId,
        status: current.status,
        version: current.version,
      },
      data: { ...data, status: to, version: { increment: 1 } },
    });
    if (updated.count !== 1) {
      throw conflict('REQUEST_STATE_CONFLICT', "La demande vient d'être modifiée par quelqu'un d'autre.");
    }
    await tx.serviceRequestEvent.create({
      data: {
        tenantId: current.tenantId,
        establishmentId: current.establishmentId,
        requestId: current.id,
        type: options.eventType,
        fromStatus: current.status,
        toStatus: to,
        actorType: options.actor.type,
        actorId: options.actor.id,
        payload: options.payload,
      },
    });
    if (!options.silent) {
      await this.outbox.add(tx, current, options.eventType, {
        requestId: current.id,
        actorId: options.actor.id,
        ...options.outbox,
      });
    }
    return tx.serviceRequest.findUniqueOrThrow({ where: { id: current.id } });
  }

  /** Spec 026 : marque une commande servie réglée ; false si elle l'était déjà (ou a changé entre-temps). */
  private async markPaid(tx: Tx, request: ServiceRequest, actor: Actor): Promise<boolean> {
    const updated = await tx.serviceRequest.updateMany({
      where: { id: request.id, establishmentId: request.establishmentId, status: 'resolved', paidAt: null },
      data: { paidAt: new Date(), version: { increment: 1 } },
    });
    if (updated.count !== 1) return false;
    await tx.serviceRequestEvent.create({
      data: {
        tenantId: request.tenantId,
        establishmentId: request.establishmentId,
        requestId: request.id,
        type: 'request.paid',
        actorType: actor.type,
        actorId: actor.id,
        payload: { amountMinor: request.totalMinor },
      },
    });
    await this.outbox.add(tx, request, 'request.paid', { requestId: request.id, actorId: actor.id });
    return true;
  }

  private async stepAssign(
    tx: Tx,
    current: ServiceRequest,
    assigneeId: string,
    actor: Actor,
    options: { silent?: boolean; reason?: string; previousAssigneeId?: string | null } = {},
  ): Promise<ServiceRequest> {
    const next = await this.step(tx, current, 'assigned', { assigneeId, assignedAt: new Date() }, {
      eventType: 'request.assigned',
      actor,
      silent: options.silent,
      payload: { assigneeId, ...(options.reason ? { reason: options.reason } : {}) },
      outbox: { assigneeId, previousAssigneeId: options.previousAssigneeId ?? null },
    });
    await this.openAssignment(tx, current, assigneeId, actor.id, options.reason);
    return next;
  }

  private stepAccept(tx: Tx, current: ServiceRequest, actor: Actor): Promise<ServiceRequest> {
    // acceptedAt garde la première acceptation : c'est elle qui mesure la prise en charge.
    return this.step(tx, current, 'accepted', { acceptedAt: current.acceptedAt ?? new Date() }, {
      eventType: 'request.accepted',
      actor,
      outbox: { assigneeId: current.assigneeId },
    });
  }

  private async stepRelease(
    tx: Tx,
    current: ServiceRequest,
    actor: Actor,
    reason: string,
    silent: boolean,
  ): Promise<ServiceRequest> {
    const next = await this.step(tx, current, 'pending', { assigneeId: null, assignedAt: null }, {
      eventType: 'request.released',
      actor,
      silent,
      payload: { reason, previousAssigneeId: current.assigneeId },
      outbox: { previousAssigneeId: current.assigneeId },
    });
    await this.closeAssignment(tx, current.id);
    return next;
  }

  private async stepTransfer(
    tx: Tx,
    current: ServiceRequest,
    assigneeId: string,
    actor: Actor,
    reason: string,
  ): Promise<ServiceRequest> {
    const next = await this.step(tx, current, 'assigned', { assigneeId, assignedAt: new Date() }, {
      eventType: 'request.transferred',
      actor,
      payload: { reason, assigneeId, previousAssigneeId: current.assigneeId },
      outbox: { assigneeId, previousAssigneeId: current.assigneeId },
    });
    await this.closeAssignment(tx, current.id);
    await this.openAssignment(tx, current, assigneeId, actor.id, reason);
    return next;
  }

  // ----------------------------------------------------------------- outils

  private async insert(
    tx: Tx,
    input: {
      scope: { tenantId: string; establishmentId: string };
      table: { id: string; areaId: string };
      type: { id: string; priority: ServiceRequest['priority']; slaSeconds: number };
      note?: string;
      quantity?: number;
      lines?: ResolvedLine[];
      source: ServiceRequest['source'];
      actor: Actor;
      sessionId: string | null;
      idempotencyKey: string | null;
    },
  ): Promise<ServiceRequest> {
    const now = new Date();
    const lines = input.lines ?? [];
    const created = await tx.serviceRequest.create({
      data: {
        tenantId: input.scope.tenantId,
        establishmentId: input.scope.establishmentId,
        tableId: input.table.id,
        areaId: input.table.areaId,
        requestTypeId: input.type.id,
        sessionId: input.sessionId,
        source: input.source,
        note: input.note ? input.note : null,
        quantity: input.quantity ?? null,
        priority: input.type.priority,
        createdById: input.actor.id,
        idempotencyKey: input.idempotencyKey,
        totalMinor: lines.length > 0 ? lines.reduce((sum, line) => sum + line.unitPriceMinor * line.quantity, 0) : null,
        createdAt: now,
        dueAt: new Date(now.getTime() + input.type.slaSeconds * 1000),
      },
    });
    if (lines.length > 0) {
      await tx.serviceRequestItem.createMany({
        data: lines.map((line) => ({
          tenantId: created.tenantId,
          establishmentId: created.establishmentId,
          requestId: created.id,
          ...line,
        })),
      });
    }
    await tx.serviceRequestEvent.create({
      data: {
        tenantId: created.tenantId,
        establishmentId: created.establishmentId,
        requestId: created.id,
        type: 'request.created',
        toStatus: 'pending',
        actorType: input.actor.type,
        actorId: input.actor.id,
        payload: { source: input.source },
      },
    });
    await this.outbox.add(tx, created, 'request.created', { requestId: created.id, actorId: input.actor.id });
    return created;
  }

  private async loadServiceType(tx: Tx, establishmentId: string, requestTypeId: string) {
    const type = await tx.requestType.findFirst({
      where: { id: requestTypeId, establishmentId, kind: 'service', isActive: true, archivedAt: null },
      select: { id: true, priority: true, slaSeconds: true, allowNote: true },
    });
    if (!type) throw notFound('REQUEST_TYPE_NOT_FOUND', 'Type de demande indisponible.');
    return type;
  }

  private async loadOrderType(tx: Tx, establishmentId: string) {
    const type = await tx.requestType.findFirst({
      where: { establishmentId, kind: 'order', isActive: true, archivedAt: null },
      select: { id: true, priority: true, slaSeconds: true, allowNote: true },
    });
    if (!type) throw unprocessable('ORDERING_DISABLED', 'La commande en ligne est suspendue. Adressez-vous au personnel.');
    return type;
  }

  /**
   * Transforme les lignes envoyées par le client en lignes de commande. Le client ne fournit
   * que des identifiants et des quantités : nom et prix viennent de la carte, relue en base,
   * et l'article doit appartenir à CET établissement.
   */
  private async resolveLines(tx: Tx, establishmentId: string, items: OrderLineInput[]): Promise<ResolvedLine[]> {
    const quantities = new Map<string, number>();
    for (const item of items) quantities.set(item.menuItemId, (quantities.get(item.menuItemId) ?? 0) + item.quantity);
    const found = await tx.menuItem.findMany({
      where: { id: { in: [...quantities.keys()] }, establishmentId, archivedAt: null, category: { archivedAt: null } },
      select: { id: true, name: true, priceMinor: true, isAvailable: true },
    });
    if (found.length !== quantities.size) {
      throw unprocessable('MENU_ITEM_NOT_FOUND', "Un article n'est plus à la carte. Actualisez la page.");
    }
    const unavailable = found.find((item) => !item.isAvailable);
    if (unavailable) {
      throw unprocessable('MENU_ITEM_UNAVAILABLE', `« ${unavailable.name} » n'est plus disponible.`);
    }
    return found.map((item) => {
      const quantity = quantities.get(item.id) ?? 0;
      if (quantity > 50) throw unprocessable('QUANTITY_TOO_HIGH', `Quantité trop élevée pour « ${item.name} ».`);
      return { menuItemId: item.id, name: item.name, unitPriceMinor: item.priceMinor, quantity };
    });
  }

  /** Le destinataire doit être un membre actif de CET établissement, habilité à traiter. */
  private async assertAssignable(tx: Tx, scope: Scope, userId: string): Promise<void> {
    const membership = await tx.membership.findFirst({
      where: {
        userId,
        establishmentId: scope.establishmentId,
        tenantId: scope.tenantId,
        user: { status: 'active' },
        role: { permissions: { has: 'requests.handle' } },
        NOT: { revokedPermissions: { has: 'requests.handle' } },
      },
      select: { id: true },
    });
    if (!membership) {
      throw unprocessable('ASSIGNEE_NOT_ELIGIBLE', 'Cette personne ne peut pas recevoir de demande.');
    }
  }

  private assertOwnerOrSupervisor(scope: Scope, request: ServiceRequest): void {
    if (request.assigneeId === scope.userId || can(scope, 'requests.assign')) return;
    throw forbidden('NOT_YOUR_REQUEST', 'Cette demande est affectée à un autre membre.');
  }

  private async openAssignment(
    tx: Tx,
    request: ServiceRequest,
    assigneeId: string,
    assignedById: string | null,
    reason?: string,
  ): Promise<void> {
    await tx.serviceAssignment.create({
      data: {
        tenantId: request.tenantId,
        establishmentId: request.establishmentId,
        requestId: request.id,
        assigneeId,
        assignedById,
        reason,
      },
    });
  }

  private async closeAssignment(tx: Tx, requestId: string): Promise<void> {
    await tx.serviceAssignment.updateMany({
      where: { requestId, endedAt: null },
      data: { endedAt: new Date() },
    });
  }

  private async view(id: string): Promise<RequestView> {
    const request = await this.prisma.serviceRequest.findUniqueOrThrow({ where: { id }, include: REQUEST_INCLUDE });
    return toRequestView(request);
  }

  private requestNotFound() {
    return notFound('REQUEST_NOT_FOUND', 'Demande introuvable.');
  }
}
