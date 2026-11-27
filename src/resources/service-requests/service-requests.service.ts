import { Injectable } from '@nestjs/common';
import { ActorType, Prisma, RequestStatus, RequestTypeKind, ServiceMode, ServiceRequest } from '@prisma/client';
import { PrismaService, Tx } from '../../commons/prisma/prisma.service';
import { PlanService } from '../../commons/services/plan.service';
import { can, GuestSession, Scope } from '../../commons/types';
import { conflict, forbidden, notFound, tooMany, unprocessable } from '../../commons/utils/errors';
import { Page, skipTake, toPage } from '../../commons/utils/pagination';
import { ClientLocation, evaluateZone, ZoneResult } from '../../commons/utils/zone';
import { inSlots, readSlots } from '../../commons/utils/slots';
import { stampSession } from '../loyalty/loyalty-stamp';
import { AuditService } from '../../commons/services/audit.service';
import { DomainEventType, OutboxService } from '../outbox/outbox.service';
import { billSummaries, closeBillRequests, isPayable, PAYABLE } from './bill';
import { AssignRequestDto, CreateStaffRequestDto, ListRequestsQuery } from './dto';
import { ACTIVE_STATUSES, canTransition, TERMINAL_STATUSES } from './request-lifecycle';
import {
  GuestRequestView,
  REQUEST_INCLUDE,
  RequestView,
  RequestWithRelations,
  toGuestRequestView,
  toRequestView,
} from './request.views';

const STATUS_LABELS: Record<RequestStatus, string> = {
  awaiting_payment: 'à encaisser',
  pending: 'en attente',
  assigned: 'affectée',
  accepted: 'acceptée',
  in_progress: 'en cours',
  ready: 'prête',
  resolved: 'résolue',
  cancelled: 'annulée',
};

export interface Actor {
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
  /** Spec 032 : un plat par rubrique, pour une formule. */
  choices?: { groupId: string; menuItemId: string }[];
  /** Spec 038 : options choisies. */
  options?: string[];
}

/** Spec 038, R5 : option choisie, figée sur la ligne de commande. */
export interface FrozenOption {
  group: string;
  optionId: string;
  name: string;
  priceMinor: number;
}

/** Spec 032, R5 : choix d'une formule, figés sur la ligne de commande. */
export interface FrozenChoice {
  group: string;
  menuItemId: string;
  name: string;
}

/** Ce qu'un client peut créer : une demande de service, ou une commande depuis la carte. */
export type GuestCreateInput =
  | { kind: 'service'; requestTypeId: string; note?: string; quantity?: number }
  | {
      kind: 'order';
      items: OrderLineInput[];
      note?: string;
      /** Spec 027, R8 : position au moment de commander ; utilisée pour le calcul puis oubliée. */
      location?: ClientLocation;
      locationStatus?: 'denied' | 'unavailable';
    };

interface ResolvedLine {
  menuItemId: string;
  name: string;
  unitPriceMinor: number;
  quantity: number;
  choices?: FrozenChoice[];
  options?: FrozenOption[];
  /** Spec 033, R1 et R7 : prix de la carte quand la ligne est commandée en promotion. */
  listPriceMinor?: number | null;
}

export interface GuestCreateResult {
  request: GuestRequestView;
  /** true si une demande existante a été renvoyée (rejeu idempotent ou doublon actif). */
  deduplicated: boolean;
}

export const staffActor = (scope: Scope): Actor => ({ type: 'staff', id: scope.userId });

