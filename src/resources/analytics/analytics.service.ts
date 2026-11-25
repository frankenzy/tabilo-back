import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../commons/prisma/prisma.service';
import type { Scope } from '../../commons/types';
import { unprocessable } from '../../commons/utils/errors';

export interface ReportFilters {
  from: Date;
  to: Date;
  areaId?: string;
  assigneeId?: string;
}

interface Totals {
  total: number;
  pending: number;
  active: number;
  resolved: number;
  cancelled: number;
  late: number;
  escalated: number;
  medianAssignSeconds: number | null;
  medianAcceptSeconds: number | null;
  medianStartSeconds: number | null;
  medianResolveSeconds: number | null;
  averageAcceptSeconds: number | null;
  averageResolveSeconds: number | null;
}

interface Breakdown {
  id: string;
  label: string;
  total: number;
  resolved: number;
  late: number;
  medianAcceptSeconds: number | null;
  medianResolveSeconds: number | null;
  amountMinor: number;
}

export interface TodayHour {
  /** Heure locale de l'établissement, « 12:00 ». */
  hour: string;
  waiting: number;
  progress: number;
  ready: number;
  resolved: number;
  cancelled: number;
}

export interface TodayTopItem {
  menuItemId: string;
  name: string;
  quantity: number;
  rank: number;
  /** Rang hier à la même heure ; null si le produit n'était pas commandé (spec 008, R5). */
  previousRank: number | null;
}

export type SalesPeriod = 'month' | 'year';

export interface SalesFigures {
  totalMinor: number;
  orders: number;
  passages: number;
  /** Moyenne par passage à table ; null sans passage (spec 009, R4). */
  averageMinor: number | null;
  /** Spec 026, R7 : commandes réglées pendant la période, datées de leur règlement. */
  paidMinor: number;
  paidOrders: number;
  /** Spec 027, R13 : commandes marquées « Parti sans payer » pendant la période, datées du marquage. */
  writtenOffMinor: number;
  /** Nombre de clients (sessions) concernés. */
  writtenOffCustomers: number;
}

/** Spec 027, R13 : un client parti sans payer, pour la liste de la carte « Impayés ». */
export interface WrittenOffView {
  sessionId: string | null;
  table: { id: string; label: string };
  marker: number | null;
  amountMinor: number;
  writtenOffAt: string;
  writtenOffBy: string | null;
}

/** Spec 026, R7 : commandes servies non réglées, toutes dates confondues. */
export interface Outstanding {
  amountMinor: number;
  orders: number;
  tables: number;
}

export interface SalesOverview {
  currency: string;
  period: SalesPeriod;
  /** Premier jour de la période en cours, « 2026-11-01 ». */
  from: string;
  current: SalesFigures;
  /** Même durée, un mois ou un an plus tôt (R5). */
  previous: SalesFigures;
  outstanding: Outstanding;
}

export const TIMELINE_BUCKETS = ['month', 'day', 'hour'] as const;
export type TimelineBucket = (typeof TIMELINE_BUCKETS)[number];

export interface TimelineFilters {
  bucket: TimelineBucket;
  year?: number;
  month?: number;
  day?: number;
}

export interface TimelineSummary {
  total: number;
  resolved: number;
  cancelled: number;
  late: number;
  escalated: number;
  medianAcceptSeconds: number | null;
  averageAcceptSeconds: number | null;
  medianResolveSeconds: number | null;
  averageResolveSeconds: number | null;
}

export interface Timeline {
  points: TimelinePoint[];
  /** Spec 008, R8 : indicateurs de toute la période (jour, mois ou année choisi). */
  summary: TimelineSummary;
  /** Première année avec une demande : borne basse du filtre Année. */
  firstYear: number;
  /** Date du jour dans le fuseau de l'établissement, « 2026-11-13 » : valeurs par défaut des filtres. */
  today: string;
}

export interface TimelinePoint {
  /** Début de la période, heure locale de l'établissement : « 2026-11-13T14:00 ». */
  period: string;
  waiting: number;
  progress: number;
  ready: number;
  resolved: number;
  cancelled: number;
}

export interface TodayOverview {
  hours: TodayHour[];
  topItems: TodayTopItem[];
}

interface TopItem {
  menuItemId: string;
  name: string;
  quantity: number;
  amountMinor: number;
}

const MAX_RANGE_DAYS = 366;

