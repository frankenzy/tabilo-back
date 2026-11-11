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
        count(*) FILTER (WHERE r.status = 'in_progress')::int AS "inProgress",
        count(*) FILTER (WHERE r."acceptedAt" IS NULL AND r."dueAt" < now())::int AS late,
        count(*) FILTER (WHERE r."escalationStatus" = 'escalated')::int AS escalated,
        extract(epoch FROM now() - min(r."createdAt") FILTER (WHERE r.status = 'pending'))::float AS "oldestPendingSeconds"
      FROM "ServiceRequest" r
      WHERE ${base} AND r.status IN ('pending', 'assigned', 'accepted', 'in_progress')`;

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
        count(r.id) FILTER (WHERE r.status = 'in_progress')::int AS "inProgress"
      FROM "Membership" m
      JOIN "User" u ON u.id = m."userId" AND u.status = 'active'
      JOIN "Role" ro ON ro.id = m."roleId" AND 'requests.handle' = ANY(ro.permissions)
      LEFT JOIN "ServiceRequest" r
        ON r."assigneeId" = u.id AND r."establishmentId" = m."establishmentId"
       AND r.status IN ('assigned', 'accepted', 'in_progress')
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
        count(*) FILTER (WHERE r.status IN ('assigned', 'accepted', 'in_progress'))::int AS active,
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

  private scopeSql(scope: Scope): Prisma.Sql {
    return Prisma.sql`r."tenantId" = ${scope.tenantId}::uuid AND r."establishmentId" = ${scope.establishmentId}::uuid`;
  }
}
