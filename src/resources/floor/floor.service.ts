import { Inject, Injectable } from '@nestjs/common';
import * as QRCode from 'qrcode';
import { APP_ENV, AppEnv } from '../../commons/config/env';
import { PrismaService, Tx } from '../../commons/prisma/prisma.service';
import { AuditService } from '../../commons/services/audit.service';
import type { Scope } from '../../commons/types';
import { randomToken } from '../../commons/utils/crypto';
import { conflict, notFound } from '../../commons/utils/errors';
import { OutboxService } from '../outbox/outbox.service';
import { ACTIVE_STATUSES } from '../service-requests/request-lifecycle';
import { raiseUnpaidAlerts } from '../unpaid-alerts/unpaid-alerts';

export interface TableView {
  id: string;
  label: string;
  seats: number;
  areaId: string;
  openSessions: number;
  hasActiveQr: boolean;
}

export interface AreaView {
  id: string;
  name: string;
  position: number;
  tables: TableView[];
}

/** Carte de la vue « Tables » (spec 006). */
export interface TableStatusView {
  id: string;
  label: string;
  seats: number;
  areaId: string;
  areaName: string;
  status: 'occupied' | 'free';
  /** Commandes non annulées depuis l'ouverture de la plus ancienne session ouverte. NULL si la table est libre. */
  amountMinor: number | null;
  /** Spec 026 : commandes servies non réglées de l'occupation. NULL si la table est libre. */
  unpaidMinor: number | null;
}

export interface TablesOverview {
  currency: string;
  /** Commandes non annulées depuis minuit, heure de l'établissement. */
  ordersToday: number;
  tables: TableStatusView[];
}

/** Spec 020 : une commande de l'occupation en cours, pour la fiche d'une table. */
export interface OccupationOrderView {
  id: string;
  status: string;
  createdAt: string;
  resolvedAt: string | null;
  /** Spec 026 : commande servie réglée, sinon null. */
  paidAt: string | null;
  totalMinor: number;
  /** Spec 022 : précisions du client (note composée), ou null. */
  note: string | null;
  items: { menuItemId: string; name: string; quantity: number; unitPriceMinor: number; imageId: string | null }[];
  /** Spec 027 : session du client qui a commandé (null pour une commande saisie par le personnel). */
  sessionId: string | null;
  /** Spec 027, R9 : marquée « Parti sans payer ». */
  writtenOffAt: string | null;
}

/** Spec 027, R3 : un client de la table (sa session), avec son repère et ce qu'il reste à régler. */
export interface OccupationSessionView {
  id: string;
  marker: number;
  status: 'open' | 'settled' | 'closed' | 'expired';
  unpaidMinor: number;
}

/** Spec 020, R2 et R4 : ce que la fiche d'une table montre de son occupation. */
export interface TableOccupationView {
  tableId: string;
  /** Devise de l'établissement, pour les montants. */
  currency: string;
  /** Arrivée des clients (même règle que la vue « Tables », spec 006, R4) ; NULL si la table est libre. */
  occupiedSince: string | null;
  /** Sessions client ouvertes : les téléphones connectés à la table. */
  openSessions: number;
  /** Commandes non annulées de l'occupation ; NULL si la table est libre. */
  amountMinor: number | null;
  /** Spec 026, R4 : commandes servies non réglées de l'occupation ; NULL si la table est libre. */
  unpaidMinor: number | null;
  /** Table libre : fin de la dernière occupation, si elle date du jour (heure de l'établissement). */
  lastOccupiedAt: string | null;
  /** Commandes de l'occupation, la plus récente d'abord ; vide si la table est libre. */
  orders: OccupationOrderView[];
  /** Spec 027, R3 : clients de l'occupation (sessions ouvertes ou ayant commandé), dans l'ordre d'arrivée. */
  sessions: OccupationSessionView[];
}

export interface QrView {
  tableId: string;
  tableLabel: string;
  areaName: string;
  url: string;
  /** SVG vectoriel. Le PNG est rastérisé par le navigateur : l'encoder ici bloquerait l'API. */
  svg: string;
  createdAt: string;
}