/**
 * Indicateurs calculés en SQL à partir des horodatages d'étape des demandes, eux-mêmes écrits
 * dans la transaction de chaque transition. Aucune valeur n'est estimée ni simulée.
 *
 * Définitions :
 *  - prise en charge = acceptedAt − createdAt (première acceptation) ;
 *  - résolution     = resolvedAt − createdAt ;
 *  - en retard      = acceptée après dueAt, ou pas encore acceptée alors que dueAt est passé ;
 *  - médiane = percentile_cont(0.5) ; la moyenne est fournie à part et nommée comme telle ;
 *  - montant servi = somme des totalMinor des commandes RÉSOLUES créées dans la période
 *    (ni les annulées ni celles en cours) ; c'est un montant déclaratif, pas un encaissement.
 *
 * Toutes les requêtes filtrent sur tenantId ET establishmentId, tirés du périmètre serveur.
 */
@Injectable()
export class AnalyticsService {
  constructor(private readonly prisma: PrismaService) {}

  /** Situation de la salle à l'instant. */
  async live(scope: Scope) {
    const base = this.scopeSql(scope);
    const [counts] = await this.prisma.$queryRaw<
      { pending: number; assigned: number; accepted: number; inProgress: number; late: number; escalated: number; oldestPendingSeconds: number | null }[]
    >`
      SELECT
        count(*) FILTER (WHERE r.status = 'pending')::int AS pending,
        count(*) FILTER (WHERE r.status = 'assigned')::int AS assigned,
        count(*) FILTER (WHERE r.status = 'accepted')::int AS accepted,
        count(*) FILTER (WHERE r.status IN ('in_progress', 'ready'))::int AS "inProgress",
        count(*) FILTER (WHERE r."acceptedAt" IS NULL AND r."dueAt" < now())::int AS late,
        count(*) FILTER (WHERE r."escalationStatus" = 'escalated')::int AS escalated,
        extract(epoch FROM now() - min(r."createdAt") FILTER (WHERE r.status = 'pending'))::float AS "oldestPendingSeconds"
      FROM "ServiceRequest" r
      WHERE ${base} AND r.status IN ('pending', 'assigned', 'accepted', 'in_progress', 'ready')`;

    const [today] = await this.prisma.$queryRaw<
      { total: number; resolved: number; medianAcceptSeconds: number | null; medianResolveSeconds: number | null }[]
    >`
      SELECT
        count(*)::int AS total,
        count(*) FILTER (WHERE r.status = 'resolved')::int AS resolved,
        percentile_cont(0.5) WITHIN GROUP (ORDER BY extract(epoch FROM r."acceptedAt" - r."createdAt"))
          FILTER (WHERE r."acceptedAt" IS NOT NULL)::float AS "medianAcceptSeconds",
        percentile_cont(0.5) WITHIN GROUP (ORDER BY extract(epoch FROM r."resolvedAt" - r."createdAt"))
          FILTER (WHERE r."resolvedAt" IS NOT NULL)::float AS "medianResolveSeconds"
      FROM "ServiceRequest" r
      JOIN "Establishment" est ON est.id = r."establishmentId"
      WHERE ${base}
        AND r."createdAt" >= date_trunc('day', now() AT TIME ZONE est.timezone) AT TIME ZONE est.timezone`;

    const staff = await this.prisma.$queryRaw<
      { id: string; firstName: string; lastName: string; assigned: number; accepted: number; inProgress: number }[]
    >`
      SELECT u.id, u."firstName", u."lastName",
        count(r.id) FILTER (WHERE r.status = 'assigned')::int AS assigned,
        count(r.id) FILTER (WHERE r.status = 'accepted')::int AS accepted,
        count(r.id) FILTER (WHERE r.status IN ('in_progress', 'ready'))::int AS "inProgress"
      FROM "Membership" m
      JOIN "User" u ON u.id = m."userId" AND u.status = 'active'
      JOIN "Role" ro ON ro.id = m."roleId" AND 'requests.handle' = ANY(ro.permissions)
        AND NOT ('requests.handle' = ANY(m."revokedPermissions"))
      LEFT JOIN "ServiceRequest" r
        ON r."assigneeId" = u.id AND r."establishmentId" = m."establishmentId"
       AND r.status IN ('assigned', 'accepted', 'in_progress', 'ready')
      WHERE m."establishmentId" = ${scope.establishmentId}::uuid AND m."tenantId" = ${scope.tenantId}::uuid
      GROUP BY u.id, u."firstName", u."lastName"
      ORDER BY count(r.id) DESC, u."firstName" ASC`;

    return { ...counts, today, staff, generatedAt: new Date().toISOString() };
  }