@Injectable()
export class ServiceRequestsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly outbox: OutboxService,
    private readonly audit: AuditService,
    private readonly plans: PlanService,
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
      // Spec 026 et 030 : ce qui reste à régler (« Parti sans payer » en sort, spec 027, R9).
      where.AND = [PAYABLE];
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
        // Spec 048, R1 : le plus récent d'abord, pour toutes les listes (actives et à régler comprises).
        orderBy: { createdAt: 'desc' },
        ...skipTake(query),
      }),
      this.prisma.serviceRequest.count({ where }),
    ]);
    return toPage(await this.withBills(rows), total, query);
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
    const [view] = await this.withBills([request]);
    return {
      ...view,
      // Spec 048 : l'historique, l'action la plus récente d'abord. Lu dans l'ordre d'écriture puis retourné :
      // deux actions d'une même transaction ont la même heure, leur ordre reste exact.
      events: [...request.events].reverse().map((event) => ({
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
      // Spec 029 : le personnel peut aussi saisir un appel pour une table.
      const type = await this.loadServiceType(tx, scope.establishmentId, dto.requestTypeId, ['service', 'call']);
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
        type = await this.loadServiceType(tx, guest.establishmentId, input.requestTypeId, ['service', 'bill', 'call', 'message']);
        const perClient = type.perSession || type.kind === 'bill';
        // Spec 029, R5 : un message porte un texte ; chaque envoi est un message à part, sans dédoublonnage.
        if (type.kind === 'message' && !input.note?.trim()) {
          throw unprocessable('MESSAGE_REQUIRED', 'Écrivez votre message.');
        }
        // Une seule demande active par table et par type : un second appui renvoie l'existante.
        // Spec 027, R6 et spec 028, R1 : par client pour une demande propre à chacun (« L'addition »).
        const duplicate = await tx.serviceRequest.findFirst({
          where: {
            tableId: guest.tableId,
            requestTypeId: type.id,
            status: { in: [...ACTIVE_STATUSES] },
            ...(perClient ? { sessionId: guest.id } : {}),
          },
          select: { id: true },
        });
        if (duplicate && type.kind !== 'message') return { id: duplicate.id, deduplicated: true };
        // Spec 028, R2 : l'addition ne se demande que s'il y a quelque chose à régler.
        if (type.kind === 'bill') {
          // Spec 030, R8 : en « Caisse d'abord », tout est réglé avant d'être servi.
          const { serviceMode } = await tx.establishment.findUniqueOrThrow({ where: { id: guest.establishmentId }, select: { serviceMode: true } });
          if (serviceMode === 'pay_first') throw unprocessable('BILL_DISABLED', "On règle à la caisse avant d'être servi.");
          const summary = (await billSummaries(tx, [guest.id])).get(guest.id);
          if (!summary?.dueMinor) throw unprocessable('NOTHING_TO_PAY', "Rien à régler pour l'instant.");
        }
      } else {
        // Plusieurs commandes peuvent coexister : pas de dédoublonnage, l'idempotence suffit.
        type = await this.loadOrderType(tx, guest.establishmentId);
        lines = await this.resolveLines(tx, guest.establishmentId, input.items);
      }

      const [establishment, table, activeOnTable] = await Promise.all([
        tx.establishment.findUniqueOrThrow({
          where: { id: guest.establishmentId },
          select: {
            maxActiveRequestsPerTable: true, maxRequestsPerSession: true, requestCooldownSeconds: true,
            zoneLatitude: true, zoneLongitude: true, zoneRadiusM: true, serviceMode: true, autoStartOrders: true,
          },
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
        note: type.allowNote || type.kind === 'message' ? input.note : undefined,
        quantity: input.kind === 'service' ? input.quantity : undefined,
        lines,
        source: 'customer',
        actor: { type: 'customer', id: null },
        sessionId: guest.id,
        idempotencyKey,
        // Spec 027, R8 : seule une commande porte le signalement de zone. Les coordonnées ne sont pas transmises plus loin.
        zone: input.kind === 'order' ? evaluateZone(establishment, input.location ?? null) : null,
        // Spec 030, R2 : une commande garde la façon de servir de son envoi.
        serviceMode: input.kind === 'order' ? establishment.serviceMode : null,
        autoStart: input.kind === 'order' && establishment.autoStartOrders,
      });
      const now = new Date();
      await tx.tableSession.update({
        where: { id: guest.id },
        // Spec 027, R9 : toute demande compte comme activité et lève une suspension d'alerte.
        data: { requestCount: { increment: 1 }, lastRequestAt: now, lastActivityAt: now, alertSnoozedUntil: null },
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

  /**
   * Spec 027, R1 : ce que voit un téléphone — les demandes de SA session, plus les demandes de service
   * encore actives communes à la table (appeler un serveur, de l'eau…). Jamais les commandes des autres.
   */
  async listForGuest(guest: GuestSession): Promise<GuestRequestView[]> {
    const rows = await this.prisma.serviceRequest.findMany({
      where: {
        tableId: guest.tableId,
        establishmentId: guest.establishmentId,
        OR: [
          { sessionId: guest.id },
          // Spec 029, R3 : l'appel est commun à la table, comme les demandes de service.
          { status: { in: [...ACTIVE_STATUSES] }, requestType: { kind: { in: ['service', 'call'] }, perSession: false } },
        ],
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
      // Spec 029, R4 : l'appel est commun à la table, chacun de ses téléphones peut raccrocher.
      const current = await tx.serviceRequest.findFirst({
        where: {
          id,
          OR: [
            { sessionId: guest.id },
            { tableId: guest.tableId, establishmentId: guest.establishmentId, requestType: { kind: 'call' } },
          ],
        },
      });
      if (!current) throw this.requestNotFound();
      // Spec 030, R5 et R6 : annulable en attente ou à encaisser, jamais une fois réglée.
      if (current.paidAt) throw conflict('PAID_CANNOT_CANCEL', 'Cette commande est déjà réglée.');
      if (current.status !== 'pending' && current.status !== 'awaiting_payment') {
        throw conflict('REQUEST_ALREADY_HANDLED', 'Cette demande est déjà prise en charge.');
      }
      // Spec 028 : l'addition demandée se clôt d'elle-même, au règlement ou à la fin de session.
      await this.assertNotBill(tx, current);
      await this.step(tx, current, 'cancelled', { cancelledAt: new Date() }, {
        eventType: 'request.cancelled',
        actor: { type: 'customer', id: null },
      });
      await this.endSessionIfDone(tx, current.sessionId);
    });
    this.outbox.kick();
    const request = await this.prisma.serviceRequest.findUniqueOrThrow({ where: { id }, include: REQUEST_INCLUDE });
    return toGuestRequestView(request);
  }

  // ------------------------------------------------------------- transitions

  /** Accepter : depuis « en attente » (auto-affectation) ou depuis « affectée » (par son destinataire). */
  async accept(scope: Scope, id: string): Promise<RequestView> {
    return this.mutate(scope, id, async (tx, current) => {
      await this.assertNotBill(tx, current);
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
      await this.assertNotBill(tx, current);
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
      if (current.totalMinor === null) {
        // Spec 029, R7 : « J'y vais » prend un appel ou un message de la même façon.
        const type = await tx.requestType.findUnique({ where: { id: current.requestTypeId }, select: { kind: true } });
        if (type?.kind !== 'call' && type?.kind !== 'message') {
          throw unprocessable('NOT_AN_ORDER', "Seule une commande se prépare depuis l'écran « Commandes ».");
        }
      }
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
      await this.assertNotBill(tx, current);
      // Spec 007 : une commande prête est servie par le serveur, qui n'est pas forcément celui qui l'a préparée.
      if (current.status !== 'ready') this.assertOwnerOrSupervisor(scope, current);
      await this.step(tx, current, 'resolved', { resolvedAt: new Date() }, {
        eventType: 'request.resolved',
        actor: staffActor(scope),
      });
      await this.closeAssignment(tx, current.id);
      // Spec 030, R10 : réglée avant d'être servie, la commande servie peut terminer la session.
      if (current.paidAt) await this.endSessionIfDone(tx, current.sessionId);
    });
  }

  /**
   * Spec 026, R1 et spec 030 : régler une commande (servie, ou selon sa façon de servir). Encaisser une commande
   * « à encaisser » la fait partir en préparation (spec 030, R7). Une seule personne réussit si deux règlent en même temps.
   */
  async settle(scope: Scope, id: string): Promise<RequestView> {
    return this.mutate(scope, id, async (tx, current) => {
      if (current.totalMinor === null) throw unprocessable('NOT_AN_ORDER', 'Seule une commande se règle.');
      if (current.writtenOffAt) throw conflict('WRITTEN_OFF', 'Commande marquée « Parti sans payer ».');
      if (current.paidAt) throw conflict('ALREADY_PAID', 'Déjà réglée.');
      if (!isPayable(current)) {
        throw conflict('NOT_SERVED', `Action impossible : la commande est ${STATUS_LABELS[current.status]}, pas encore servie.`);
      }
      if (!(await this.payOrder(tx, current, staffActor(scope)))) throw conflict('ALREADY_PAID', 'Déjà réglée.');
      await this.afterPayment(tx, current.sessionId, scope.userId);
    });
  }

  /**
   * Spec 028, R5 : « Glisser pour régler » sur une demande d'addition — règle son client (comme la section « Clients »),
   * ce qui clôt la demande. Un second règlement ne règle rien de plus.
   */
  async settleBill(scope: Scope, id: string): Promise<RequestView> {
    return this.mutate(scope, id, async (tx, current) => {
      const type = await tx.requestType.findUnique({ where: { id: current.requestTypeId }, select: { kind: true } });
      if (type?.kind !== 'bill' || !current.sessionId) throw unprocessable('NOT_A_BILL', "Ce n'est pas une demande d'addition.");
      const settled = await this.settleSessionTx(tx, current.sessionId, staffActor(scope));
      if (settled.settled === 0) throw conflict('NOTHING_TO_SETTLE', 'Rien à régler pour ce client.');
    });
  }

  /** Spec 027, R3 : régler toutes les commandes servies non réglées d'une session (un client). */
  async settleSession(scope: Scope, sessionId: string): Promise<{ settled: number; amountMinor: number }> {
    const result = await this.prisma.$transaction(async (tx) => {
      const session = await tx.tableSession.findFirst({
        where: { id: sessionId, tenantId: scope.tenantId, establishmentId: scope.establishmentId },
        select: { id: true },
      });
      if (!session) throw notFound('SESSION_NOT_FOUND', 'Client introuvable.');
      const settled = await this.settleSessionTx(tx, sessionId, staffActor(scope));
      if (settled.settled === 0) throw conflict('NOTHING_TO_SETTLE', 'Rien à régler pour ce client.');
      return settled;
    });
    this.outbox.kick();
    return result;
  }

  /** Règle les commandes servies non réglées d'une session, dans la transaction de l'appelant. */
  async settleSessionTx(tx: Tx, sessionId: string, actor: Actor): Promise<{ settled: number; amountMinor: number }> {
    const unpaid = await tx.serviceRequest.findMany({ where: { sessionId, AND: [PAYABLE] } });
    let settled = 0;
    let amountMinor = 0;
    for (const request of unpaid) {
      if (await this.payOrder(tx, request, actor)) {
        settled += 1;
        amountMinor += request.totalMinor ?? 0;
      }
    }
    if (settled > 0) await this.afterPayment(tx, sessionId, actor.id);
    return { settled, amountMinor };
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
        where: { ...where, AND: [PAYABLE], createdAt: { gte: new Date(Math.min(...starts)) } },
      });
      if (unpaid.length === 0) throw conflict('NOTHING_TO_SETTLE', 'Rien à régler sur cette table.');
      let settled = 0;
      let amountMinor = 0;
      for (const request of unpaid) {
        if (await this.payOrder(tx, request, staffActor(scope))) {
          settled += 1;
          amountMinor += request.totalMinor ?? 0;
        }
      }
      for (const sessionId of new Set(unpaid.map((request) => request.sessionId))) {
        await this.afterPayment(tx, sessionId, scope.userId);
      }
      return { settled, amountMinor };
    });
    this.outbox.kick();
    return result;
  }

  async cancel(scope: Scope, id: string, reason?: string): Promise<RequestView> {
    return this.mutate(scope, id, async (tx, current) => {
      // Spec 030, R5 : une commande réglée ne s'annule plus.
      if (current.paidAt) throw conflict('PAID_CANNOT_CANCEL', 'Cette commande est déjà réglée.');
      await this.step(tx, current, 'cancelled', { cancelledAt: new Date() }, {
        eventType: 'request.cancelled',
        actor: staffActor(scope),
        payload: reason ? { reason } : undefined,
      });
      await this.closeAssignment(tx, current.id);
      await this.endSessionIfDone(tx, current.sessionId);
    });
  }

  /**
   * Spec 033, R4 et R5 : offrir une ligne entière d'une commande non réglée (elle vaut alors 0), ou retirer le cadeau.
   * Le total de la commande est recalculé : addition, règlement et ventes restent justes (R7). Journalisé (R8).
   */
  async offerLine(scope: Scope, id: string, itemId: string, offered: boolean): Promise<RequestView> {
    // Spec 034, R4 : le geste « Offert » fait partie des promotions.
    await this.plans.assertFeature(scope.tenantId, 'promotions');
    return this.mutate(scope, id, async (tx, current) => {
      if (current.totalMinor === null) throw unprocessable('NOT_AN_ORDER', 'Seule une ligne de commande peut être offerte.');
      if (current.paidAt || current.writtenOffAt || current.status === 'cancelled') {
        throw conflict('ORDER_CLOSED', 'Commande réglée ou annulée : on ne peut plus offrir.');
      }
      const lines = await tx.serviceRequestItem.findMany({ where: { requestId: current.id }, include: { offer: { select: { id: true } } } });
      const line = lines.find((candidate) => candidate.id === itemId);
      if (!line) throw notFound('ORDER_LINE_NOT_FOUND', 'Ligne introuvable.');
      if (offered === (line.offer !== null)) {
        throw conflict(offered ? 'ALREADY_OFFERED' : 'NOT_OFFERED', offered ? 'Cette ligne est déjà offerte.' : "Cette ligne n'est pas offerte.");
      }
      // La ligne reste figée (append-only) : l'« Offert » vit dans sa propre table.
      if (offered) {
        await tx.serviceRequestItemOffer.create({
          data: { tenantId: current.tenantId, establishmentId: current.establishmentId, requestId: current.id, itemId: line.id, offeredById: scope.userId },
        });
      } else {
        await tx.serviceRequestItemOffer.delete({ where: { itemId: line.id } });
      }
      const totalMinor = lines.reduce((sum, candidate) => {
        const isOffered = candidate.id === line.id ? offered : candidate.offer !== null;
        return isOffered ? sum : sum + candidate.unitPriceMinor * candidate.quantity;
      }, 0);
      const updated = await tx.serviceRequest.updateMany({
        where: { id: current.id, version: current.version, paidAt: null },
        data: { totalMinor, version: { increment: 1 } },
      });
      if (updated.count !== 1) throw conflict('REQUEST_STATE_CONFLICT', "La commande vient d'être modifiée par quelqu'un d'autre.");
      const amountMinor = line.unitPriceMinor * line.quantity;
      const table = await tx.diningTable.findUnique({ where: { id: current.tableId }, select: { label: true } });
      await tx.serviceRequestEvent.create({
        data: {
          tenantId: current.tenantId, establishmentId: current.establishmentId, requestId: current.id,
          type: 'request.offered', actorType: 'staff', actorId: scope.userId,
          payload: { itemId: line.id, name: line.name, amountMinor, offered },
        },
      });
      await this.audit.record(
        {
          action: offered ? 'order_line.offered' : 'order_line.unoffered',
          tenantId: scope.tenantId, establishmentId: scope.establishmentId, actorId: scope.userId,
          entityType: 'ServiceRequest', entityId: current.id,
          metadata: { table: table?.label ?? null, item: line.name, amountMinor },
          ip: scope.ip,
        },
        tx,
      );
      await this.outbox.add(tx, current, 'request.offered', { requestId: current.id, actorId: scope.userId });
    });
  }

  /**
   * Spec 043, R4 : la récompense de fidélité devient une commande offerte de la session, qui suit le circuit habituel
   * (préparation, service). Sa ligne vaut 0 et porte « Offert ».
   */
  async createRewardOrder(tx: Tx, sessionId: string, itemId: string, actor: Actor): Promise<string> {
    const session = await tx.tableSession.findUniqueOrThrow({ where: { id: sessionId }, select: { tenantId: true, establishmentId: true, tableId: true } });
    const [type, table, item] = await Promise.all([
      this.loadOrderType(tx, session.establishmentId),
      tx.diningTable.findUniqueOrThrow({ where: { id: session.tableId }, select: { id: true, areaId: true } }),
      tx.menuItem.findFirst({ where: { id: itemId, establishmentId: session.establishmentId, archivedAt: null }, select: { id: true, name: true, priceMinor: true } }),
    ]);
    if (!item) throw unprocessable('MENU_ITEM_NOT_FOUND', "La récompense n'est plus à la carte.");
    const created = await this.insert(tx, {
      scope: { tenantId: session.tenantId, establishmentId: session.establishmentId },
      table,
      type,
      note: 'Récompense de fidélité',
      lines: [{ menuItemId: item.id, name: item.name, unitPriceMinor: item.priceMinor, quantity: 1 }],
      source: 'staff',
      actor,
      sessionId,
      idempotencyKey: null,
    });
    const [line] = await tx.serviceRequestItem.findMany({ where: { requestId: created.id }, select: { id: true } });
    await tx.serviceRequestItemOffer.create({
      data: { tenantId: session.tenantId, establishmentId: session.establishmentId, requestId: created.id, itemId: line.id, offeredById: actor.id },
    });
    // Rien à payer : la commande offerte est réglée d'emblée et ne retient pas la fin de la session.
    await tx.serviceRequest.update({ where: { id: created.id }, data: { totalMinor: 0, paidAt: new Date() } });
    return created.id;
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
      await this.assertNotBill(tx, current);
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

  /**
   * Spec 030, R7 : règle une commande ; une commande « à encaisser » part ensuite en préparation,
   * sans personne affectée. false si elle était déjà réglée (ou a changé entre-temps).
   */
  private async payOrder(tx: Tx, request: ServiceRequest, actor: Actor): Promise<boolean> {
    if (!(await this.markPaid(tx, request, actor))) return false;
    if (request.status === 'awaiting_payment') {
      const paid = await tx.serviceRequest.findUniqueOrThrow({ where: { id: request.id } });
      const now = new Date();
      await this.step(tx, paid, 'in_progress', { acceptedAt: now, startedAt: now }, { eventType: 'request.started', actor });
    }
    return true;
  }

  /** Spec 026 et 030 : marque réglée une commande qui se règle ; false si elle l'était déjà (ou a changé entre-temps). */
  private async markPaid(tx: Tx, request: ServiceRequest, actor: Actor): Promise<boolean> {
    const updated = await tx.serviceRequest.updateMany({
      where: { id: request.id, establishmentId: request.establishmentId, status: request.status, AND: [PAYABLE] },
      data: { paidAt: new Date(), version: { increment: 1 } },
    });
    if (updated.count !== 1) return false;
    if (request.sessionId) {
      // Spec 027, R9 : un règlement compte comme activité de la session.
      await tx.tableSession.update({ where: { id: request.sessionId }, data: { lastActivityAt: new Date(), alertSnoozedUntil: null } });
    }
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

  /**
   * Après un règlement : l'alerte de départ sans payer de la session, s'il n'y a plus rien à régler,
   * est close (« Réglé »), puis la session se termine si tout est servi et réglé (spec 027, R4 et R9).
   */
  private async afterPayment(tx: Tx, sessionId: string | null, actorId: string | null): Promise<void> {
    if (!sessionId) return;
    // Spec 043, R3 : un tampon de fidélité par visite réglée.
    await stampSession(tx, sessionId);
    const due = await tx.serviceRequest.count({ where: { sessionId, AND: [PAYABLE] } });
    if (due === 0) {
      // Spec 028, R6 : plus rien à régler, la demande d'addition est close.
      await closeBillRequests(tx, this.outbox, [sessionId], 'settled', { type: actorId ? 'staff' : 'system', id: actorId });
      const open = await tx.unpaidAlert.findMany({ where: { sessionId, resolvedAt: null }, select: { id: true, tenantId: true, establishmentId: true } });
      for (const alert of open) {
        await tx.unpaidAlert.update({ where: { id: alert.id }, data: { resolvedAt: new Date(), resolution: 'paid', resolvedById: actorId } });
        await this.outbox.add(tx, alert, 'alert.changed', { alertId: alert.id, actorId });
      }
    }
    await this.endSessionIfDone(tx, sessionId);
  }

  /**
   * Spec 027, R4 : une session se termine quand elle n'a plus de demande en cours ni de commande servie à régler.
   * Avec au moins une commande réglée, elle est « réglée » (le téléphone affiche « Réglé · Merci ») ;
   * si ses commandes ont toutes été marquées « Parti sans payer », elle est fermée.
   */
  async endSessionIfDone(tx: Tx, sessionId: string | null): Promise<void> {
    if (!sessionId) return;
    const orders = { sessionId, totalMinor: { not: null } } satisfies Prisma.ServiceRequestWhereInput;
    const [active, due, paid, writtenOff] = await Promise.all([
      tx.serviceRequest.count({ where: { sessionId, status: { in: [...ACTIVE_STATUSES] } } }),
      tx.serviceRequest.count({ where: { sessionId, AND: [PAYABLE] } }),
      tx.serviceRequest.count({ where: { ...orders, paidAt: { not: null } } }),
      tx.serviceRequest.count({ where: { ...orders, writtenOffAt: { not: null } } }),
    ]);
    if (active > 0 || due > 0 || (paid === 0 && writtenOff === 0)) return;
    const status = paid > 0 ? 'settled' : 'closed';
    const session = await tx.tableSession.findUnique({ where: { id: sessionId }, select: { tenantId: true, establishmentId: true } });
    if (!session) return;
    const updated = await tx.tableSession.updateMany({ where: { id: sessionId, status: 'open' }, data: { status, closedAt: new Date() } });
    if (updated.count === 1) {
      await this.outbox.add(tx, session, status === 'settled' ? 'session.settled' : 'session.closed', { sessionIds: [sessionId] });
    }
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
      zone?: ZoneResult | null;
      serviceMode?: ServiceMode | null;
      autoStart?: boolean;
    },
  ): Promise<ServiceRequest> {
    const now = new Date();
    const lines = input.lines ?? [];
    // Spec 030 : à encaisser d'abord (R6), en préparation tout de suite (R9), ou en attente.
    const status: RequestStatus =
      input.serviceMode === 'pay_first' ? 'awaiting_payment' : input.autoStart ? 'in_progress' : 'pending';
    const started = status === 'in_progress' ? now : null;
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
        zoneCheck: input.zone?.zoneCheck ?? null,
        zoneDistanceM: input.zone?.zoneDistanceM ?? null,
        serviceMode: input.serviceMode ?? null,
        status,
        acceptedAt: started,
        startedAt: started,
        createdAt: now,
        dueAt: new Date(now.getTime() + input.type.slaSeconds * 1000),
      },
    });
    if (lines.length > 0) {
      await tx.serviceRequestItem.createMany({
        data: lines.map(({ choices, options, ...line }) => ({
          tenantId: created.tenantId,
          establishmentId: created.establishmentId,
          requestId: created.id,
          ...line,
          choices: choices ? (choices as unknown as Prisma.InputJsonArray) : Prisma.DbNull,
          options: options?.length ? (options as unknown as Prisma.InputJsonArray) : Prisma.DbNull,
        })),
      });
    }
    await tx.serviceRequestEvent.create({
      data: {
        tenantId: created.tenantId,
        establishmentId: created.establishmentId,
        requestId: created.id,
        type: 'request.created',
        toStatus: status,
        actorType: input.actor.type,
        actorId: input.actor.id,
        payload: { source: input.source },
      },
    });
    await this.outbox.add(tx, created, 'request.created', { requestId: created.id, actorId: input.actor.id });
    return created;
  }

  private async loadServiceType(tx: Tx, establishmentId: string, requestTypeId: string, kinds: RequestTypeKind[] = ['service']) {
    const type = await tx.requestType.findFirst({
      where: { id: requestTypeId, establishmentId, kind: { in: kinds }, isActive: true, archivedAt: null },
      select: { id: true, kind: true, priority: true, slaSeconds: true, allowNote: true, perSession: true },
    });
    if (!type) throw notFound('REQUEST_TYPE_NOT_FOUND', 'Type de demande indisponible.');
    return type;
  }

  private async loadOrderType(tx: Tx, establishmentId: string) {
    const type = await tx.requestType.findFirst({
      where: { establishmentId, kind: 'order', isActive: true, archivedAt: null },
      select: { id: true, kind: true, priority: true, slaSeconds: true, allowNote: true, perSession: true },
    });
    if (!type) throw unprocessable('ORDERING_DISABLED', 'La commande en ligne est suspendue. Adressez-vous au personnel.');
    return type;
  }

  /**
   * Transforme les lignes envoyées par le client en lignes de commande. Le client ne fournit
   * que des identifiants et des quantités : nom et prix viennent de la carte, relue en base,
   * et l'article doit appartenir à CET établissement.
   * Spec 032 : une formule garde une ligne par composition ; chaque rubrique reçoit exactement un plat proposé et disponible.
   */
  private async resolveLines(tx: Tx, establishmentId: string, items: OrderLineInput[]): Promise<ResolvedLine[]> {
    const ids = new Set<string>();
    for (const item of items) {
      ids.add(item.menuItemId);
      item.choices?.forEach((choice) => ids.add(choice.menuItemId));
    }
    const [found, { timezone }] = await Promise.all([
      tx.menuItem.findMany({
        where: { id: { in: [...ids] }, establishmentId, archivedAt: null, category: { archivedAt: null } },
        select: {
          id: true, name: true, priceMinor: true, promoPriceMinor: true, isAvailable: true, isBundle: true,
          promoSlots: true, availabilitySlots: true,
          bundleGroups: { orderBy: { position: 'asc' }, select: { id: true, name: true, choiceIds: true } },
          optionGroups: {
            orderBy: { position: 'asc' },
            select: { id: true, name: true, multiple: true, required: true, options: { select: { id: true, name: true, priceMinor: true, isAvailable: true } } },
          },
        },
      }),
      tx.establishment.findUniqueOrThrow({ where: { id: establishmentId }, select: { timezone: true } }),
    ]);
    // Spec 039, R4 : prix et disponibilité au moment où l'API reçoit la commande, au fuseau de l'établissement.
    const now = new Date();
    const open = (slots: unknown) => {
      const list = readSlots(slots);
      return !list || inSlots(list, now, timezone);
    };
    const byId = new Map(found.map((item) => [item.id, item]));
    const ordered = items.map((item) => byId.get(item.menuItemId));
    if (ordered.some((item) => !item)) {
      throw unprocessable('MENU_ITEM_NOT_FOUND', "Un article n'est plus à la carte. Actualisez la page.");
    }
    const unavailable = ordered.find((item) => !item!.isAvailable || !open(item!.availabilitySlots));
    if (unavailable) {
      throw unprocessable('MENU_ITEM_UNAVAILABLE', `« ${unavailable.name} » n'est plus disponible.`);
    }

    // Plats simples : quantités regroupées par plat. Formules : une ligne par composition.
    const lines = new Map<string, ResolvedLine>();
    for (const input of items) {
      const item = byId.get(input.menuItemId)!;
      let choices: FrozenChoice[] | undefined;
      if (item.isBundle) {
        choices = item.bundleGroups.map((group) => {
          const picked = (input.choices ?? []).filter((choice) => choice.groupId === group.id);
          const dish = picked.length === 1 && group.choiceIds.includes(picked[0].menuItemId) ? byId.get(picked[0].menuItemId) : undefined;
          if (!dish || dish.isBundle) {
            throw unprocessable('BUNDLE_CHOICE_INVALID', `Choisissez un plat pour « ${group.name} » dans « ${item.name} ».`);
          }
          if (!dish.isAvailable || !open(dish.availabilitySlots)) throw unprocessable('MENU_ITEM_UNAVAILABLE', `« ${dish.name} » n'est plus disponible.`);
          return { group: group.name, menuItemId: dish.id, name: dish.name };
        });
        if ((input.choices ?? []).length !== item.bundleGroups.length) {
          throw unprocessable('BUNDLE_CHOICE_INVALID', `Un choix par rubrique pour « ${item.name} ».`);
        }
      } else if (input.choices?.length) {
        throw unprocessable('BUNDLE_CHOICE_INVALID', `« ${item.name} » n'est pas une formule.`);
      }
      const options = this.resolveOptions(item, input.options ?? []);
      const extra = options.reduce((sum, option) => sum + option.priceMinor, 0);
      const key = [item.id, choices ? `~${choices.map((choice) => choice.menuItemId).join('.')}` : '', options.length ? `+${options.map((o) => o.optionId).sort().join('.')}` : ''].join('');
      // Spec 033, R1 et spec 039, R2 : en promotion (dans son créneau), le prix promo est commandé et figé ;
      // le prix de la carte est gardé pour les ventes (R7). Spec 038, R3 : les suppléments s'ajoutent.
      const promo = item.promoPriceMinor !== null && item.promoPriceMinor < item.priceMinor && open(item.promoSlots);
      const line = lines.get(key) ?? {
        menuItemId: item.id,
        name: item.name,
        unitPriceMinor: (promo ? item.promoPriceMinor! : item.priceMinor) + extra,
        listPriceMinor: promo ? item.priceMinor + extra : null,
        quantity: 0,
        choices,
        options: options.length ? options : undefined,
      };
      line.quantity += input.quantity;
      if (line.quantity > 50) throw unprocessable('QUANTITY_TOO_HIGH', `Quantité trop élevée pour « ${item.name} ».`);
      lines.set(key, line);
    }
    return [...lines.values()];
  }

  /**
   * Spec 038, R2, R6 et R7 : options d'un plat — les identifiants viennent du client, noms et suppléments de la carte.
   * Un seul choix dans un groupe à choix unique, au moins un dans un groupe obligatoire, rien hors du plat, rien d'indisponible.
   */
  private resolveOptions(
    item: { name: string; optionGroups: { id: string; name: string; multiple: boolean; required: boolean; options: { id: string; name: string; priceMinor: number; isAvailable: boolean }[] }[] },
    optionIds: string[],
  ): FrozenOption[] {
    const wanted = new Set(optionIds);
    const invalid = (message: string) => unprocessable('OPTION_CHOICE_INVALID', message);
    const known = new Set(item.optionGroups.flatMap((group) => group.options.map((option) => option.id)));
    if ([...wanted].some((id) => !known.has(id))) throw invalid(`Une option ne correspond pas à « ${item.name} ».`);
    const frozen: FrozenOption[] = [];
    for (const group of item.optionGroups) {
      const picked = group.options.filter((option) => wanted.has(option.id));
      if (group.required && picked.length === 0) throw invalid(`Choisissez « ${group.name} » pour « ${item.name} ».`);
      if (!group.multiple && picked.length > 1) throw invalid(`Un seul choix pour « ${group.name} ».`);
      const off = picked.find((option) => !option.isAvailable);
      if (off) throw invalid(`« ${off.name} » n'est plus disponible.`);
      frozen.push(...picked.map((option) => ({ group: group.name, optionId: option.id, name: option.name, priceMinor: option.priceMinor })));
    }
    return frozen;
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
    // Spec 030, R7 et R9 : une commande partie en préparation sans personne affectée est à toute l'équipe.
    if (request.assigneeId === null && (request.status === 'in_progress' || request.status === 'ready')) return;
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
    const [view] = await this.withBills([request]);
    return view;
  }

  /** Spec 028, R5 : une demande d'addition porte le montant dû de son client, en direct. */
  private async withBills(rows: RequestWithRelations[]): Promise<RequestView[]> {
    const sessionIds = [...new Set(rows.filter((row) => row.requestType.kind === 'bill' && row.sessionId).map((row) => row.sessionId!))];
    const bills = await billSummaries(this.prisma, sessionIds);
    return rows.map((row) => toRequestView(row, row.sessionId ? bills.get(row.sessionId) : undefined));
  }

  /** Spec 028, R5 : une demande d'addition ne passe ni par « Accepter », ni par « Commencer », ni par « Terminer ». */
  private async assertNotBill(tx: Tx, request: ServiceRequest): Promise<void> {
    const type = await tx.requestType.findUnique({ where: { id: request.requestTypeId }, select: { kind: true } });
    if (type?.kind === 'bill') {
      throw conflict('BILL_SETTLE_ONLY', "Une demande d'addition se clôt en réglant le client.");
    }
  }

  private requestNotFound() {
    return notFound('REQUEST_NOT_FOUND', 'Demande introuvable.');
  }
}