/** Zones, tables, QR codes et fermeture des sessions de table. */
@Injectable()
export class FloorService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly outbox: OutboxService,
    @Inject(APP_ENV) private readonly env: AppEnv,
  ) {}

  // ------------------------------------------------------------------ zones

  async overview(scope: Scope): Promise<AreaView[]> {
    const areas = await this.prisma.diningArea.findMany({
      where: { ...this.where(scope), archivedAt: null },
      orderBy: [{ position: 'asc' }, { createdAt: 'asc' }],
      include: {
        tables: {
          where: { archivedAt: null },
          include: {
            _count: { select: { sessions: { where: { status: 'open', expiresAt: { gt: new Date() } } } } },
            qrCodes: { where: { status: 'active' }, select: { id: true }, take: 1 },
          },
        },
      },
    });
    const collator = new Intl.Collator('fr', { numeric: true });
    return areas.map((area) => ({
      id: area.id,
      name: area.name,
      position: area.position,
      tables: area.tables
        .sort((a, b) => collator.compare(a.label, b.label))
        .map((table) => ({
          id: table.id,
          label: table.label,
          seats: table.seats,
          areaId: table.areaId,
          openSessions: table._count.sessions,
          hasActiveQr: table.qrCodes.length > 0,
        })),
    }));
  }

  /** Vue « Tables » du gérant et du propriétaire (spec 006). */
  async tablesOverview(scope: Scope): Promise<TablesOverview> {
    const [establishment] = await this.prisma.$queryRaw<{ currency: string; ordersToday: number }[]>`
      SELECT est.currency,
        (SELECT count(*)::int FROM "ServiceRequest" r
          WHERE r."establishmentId" = est.id AND r."tenantId" = est."tenantId"
            AND r."totalMinor" IS NOT NULL AND r.status <> 'cancelled'
            AND r."createdAt" >= date_trunc('day', now() AT TIME ZONE est.timezone) AT TIME ZONE est.timezone
        ) AS "ordersToday"
      FROM "Establishment" est
      WHERE est.id = ${scope.establishmentId}::uuid AND est."tenantId" = ${scope.tenantId}::uuid`;
    if (!establishment) throw notFound('ESTABLISHMENT_NOT_FOUND', 'Établissement introuvable.');

    const rows = await this.prisma.$queryRaw<
      { id: string; label: string; seats: number; areaId: string; areaName: string; areaPosition: number; occupiedSince: Date | null; amountMinor: number | null; unpaidMinor: number | null }[]
    >`
      -- Début de l'occupation (spec 006, R2 et R4) : plus ancienne session ouverte,
      -- ou plus ancienne demande encore en cours si le client s'est déconnecté entre-temps.
      WITH open_since AS (
        SELECT "tableId", min(since) AS since FROM (
          SELECT s."tableId", s."openedAt" AS since
          FROM "TableSession" s
          WHERE s."establishmentId" = ${scope.establishmentId}::uuid AND s."tenantId" = ${scope.tenantId}::uuid
            AND s.status = 'open' AND s."expiresAt" > now()
          UNION ALL
          SELECT r."tableId", r."createdAt" AS since
          FROM "ServiceRequest" r
          WHERE r."establishmentId" = ${scope.establishmentId}::uuid AND r."tenantId" = ${scope.tenantId}::uuid
            AND r.status IN ('pending', 'assigned', 'accepted', 'in_progress', 'ready')
        ) starts
        GROUP BY "tableId"
      )
      SELECT t.id, t.label, t.seats, a.id AS "areaId", a.name AS "areaName", a.position AS "areaPosition",
        o.since AS "occupiedSince",
        CASE WHEN o.since IS NULL THEN NULL ELSE (
          SELECT coalesce(sum(r."totalMinor"), 0)::int FROM "ServiceRequest" r
          WHERE r."tableId" = t.id AND r."establishmentId" = t."establishmentId"
            AND r."totalMinor" IS NOT NULL AND r.status <> 'cancelled' AND r."createdAt" >= o.since
        ) END AS "amountMinor",
        CASE WHEN o.since IS NULL THEN NULL ELSE (
          SELECT coalesce(sum(r."totalMinor"), 0)::int FROM "ServiceRequest" r
          WHERE r."tableId" = t.id AND r."establishmentId" = t."establishmentId"
            AND r."totalMinor" IS NOT NULL AND r.status = 'resolved' AND r."paidAt" IS NULL AND r."writtenOffAt" IS NULL AND r."createdAt" >= o.since
        ) END AS "unpaidMinor"
      FROM "DiningTable" t
      JOIN "DiningArea" a ON a.id = t."areaId" AND a."archivedAt" IS NULL
      LEFT JOIN open_since o ON o."tableId" = t.id
      WHERE t."establishmentId" = ${scope.establishmentId}::uuid AND t."tenantId" = ${scope.tenantId}::uuid
        AND t."archivedAt" IS NULL`;

    const collator = new Intl.Collator('fr', { numeric: true });
    rows.sort((a, b) => a.areaPosition - b.areaPosition || collator.compare(a.label, b.label));
    return {
      currency: establishment.currency,
      ordersToday: establishment.ordersToday,
      tables: rows.map((row) => ({
        id: row.id,
        label: row.label,
        seats: row.seats,
        areaId: row.areaId,
        areaName: row.areaName,
        status: row.occupiedSince ? 'occupied' : 'free',
        amountMinor: row.occupiedSince ? row.amountMinor : null,
        unpaidMinor: row.occupiedSince ? row.unpaidMinor : null,
      })),
    };
  }

  /** Spec 020 : occupation d'une table pour sa fiche (arrivée, téléphones, commandes). */
  async tableOccupation(scope: Scope, tableId: string): Promise<TableOccupationView> {
    await this.findTable(scope, tableId);
    const establishment = await this.prisma.establishment.findFirst({ where: { id: scope.establishmentId, tenantId: scope.tenantId }, select: { currency: true } });
    if (!establishment) throw notFound('ESTABLISHMENT_NOT_FOUND', 'Établissement introuvable.');
    const currency = establishment.currency;
    const where = { ...this.where(scope), tableId };
    const now = new Date();
    const [sessions, oldestActive] = await Promise.all([
      this.prisma.tableSession.findMany({ where: { ...where, status: 'open', expiresAt: { gt: now } }, select: { id: true, openedAt: true } }),
      this.prisma.serviceRequest.findFirst({
        where: { ...where, status: { in: [...ACTIVE_STATUSES] } },
        orderBy: { createdAt: 'asc' },
        select: { createdAt: true },
      }),
    ]);
    // Même règle que la vue « Tables » (spec 006, R2 et R4) : plus ancienne session ouverte ou demande encore en cours.
    const starts = [...sessions.map((session) => session.openedAt.getTime()), ...(oldestActive ? [oldestActive.createdAt.getTime()] : [])];
    const since = starts.length > 0 ? new Date(Math.min(...starts)) : null;

    if (!since) {
      const [row] = await this.prisma.$queryRaw<{ last: Date | null; dayStart: Date }[]>`
        SELECT greatest(
            (SELECT max(s."closedAt") FROM "TableSession" s WHERE s."tableId" = ${tableId}::uuid AND s."establishmentId" = est.id),
            (SELECT max(coalesce(r."resolvedAt", r."cancelledAt")) FROM "ServiceRequest" r WHERE r."tableId" = ${tableId}::uuid AND r."establishmentId" = est.id)
          ) AS last,
          date_trunc('day', now() AT TIME ZONE est.timezone) AT TIME ZONE est.timezone AS "dayStart"
        FROM "Establishment" est
        WHERE est.id = ${scope.establishmentId}::uuid AND est."tenantId" = ${scope.tenantId}::uuid`;
      const last = row?.last && row.last >= row.dayStart ? row.last.toISOString() : null;
      return { tableId, currency, occupiedSince: null, openSessions: 0, amountMinor: null, unpaidMinor: null, lastOccupiedAt: last, orders: [], sessions: [] };
    }

    const requests = await this.prisma.serviceRequest.findMany({
      where: { ...where, totalMinor: { not: null }, createdAt: { gte: since } },
      orderBy: { createdAt: 'desc' },
      take: 50,
      select: {
        id: true, status: true, createdAt: true, resolvedAt: true, paidAt: true, totalMinor: true, note: true, sessionId: true, writtenOffAt: true,
        items: { select: { menuItemId: true, name: true, quantity: true, unitPriceMinor: true }, orderBy: { name: 'asc' } },
      },
    });
    const menuIds = [...new Set(requests.flatMap((request) => request.items.map((item) => item.menuItemId)))];
    const due = (request: (typeof requests)[number]) => request.status === 'resolved' && !request.paidAt && !request.writtenOffAt;
    // Spec 027, R3 : les clients de l'occupation — téléphones encore ouverts et sessions qui ont commandé.
    const sessionIds = [...new Set([...sessions.map((session) => session.id), ...requests.map((request) => request.sessionId).filter((id): id is string => !!id)])];
    const sessionRows = await this.prisma.tableSession.findMany({
      where: { id: { in: sessionIds }, ...this.where(scope) },
      orderBy: { openedAt: 'asc' },
      select: { id: true, markerIndex: true, status: true },
    });
    const images = new Map(
      (await this.prisma.menuItem.findMany({ where: { id: { in: menuIds }, ...this.where(scope) }, select: { id: true, imageId: true } })).map((item) => [item.id, item.imageId]),
    );
    return {
      tableId,
      currency,
      occupiedSince: since.toISOString(),
      openSessions: sessions.length,
      amountMinor: requests.filter((request) => request.status !== 'cancelled').reduce((sum, request) => sum + (request.totalMinor ?? 0), 0),
      unpaidMinor: requests.filter(due).reduce((sum, request) => sum + (request.totalMinor ?? 0), 0),
      lastOccupiedAt: null,
      orders: requests.map((request) => ({
        id: request.id,
        status: request.status,
        createdAt: request.createdAt.toISOString(),
        resolvedAt: request.resolvedAt?.toISOString() ?? null,
        paidAt: request.paidAt?.toISOString() ?? null,
        totalMinor: request.totalMinor ?? 0,
        note: request.note,
        items: request.items.map((item) => ({ ...item, imageId: images.get(item.menuItemId) ?? null })),
        sessionId: request.sessionId,
        writtenOffAt: request.writtenOffAt?.toISOString() ?? null,
      })),
      sessions: sessionRows.map((session) => ({
        id: session.id,
        marker: session.markerIndex,
        status: session.status,
        unpaidMinor: requests.filter((request) => request.sessionId === session.id && due(request)).reduce((sum, request) => sum + (request.totalMinor ?? 0), 0),
      })),
    };
  }

  async createArea(scope: Scope, dto: { name: string }) {
    await this.assertAreaNameFree(scope, dto.name);
    const last = await this.prisma.diningArea.aggregate({
      where: { ...this.where(scope), archivedAt: null },
      _max: { position: true },
    });
    return this.prisma.$transaction(async (tx) => {
      const area = await tx.diningArea.create({
        data: { ...this.where(scope), name: dto.name, position: (last._max.position ?? -1) + 1 },
        select: { id: true, name: true, position: true },
      });
      await this.log(tx, scope, 'area.created', 'DiningArea', area.id);
      return area;
    });
  }

  async updateArea(scope: Scope, id: string, dto: { name?: string; position?: number }) {
    const area = await this.findArea(scope, id);
    if (dto.name && dto.name !== area.name) await this.assertAreaNameFree(scope, dto.name);
    return this.prisma.$transaction(async (tx) => {
      const updated = await tx.diningArea.update({
        where: { id },
        data: { name: dto.name, position: dto.position },
        select: { id: true, name: true, position: true },
      });
      await this.log(tx, scope, 'area.updated', 'DiningArea', id);
      return updated;
    });
  }

  /** Archive (jamais de suppression physique : l'historique des demandes y fait référence). */
  async archiveArea(scope: Scope, id: string): Promise<void> {
    await this.findArea(scope, id);
    const tables = await this.prisma.diningTable.count({ where: { areaId: id, archivedAt: null } });
    if (tables > 0) throw conflict('AREA_NOT_EMPTY', 'Déplacez ou archivez les tables de cette zone avant de la supprimer.');
    await this.prisma.$transaction(async (tx) => {
      await tx.diningArea.update({ where: { id }, data: { archivedAt: new Date() } });
      await this.log(tx, scope, 'area.archived', 'DiningArea', id);
    });
  }

  // ----------------------------------------------------------------- tables

  async createTable(scope: Scope, dto: { areaId: string; label: string; seats?: number }) {
    await this.findArea(scope, dto.areaId);
    await this.assertLabelFree(scope, dto.label);
    return this.prisma.$transaction(async (tx) => {
      const table = await tx.diningTable.create({
        data: { ...this.where(scope), areaId: dto.areaId, label: dto.label, seats: dto.seats ?? 2 },
        select: { id: true, label: true, seats: true, areaId: true },
      });
      await tx.qrCode.create({ data: { ...this.where(scope), tableId: table.id, code: randomToken(18) } });
      await this.log(tx, scope, 'table.created', 'DiningTable', table.id);
      return table;
    });
  }

  async updateTable(scope: Scope, id: string, dto: { areaId?: string; label?: string; seats?: number }) {
    const table = await this.findTable(scope, id);
    if (dto.areaId && dto.areaId !== table.areaId) await this.findArea(scope, dto.areaId);
    if (dto.label && dto.label !== table.label) await this.assertLabelFree(scope, dto.label);
    return this.prisma.$transaction(async (tx) => {
      const updated = await tx.diningTable.update({
        where: { id },
        data: { areaId: dto.areaId, label: dto.label, seats: dto.seats },
        select: { id: true, label: true, seats: true, areaId: true },
      });
      await this.log(tx, scope, 'table.updated', 'DiningTable', id);
      return updated;
    });
  }

  async archiveTable(scope: Scope, id: string): Promise<void> {
    await this.findTable(scope, id);
    const active = await this.prisma.serviceRequest.count({
      where: { tableId: id, status: { in: [...ACTIVE_STATUSES] } },
    });
    if (active > 0) throw conflict('TABLE_HAS_ACTIVE_REQUESTS', 'Des demandes sont encore en cours sur cette table.');
    await this.prisma.$transaction(async (tx) => {
      await tx.diningTable.update({ where: { id }, data: { archivedAt: new Date() } });
      await tx.qrCode.updateMany({ where: { tableId: id, status: 'active' }, data: { status: 'revoked', revokedAt: new Date() } });
      await this.closeSessionsTx(tx, scope, id);
      await this.log(tx, scope, 'table.archived', 'DiningTable', id);
    });
    this.outbox.kick();
  }

  // --------------------------------------------------------------- QR codes

  async qrCodes(scope: Scope, tableId?: string): Promise<QrView[]> {
    const codes = await this.prisma.qrCode.findMany({
      where: { ...this.where(scope), status: 'active', tableId, table: { archivedAt: null } },
      include: { table: { select: { label: true, area: { select: { name: true } } } } },
    });
    const collator = new Intl.Collator('fr', { numeric: true });
    codes.sort((a, b) => collator.compare(a.table.label, b.table.label));
    return Promise.all(
      codes.map(async (qr) => {
        const url = `${this.env.publicWebUrl}/t/${qr.code}`;
        const svg = await QRCode.toString(url, { type: 'svg', errorCorrectionLevel: 'M', margin: 2 });
        return {
          tableId: qr.tableId,
          tableLabel: qr.table.label,
          areaName: qr.table.area.name,
          url,
          svg,
          createdAt: qr.createdAt.toISOString(),
        };
      }),
    );
  }

  /** Remplace le QR d'une table : l'ancien est révoqué et ses sessions ouvertes sont fermées. */
  async regenerateQr(scope: Scope, tableId: string): Promise<QrView> {
    await this.findTable(scope, tableId);
    await this.prisma.$transaction(async (tx) => {
      await tx.qrCode.updateMany({ where: { tableId, status: 'active' }, data: { status: 'revoked', revokedAt: new Date() } });
      await tx.qrCode.create({ data: { ...this.where(scope), tableId, code: randomToken(18) } });
      await this.closeSessionsTx(tx, scope, tableId);
      await this.log(tx, scope, 'qr.regenerated', 'DiningTable', tableId);
    });
    this.outbox.kick();
    const [qr] = await this.qrCodes(scope, tableId);
    return qr;
  }

  // --------------------------------------------------------------- sessions

  /** Ferme toutes les sessions ouvertes d'une table (départ des clients). */
  async closeSessions(scope: Scope, tableId: string): Promise<{ closed: number }> {
    await this.findTable(scope, tableId);
    const closed = await this.prisma.$transaction(async (tx) => {
      const count = await this.closeSessionsTx(tx, scope, tableId);
      await this.log(tx, scope, 'sessions.closed', 'DiningTable', tableId, { closed: count });
      return count;
    });
    this.outbox.kick();
    return { closed };
  }

  private async closeSessionsTx(tx: Tx, scope: Scope, tableId: string): Promise<number> {
    const open = await tx.tableSession.findMany({
      where: { tableId, establishmentId: scope.establishmentId, status: 'open' },
      select: { id: true },
    });
    if (open.length === 0) return 0;
    const sessionIds = open.map((s) => s.id);
    // Spec 027, R9 : libérer une table avec un reste à régler crée une alerte par client concerné.
    await raiseUnpaidAlerts(tx, this.outbox, sessionIds, 'released');
    await tx.tableSession.updateMany({
      where: { id: { in: sessionIds } },
      data: { status: 'closed', closedAt: new Date(), closedById: scope.userId },
    });
    await this.outbox.add(tx, scope, 'session.closed', { sessionIds, actorId: scope.userId });
    return sessionIds.length;
  }

  // ----------------------------------------------------------------- outils

  private where(scope: Scope) {
    return { tenantId: scope.tenantId, establishmentId: scope.establishmentId };
  }

  private async findArea(scope: Scope, id: string) {
    const area = await this.prisma.diningArea.findFirst({ where: { id, ...this.where(scope), archivedAt: null } });
    if (!area) throw notFound('AREA_NOT_FOUND', 'Zone introuvable.');
    return area;
  }

  private async findTable(scope: Scope, id: string) {
    const table = await this.prisma.diningTable.findFirst({ where: { id, ...this.where(scope), archivedAt: null } });
    if (!table) throw notFound('TABLE_NOT_FOUND', 'Table introuvable.');
    return table;
  }

  private async assertAreaNameFree(scope: Scope, name: string): Promise<void> {
    const taken = await this.prisma.diningArea.findFirst({
      where: { ...this.where(scope), archivedAt: null, name: { equals: name, mode: 'insensitive' } },
      select: { id: true },
    });
    if (taken) throw conflict('AREA_EXISTS', 'Une zone porte déjà ce nom.');
  }

  private async assertLabelFree(scope: Scope, label: string): Promise<void> {
    const taken = await this.prisma.diningTable.findFirst({
      where: { ...this.where(scope), archivedAt: null, label: { equals: label, mode: 'insensitive' } },
      select: { id: true },
    });
    if (taken) throw conflict('TABLE_EXISTS', 'Une table porte déjà ce nom.');
  }

  private log(tx: Tx, scope: Scope, action: string, entityType: string, entityId: string, metadata?: Record<string, number>) {
    return this.audit.record({ action, ...this.where(scope), actorId: scope.userId, entityType, entityId, metadata, ip: scope.ip }, tx);
  }
}