  /** Rapport sur une période, avec filtres facultatifs par zone et par membre. */
  async report(scope: Scope, filters: ReportFilters) {
    if (filters.to <= filters.from) throw unprocessable('INVALID_RANGE', 'La période est invalide.');
    if (filters.to.getTime() - filters.from.getTime() > MAX_RANGE_DAYS * 86_400_000) {
      throw unprocessable('RANGE_TOO_LARGE', 'La période ne peut pas dépasser un an.');
    }
    const where = Prisma.sql`${this.scopeSql(scope)}
      AND r."createdAt" >= ${filters.from} AND r."createdAt" < ${filters.to}
      ${filters.areaId ? Prisma.sql`AND r."areaId" = ${filters.areaId}::uuid` : Prisma.empty}
      ${filters.assigneeId ? Prisma.sql`AND r."assigneeId" = ${filters.assigneeId}::uuid` : Prisma.empty}`;

    // Somme en float8 : exacte jusqu'à 2^53, sans le BigInt que renverrait un bigint.
    const served = Prisma.sql`coalesce(sum(r."totalMinor") FILTER (WHERE r.status = 'resolved'), 0)::float8`;
    const late = Prisma.sql`(r."acceptedAt" > r."dueAt" OR (r."acceptedAt" IS NULL AND r.status IN ('pending', 'assigned') AND r."dueAt" < now()))`;
    const median = (column: string) => Prisma.sql`
      percentile_cont(0.5) WITHIN GROUP (ORDER BY extract(epoch FROM r.${Prisma.raw(`"${column}"`)} - r."createdAt"))
        FILTER (WHERE r.${Prisma.raw(`"${column}"`)} IS NOT NULL)::float`;
    const average = (column: string) => Prisma.sql`
      avg(extract(epoch FROM r.${Prisma.raw(`"${column}"`)} - r."createdAt"))
        FILTER (WHERE r.${Prisma.raw(`"${column}"`)} IS NOT NULL)::float`;

    const [totals] = await this.prisma.$queryRaw<Totals[]>`
      SELECT
        count(*)::int AS total,
        count(*) FILTER (WHERE r.status = 'pending')::int AS pending,
        count(*) FILTER (WHERE r.status IN ('assigned', 'accepted', 'in_progress', 'ready'))::int AS active,
        count(*) FILTER (WHERE r.status = 'resolved')::int AS resolved,
        count(*) FILTER (WHERE r.status = 'cancelled')::int AS cancelled,
        count(*) FILTER (WHERE ${late})::int AS late,
        count(*) FILTER (WHERE r."escalatedAt" IS NOT NULL)::int AS escalated,
        ${median('assignedAt')} AS "medianAssignSeconds",
        ${median('acceptedAt')} AS "medianAcceptSeconds",
        ${median('startedAt')} AS "medianStartSeconds",
        ${median('resolvedAt')} AS "medianResolveSeconds",
        ${average('acceptedAt')} AS "averageAcceptSeconds",
        ${average('resolvedAt')} AS "averageResolveSeconds"
      FROM "ServiceRequest" r WHERE ${where}`;

    const breakdown = (join: Prisma.Sql, id: Prisma.Sql, label: Prisma.Sql, limit = 50) =>
      this.prisma.$queryRaw<Breakdown[]>`
        SELECT ${id} AS id, ${label} AS label,
          count(*)::int AS total,
          count(*) FILTER (WHERE r.status = 'resolved')::int AS resolved,
          count(*) FILTER (WHERE ${late})::int AS late,
          ${median('acceptedAt')} AS "medianAcceptSeconds",
          ${median('resolvedAt')} AS "medianResolveSeconds",
          ${served} AS "amountMinor"
        FROM "ServiceRequest" r ${join}
        WHERE ${where}
        GROUP BY 1, 2 ORDER BY total DESC, label ASC LIMIT ${limit}`;

    const hourly = filters.to.getTime() - filters.from.getTime() <= 2 * 86_400_000;
    const bucket = hourly ? 'hour' : 'day';
    const [byType, byArea, byTable, byStaff, series, salesRows, topItems] = await Promise.all([
      breakdown(Prisma.sql`JOIN "RequestType" t ON t.id = r."requestTypeId"`, Prisma.sql`t.id`, Prisma.sql`t.label`),
      breakdown(Prisma.sql`JOIN "DiningArea" a ON a.id = r."areaId"`, Prisma.sql`a.id`, Prisma.sql`a.name`),
      breakdown(Prisma.sql`JOIN "DiningTable" dt ON dt.id = r."tableId"`, Prisma.sql`dt.id`, Prisma.sql`dt.label`, 10),
      breakdown(
        Prisma.sql`JOIN "User" u ON u.id = r."assigneeId"`,
        Prisma.sql`u.id`,
        Prisma.sql`u."firstName" || ' ' || u."lastName"`,
      ),
      this.prisma.$queryRaw<{ bucket: string; total: number; resolved: number; late: number; amountMinor: number }[]>`
        SELECT to_char(date_trunc(${bucket}, r."createdAt" AT TIME ZONE est.timezone), 'YYYY-MM-DD"T"HH24:MI') AS bucket,
          count(*)::int AS total,
          count(*) FILTER (WHERE r.status = 'resolved')::int AS resolved,
          count(*) FILTER (WHERE ${late})::int AS late,
          ${served} AS "amountMinor"
        FROM "ServiceRequest" r JOIN "Establishment" est ON est.id = r."establishmentId"
        WHERE ${where}
        GROUP BY 1 ORDER BY 1`,
      this.prisma.$queryRaw<{ currency: string; orders: number; amountMinor: number }[]>`
        SELECT est.currency,
          count(r.id) FILTER (WHERE r.status = 'resolved' AND r."totalMinor" IS NOT NULL)::int AS orders,
          ${served} AS "amountMinor"
        FROM "Establishment" est
        LEFT JOIN "ServiceRequest" r ON r."establishmentId" = est.id AND ${where}
        WHERE est.id = ${scope.establishmentId}::uuid AND est."tenantId" = ${scope.tenantId}::uuid
        GROUP BY est.currency`,
      // Lignes figées : le montant d'un article est celui facturé à la commande, pas le prix actuel.
      this.prisma.$queryRaw<TopItem[]>`
        SELECT i."menuItemId" AS "menuItemId",
          (array_agg(i.name ORDER BY r."createdAt" DESC))[1] AS name,
          sum(i.quantity)::int AS quantity,
          sum(i.quantity * i."unitPriceMinor")::float8 AS "amountMinor"
        FROM "ServiceRequestItem" i JOIN "ServiceRequest" r ON r.id = i."requestId"
        WHERE ${where} AND r.status = 'resolved'
        GROUP BY i."menuItemId"
        ORDER BY "amountMinor" DESC, name ASC LIMIT 10`,
    ]);
    const salesRow = salesRows[0] ?? { currency: 'XOF', orders: 0, amountMinor: 0 };

    return {
      period: { from: filters.from.toISOString(), to: filters.to.toISOString(), bucket },
      totals,
      byType,
      byArea,
      byTable,
      byStaff,
      series,
      sales: {
        currency: salesRow.currency,
        orders: salesRow.orders,
        amountMinor: salesRow.amountMinor,
        averageMinor: salesRow.orders > 0 ? Math.round(salesRow.amountMinor / salesRow.orders) : null,
        topItems,
      },
    };
  }

  /**
   * Spec 008 : blocs du tableau de bord pour aujourd'hui (fuseau de l'établissement).
   * - hours : demandes par heure de création, réparties selon leur état actuel ;
   * - topItems : 3 produits les plus commandés (hors annulées), avec leur rang hier à la même heure.
   */
  async today(scope: Scope): Promise<TodayOverview> {
    const base = this.scopeSql(scope);
    const midnight = Prisma.sql`(date_trunc('day', now() AT TIME ZONE est.timezone) AT TIME ZONE est.timezone)`;
    const yesterdayMidnight = Prisma.sql`((date_trunc('day', now() AT TIME ZONE est.timezone) - interval '1 day') AT TIME ZONE est.timezone)`;

    const [clock] = await this.prisma.$queryRaw<{ hour: number }[]>`
      SELECT extract(hour FROM now() AT TIME ZONE est.timezone)::int AS hour
      FROM "Establishment" est
      WHERE est.id = ${scope.establishmentId}::uuid AND est."tenantId" = ${scope.tenantId}::uuid`;
    if (!clock) return { hours: [], topItems: [] };

    const rows = await this.prisma.$queryRaw<(Omit<TodayHour, 'hour'> & { hour: number })[]>`
      SELECT extract(hour FROM r."createdAt" AT TIME ZONE est.timezone)::int AS hour,
        count(*) FILTER (WHERE r.status IN ('pending', 'assigned'))::int AS waiting,
        count(*) FILTER (WHERE r.status IN ('accepted', 'in_progress'))::int AS progress,
        count(*) FILTER (WHERE r.status = 'ready')::int AS ready,
        count(*) FILTER (WHERE r.status = 'resolved')::int AS resolved,
        count(*) FILTER (WHERE r.status = 'cancelled')::int AS cancelled
      FROM "ServiceRequest" r JOIN "Establishment" est ON est.id = r."establishmentId"
      WHERE ${base} AND r."createdAt" >= ${midnight}
      GROUP BY 1 ORDER BY 1`;
    const byHour = new Map(rows.map((row) => [row.hour, row]));
    const hours: TodayHour[] = [];
    if (rows.length > 0) {
      // Une barre par heure, de la première heure active jusqu'à l'heure en cours (R2), y compris les heures creuses.
      for (let hour = rows[0].hour; hour <= Math.max(clock.hour, rows[rows.length - 1].hour); hour += 1) {
        const row = byHour.get(hour);
        hours.push({
          hour: `${String(hour).padStart(2, '0')}:00`,
          waiting: row?.waiting ?? 0,
          progress: row?.progress ?? 0,
          ready: row?.ready ?? 0,
          resolved: row?.resolved ?? 0,
          cancelled: row?.cancelled ?? 0,
        });
      }
    }

    const ranking = (from: Prisma.Sql, to: Prisma.Sql) => this.prisma.$queryRaw<{ menuItemId: string; name: string; quantity: number }[]>`
      SELECT i."menuItemId" AS "menuItemId",
        (array_agg(i.name ORDER BY r."createdAt" DESC))[1] AS name,
        sum(i.quantity)::int AS quantity
      FROM "ServiceRequestItem" i
      JOIN "ServiceRequest" r ON r.id = i."requestId"
      JOIN "Establishment" est ON est.id = r."establishmentId"
      WHERE ${base} AND r.status <> 'cancelled' AND r."createdAt" >= ${from} AND r."createdAt" < ${to}
      GROUP BY 1
      ORDER BY sum(i.quantity) DESC, min(r."createdAt") ASC`;
    const [today, yesterday] = await Promise.all([
      ranking(midnight, Prisma.sql`now()`),
      ranking(yesterdayMidnight, Prisma.sql`(now() - interval '1 day')`),
    ]);
    const previous = new Map(yesterday.map((row, index) => [row.menuItemId, index + 1]));
    return {
      hours,
      topItems: today.slice(0, 3).map((row, index) => ({
        menuItemId: row.menuItemId,
        name: row.name,
        quantity: row.quantity,
        rank: index + 1,
        previousRank: previous.get(row.menuItemId) ?? null,
      })),
    };
  }

  /**
   * Spec 008, R7 : demandes par mois (d'une année), par jour (d'un mois) ou par heure (d'un jour),
   * réparties par état actuel. Filtres absents : date du jour dans le fuseau de l'établissement.
   * Chaque période de la plage a sa ligne, même vide (generate_series).
   */
  async timeline(scope: Scope, query: TimelineFilters): Promise<Timeline> {
    const [ctx] = await this.prisma.$queryRaw<{ tz: string; today: string; hour: number; firstYear: number | null }[]>`
      SELECT est.timezone AS tz,
        to_char(now() AT TIME ZONE est.timezone, 'YYYY-MM-DD') AS today,
        extract(hour FROM now() AT TIME ZONE est.timezone)::int AS hour,
        (SELECT extract(year FROM min(r."createdAt") AT TIME ZONE est.timezone)::int FROM "ServiceRequest" r WHERE ${this.scopeSql(scope)}) AS "firstYear"
      FROM "Establishment" est
      WHERE est.id = ${scope.establishmentId}::uuid AND est."tenantId" = ${scope.tenantId}::uuid`;
    if (!ctx) throw unprocessable('ESTABLISHMENT_NOT_FOUND', 'Établissement introuvable.');
    const [ty, tm, td] = ctx.today.split('-').map(Number);
    const year = query.year ?? ty;
    const month = query.month ?? tm;
    const day = query.day ?? td;
    const probe = new Date(Date.UTC(year, month - 1, day));
    if (probe.getUTCFullYear() !== year || probe.getUTCMonth() !== month - 1 || probe.getUTCDate() !== day) {
      throw unprocessable('INVALID_DATE', "Cette date n'existe pas.");
    }

    const pad = (n: number) => String(n).padStart(2, '0');
    const step = { month: '1 month', day: '1 day', hour: '1 hour' }[query.bucket];
    const span = { month: '1 year', day: '1 month', hour: '1 day' }[query.bucket];
    const startText =
      query.bucket === 'month' ? `${year}-01-01` : query.bucket === 'day' ? `${year}-${pad(month)}-01` : `${year}-${pad(month)}-${pad(day)}`;
    const unit = Prisma.raw(`'${query.bucket}'`);
    const points = await this.prisma.$queryRaw<TimelinePoint[]>`
      WITH range AS (
        SELECT ${startText}::timestamp AS start, ${startText}::timestamp + ${span}::interval AS stop
      ),
      periods AS (
        SELECT generate_series(range.start, range.stop - ${step}::interval, ${step}::interval) AS period FROM range
      ),
      counts AS (
        SELECT date_trunc(${unit}, r."createdAt" AT TIME ZONE ${ctx.tz}) AS period,
          count(*) FILTER (WHERE r.status IN ('pending', 'assigned'))::int AS waiting,
          count(*) FILTER (WHERE r.status IN ('accepted', 'in_progress'))::int AS progress,
          count(*) FILTER (WHERE r.status = 'ready')::int AS ready,
          count(*) FILTER (WHERE r.status = 'resolved')::int AS resolved,
          count(*) FILTER (WHERE r.status = 'cancelled')::int AS cancelled
        FROM "ServiceRequest" r, range
        WHERE ${this.scopeSql(scope)}
          -- Bornes converties dans le fuseau, pas la colonne : l'index (établissement, createdAt) reste utilisable.
          AND r."createdAt" >= range.start AT TIME ZONE ${ctx.tz} AND r."createdAt" < range.stop AT TIME ZONE ${ctx.tz}
        GROUP BY 1
      )
      SELECT to_char(p.period, 'YYYY-MM-DD"T"HH24:00') AS period,
        coalesce(c.waiting, 0) AS waiting, coalesce(c.progress, 0) AS progress, coalesce(c.ready, 0) AS ready,
        coalesce(c.resolved, 0) AS resolved, coalesce(c.cancelled, 0) AS cancelled
      FROM periods p LEFT JOIN counts c ON c.period = p.period
      ORDER BY p.period`;

    // Spec 008, R8 : indicateurs de toute la période choisie, calculés comme la page « Statistiques ».
    const late = Prisma.sql`(r."acceptedAt" > r."dueAt" OR (r."acceptedAt" IS NULL AND r.status IN ('pending', 'assigned') AND r."dueAt" < now()))`;
    const median = (column: string) => Prisma.sql`
      percentile_cont(0.5) WITHIN GROUP (ORDER BY extract(epoch FROM r.${Prisma.raw(`"${column}"`)} - r."createdAt"))
        FILTER (WHERE r.${Prisma.raw(`"${column}"`)} IS NOT NULL)::float`;
    const average = (column: string) => Prisma.sql`
      avg(extract(epoch FROM r.${Prisma.raw(`"${column}"`)} - r."createdAt")) FILTER (WHERE r.${Prisma.raw(`"${column}"`)} IS NOT NULL)::float`;
    const [summary] = await this.prisma.$queryRaw<TimelineSummary[]>`
      SELECT count(*)::int AS total,
        count(*) FILTER (WHERE r.status = 'resolved')::int AS resolved,
        count(*) FILTER (WHERE r.status = 'cancelled')::int AS cancelled,
        count(*) FILTER (WHERE ${late})::int AS late,
        count(*) FILTER (WHERE r."escalatedAt" IS NOT NULL)::int AS escalated,
        ${median('acceptedAt')} AS "medianAcceptSeconds",
        ${average('acceptedAt')} AS "averageAcceptSeconds",
        ${median('resolvedAt')} AS "medianResolveSeconds",
        ${average('resolvedAt')} AS "averageResolveSeconds"
      FROM "ServiceRequest" r
      WHERE ${this.scopeSql(scope)}
        AND r."createdAt" >= ${startText}::timestamp AT TIME ZONE ${ctx.tz}
        AND r."createdAt" < (${startText}::timestamp + ${span}::interval) AT TIME ZONE ${ctx.tz}`;

    let result = points;
    if (query.bucket === 'hour') {
      // Heure : de la première à la dernière heure active ; pour aujourd'hui, jusqu'à l'heure en cours (R7).
      const active = points.map((p, i) => (p.waiting + p.progress + p.ready + p.resolved + p.cancelled > 0 ? i : -1)).filter((i) => i >= 0);
      const isToday = startText === ctx.today;
      if (active.length === 0) result = isToday ? points.slice(ctx.hour, ctx.hour + 1) : [];
      else result = points.slice(active[0], Math.max(active[active.length - 1], isToday ? ctx.hour : 0) + 1);
    }
    return { points: result, summary, firstYear: ctx.firstYear ?? ty, today: ctx.today };
  }

  /**
   * Spec 009 : ventes de la période en cours (mois ou année, fuseau de l'établissement), comparées
   * à la même durée de la période précédente. Vendu = commande servie, datée de son service.
   * Passage à table : commandes servies d'une même table, un écart de plus de 2 h ouvre un nouveau passage.
   */
  async sales(scope: Scope, period: SalesPeriod): Promise<SalesOverview> {
    const unit = period === 'month' ? '1 month' : '1 year';
    const trunc = Prisma.raw(`'${period}'`);
    const [row] = await this.prisma.$queryRaw<
      {
        currency: string;
        from: string;
        totals: {
          shift: number; totalMinor: number; orders: number; passages: number; paidMinor: number; paidOrders: number;
          writtenOffMinor: number; writtenOffCustomers: number;
        }[];
        outstanding: { amountMinor: number; orders: number; tables: number };
      }[]
    >`
      WITH est AS (
        SELECT e.currency, e.timezone AS tz, now() AT TIME ZONE e.timezone AS local_now
        FROM "Establishment" e
        WHERE e.id = ${scope.establishmentId}::uuid AND e."tenantId" = ${scope.tenantId}::uuid
      ),
      ranges AS (
        -- shift 0 : période en cours ; shift 1 : même durée, un mois ou un an plus tôt.
        SELECT s AS shift,
          (date_trunc(${trunc}, est.local_now) - s * ${unit}::interval) AT TIME ZONE est.tz AS start,
          (est.local_now - s * ${unit}::interval) AT TIME ZONE est.tz AS stop
        FROM est, generate_series(0, 1) AS s
      ),
      served AS (
        SELECT g.shift, r."tableId", r."createdAt", r."totalMinor",
          CASE WHEN r."createdAt" - lag(r."createdAt") OVER (PARTITION BY g.shift, r."tableId" ORDER BY r."createdAt") <= interval '2 hours'
            THEN 0 ELSE 1 END AS opens
        FROM "ServiceRequest" r
        JOIN ranges g ON r."resolvedAt" >= g.start AND r."resolvedAt" < g.stop
        WHERE ${this.scopeSql(scope)} AND r.status = 'resolved' AND r."totalMinor" IS NOT NULL
      )
      SELECT est.currency,
        to_char(date_trunc(${trunc}, est.local_now), 'YYYY-MM-DD') AS "from",
        (SELECT coalesce(json_agg(t ORDER BY t.shift), '[]'::json) FROM (
          SELECT g.shift,
            coalesce(sum(sv."totalMinor"), 0)::bigint::float8 AS "totalMinor",
            count(sv."totalMinor")::int AS orders,
            coalesce(sum(sv.opens), 0)::int AS passages,
            (SELECT coalesce(sum(r."totalMinor"), 0)::bigint::float8 FROM "ServiceRequest" r
              WHERE ${this.scopeSql(scope)} AND r."totalMinor" IS NOT NULL AND r."paidAt" >= g.start AND r."paidAt" < g.stop) AS "paidMinor",
            (SELECT count(*)::int FROM "ServiceRequest" r
              WHERE ${this.scopeSql(scope)} AND r."totalMinor" IS NOT NULL AND r."paidAt" >= g.start AND r."paidAt" < g.stop) AS "paidOrders",
            -- Spec 027, R13 : impayés de la période, datés de leur marquage ; un client = une session.
            (SELECT coalesce(sum(r."totalMinor"), 0)::bigint::float8 FROM "ServiceRequest" r
              WHERE ${this.scopeSql(scope)} AND r."totalMinor" IS NOT NULL AND r."writtenOffAt" >= g.start AND r."writtenOffAt" < g.stop) AS "writtenOffMinor",
            (SELECT count(DISTINCT coalesce(r."sessionId", r.id))::int FROM "ServiceRequest" r
              WHERE ${this.scopeSql(scope)} AND r."totalMinor" IS NOT NULL AND r."writtenOffAt" >= g.start AND r."writtenOffAt" < g.stop) AS "writtenOffCustomers"
          FROM ranges g LEFT JOIN served sv ON sv.shift = g.shift
          GROUP BY g.shift, g.start, g.stop
        ) t) AS totals,
        -- Spec 026 : reste à encaisser, toutes dates.
        (SELECT json_build_object(
            'amountMinor', coalesce(sum(r."totalMinor"), 0)::bigint::float8,
            'orders', count(*)::int,
            'tables', count(DISTINCT r."tableId")::int)
          FROM "ServiceRequest" r
          WHERE ${this.scopeSql(scope)} AND r.status = 'resolved' AND r."totalMinor" IS NOT NULL AND r."paidAt" IS NULL
            AND r."writtenOffAt" IS NULL) AS outstanding
      FROM est`;
    if (!row) throw unprocessable('ESTABLISHMENT_NOT_FOUND', 'Établissement introuvable.');
    const figures = (shift: number): SalesFigures => {
      const t = row.totals.find((x) => x.shift === shift) ?? {
        totalMinor: 0, orders: 0, passages: 0, paidMinor: 0, paidOrders: 0, writtenOffMinor: 0, writtenOffCustomers: 0,
      };
      return {
        totalMinor: Math.round(t.totalMinor),
        orders: t.orders,
        passages: t.passages,
        averageMinor: t.passages > 0 ? Math.round(t.totalMinor / t.passages) : null,
        paidMinor: Math.round(t.paidMinor),
        paidOrders: t.paidOrders,
        writtenOffMinor: Math.round(t.writtenOffMinor),
        writtenOffCustomers: t.writtenOffCustomers,
      };
    };
    const outstanding = { amountMinor: Math.round(row.outstanding.amountMinor), orders: row.outstanding.orders, tables: row.outstanding.tables };
    return { currency: row.currency, period, from: row.from, current: figures(0), previous: figures(1), outstanding };
  }

  /** Spec 027, R13 : clients partis sans payer pendant la période en cours, le plus récent d'abord. */
  async writtenOff(scope: Scope, period: SalesPeriod): Promise<WrittenOffView[]> {
    const trunc = Prisma.raw(`'${period}'`);
    const rows = await this.prisma.$queryRaw<
      { sessionId: string | null; tableId: string; tableLabel: string; marker: number | null; amountMinor: number; writtenOffAt: Date; writtenOffBy: string | null }[]
    >`
      WITH est AS (
        SELECT (date_trunc(${trunc}, now() AT TIME ZONE e.timezone)) AT TIME ZONE e.timezone AS start
        FROM "Establishment" e
        WHERE e.id = ${scope.establishmentId}::uuid AND e."tenantId" = ${scope.tenantId}::uuid
      )
      SELECT r."sessionId", t.id AS "tableId", t.label AS "tableLabel", s."markerIndex" AS marker,
        sum(r."totalMinor")::int AS "amountMinor", max(r."writtenOffAt") AS "writtenOffAt",
        (SELECT u."firstName" || ' ' || u."lastName" FROM "User" u WHERE u.id = (array_agg(r."writtenOffById" ORDER BY r."writtenOffAt" DESC))[1]) AS "writtenOffBy"
      FROM "ServiceRequest" r
      JOIN est ON true
      JOIN "DiningTable" t ON t.id = r."tableId"
      LEFT JOIN "TableSession" s ON s.id = r."sessionId"
      WHERE ${this.scopeSql(scope)} AND r."totalMinor" IS NOT NULL AND r."writtenOffAt" >= est.start
      GROUP BY r."sessionId", t.id, t.label, s."markerIndex", CASE WHEN r."sessionId" IS NULL THEN r.id END
      ORDER BY max(r."writtenOffAt") DESC
      LIMIT 200`;
    return rows.map((row) => ({
      sessionId: row.sessionId,
      table: { id: row.tableId, label: row.tableLabel },
      marker: row.marker,
      amountMinor: row.amountMinor,
      writtenOffAt: row.writtenOffAt.toISOString(),
      writtenOffBy: row.writtenOffBy,
    }));
  }

  private scopeSql(scope: Scope): Prisma.Sql {
    return Prisma.sql`r."tenantId" = ${scope.tenantId}::uuid AND r."establishmentId" = ${scope.establishmentId}::uuid`;
  }
}
