import { Controller, Get, Header, Injectable, Query, Res } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiProperty, ApiTags } from '@nestjs/swagger';
import { Prisma } from '@prisma/client';
import { Matches } from 'class-validator';
import type { FastifyReply } from 'fastify';
import { CurrentScope, RequirePermissions } from '../../commons/decorators';
import { PrismaService } from '../../commons/prisma/prisma.service';
import { AuditService } from '../../commons/services/audit.service';
import { PlanService } from '../../commons/services/plan.service';
import type { Scope } from '../../commons/types';
import { unprocessable } from '../../commons/utils/errors';

const DATE = /^\d{4}-\d{2}-\d{2}$/;
/** Spec 040, R1 : 92 jours au plus. */
export const MAX_EXPORT_DAYS = 92;

/** Spec 040, R1 : du jour `from` au jour `to` inclus, au fuseau de l'établissement. */
export class PeriodQuery {
  @ApiProperty({ example: '2026-11-01' }) @Matches(DATE)
  from: string;

  @ApiProperty({ example: '2026-11-30' }) @Matches(DATE)
  to: string;
}

/** Spec 030, Q2 : une commande vendue est servie, ou réglée et non annulée ; elle est datée de la première des deux. */
const SOLD = Prisma.sql`r."totalMinor" IS NOT NULL AND (r.status = 'resolved' OR (r."paidAt" IS NOT NULL AND r.status <> 'cancelled'))`;
const SOLD_AT = Prisma.sql`least(r."resolvedAt", r."paidAt")`;

interface OrderRow {
  id: string;
  soldAt: Date;
  tableLabel: string;
  areaName: string;
  server: string | null;
  totalMinor: number;
  paidAt: Date | null;
  writtenOffAt: Date | null;
  items: { name: string; quantity: number; unitPriceMinor: number; listPriceMinor: number | null; offeredAt: string | null; options: { name: string }[] | null; choices: { name: string }[] | null }[];
}

/** Spec 040, R3 : point-virgule, guillemets autour d'un champ qui en contient, BOM UTF-8. */
export function toCsv(rows: (string | number)[][]): string {
  const cell = (value: string | number) => {
    const text = String(value);
    return /[;"\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
  };
  return `\uFEFF${rows.map((row) => row.map(cell).join(';')).join('\r\n')}\r\n`;
}

@Injectable()
export class ExportsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly plans: PlanService,
  ) {}

  /** R1 : bornes de la période en instants, au fuseau de l'établissement. */
  private async bounds(scope: Scope, query: PeriodQuery) {
    const days = (Date.parse(query.to) - Date.parse(query.from)) / 86_400_000 + 1;
    if (!Number.isFinite(days) || days < 1) throw unprocessable('PERIOD_INVALID', 'La date de fin précède la date de début.');
    if (days > MAX_EXPORT_DAYS) throw unprocessable('PERIOD_TOO_LONG', `La période ne peut pas dépasser ${MAX_EXPORT_DAYS} jours.`);
    const [row] = await this.prisma.$queryRaw<{ start: Date; stop: Date; tz: string; name: string; currency: string }[]>`
      SELECT (${query.from}::date)::timestamp AT TIME ZONE e.timezone AS start,
             ((${query.to}::date) + 1)::timestamp AT TIME ZONE e.timezone AS stop,
             e.timezone AS tz, e.name, e.currency
      FROM "Establishment" e WHERE e.id = ${scope.establishmentId}::uuid AND e."tenantId" = ${scope.tenantId}::uuid`;
    return row;
  }

  private async orders(scope: Scope, start: Date, stop: Date): Promise<OrderRow[]> {
    return this.prisma.$queryRaw<OrderRow[]>`
      SELECT r.id, ${SOLD_AT} AS "soldAt", t.label AS "tableLabel", a.name AS "areaName",
        CASE WHEN u.id IS NULL THEN NULL ELSE u."firstName" || ' ' || u."lastName" END AS server,
        r."totalMinor", r."paidAt", r."writtenOffAt",
        (SELECT coalesce(json_agg(json_build_object('name', i.name, 'quantity', i.quantity, 'unitPriceMinor', i."unitPriceMinor",
            'listPriceMinor', i."listPriceMinor", 'offeredAt', (SELECT f."createdAt" FROM "ServiceRequestItemOffer" f WHERE f."itemId" = i.id), 'options', i.options, 'choices', i.choices) ORDER BY i.name), '[]'::json)
          FROM "ServiceRequestItem" i WHERE i."requestId" = r.id) AS items
      FROM "ServiceRequest" r
      JOIN "DiningTable" t ON t.id = r."tableId"
      JOIN "DiningArea" a ON a.id = r."areaId"
      LEFT JOIN "User" u ON u.id = r."assigneeId"
      WHERE r."establishmentId" = ${scope.establishmentId}::uuid AND r."tenantId" = ${scope.tenantId}::uuid
        AND ${SOLD} AND ${SOLD_AT} >= ${start} AND ${SOLD_AT} < ${stop}
      ORDER BY ${SOLD_AT}`;
  }

  /** Spec 040, R2 et R3 : une ligne par commande vendue dans la période. */
  async csv(scope: Scope, query: PeriodQuery): Promise<{ filename: string; body: string }> {
    await this.plans.assertFeature(scope.tenantId, 'exports');
    const period = await this.bounds(scope, query);
    const orders = await this.orders(scope, period.start, period.stop);
    const date = (value: Date) => new Intl.DateTimeFormat('fr-FR', { timeZone: period.tz, day: '2-digit', month: '2-digit', year: 'numeric' }).format(value);
    const time = (value: Date) => new Intl.DateTimeFormat('fr-FR', { timeZone: period.tz, hour: '2-digit', minute: '2-digit' }).format(value);
    const rows: (string | number)[][] = [
      ['Commande', 'Date', 'Heure', 'Table', 'Zone', 'Serveur', 'Articles', 'Montant', 'Offert', 'Remise', 'Réglée le', 'Parti sans payer'],
    ];
    for (const order of orders) {
      const { offered, discount } = this.lineTotals(order);
      rows.push([
        order.id.slice(0, 8).toUpperCase(),
        date(order.soldAt),
        time(order.soldAt),
        order.tableLabel,
        order.areaName,
        order.server ?? '',
        order.items.map((line) => `${line.quantity} × ${line.name}${this.details(line)}`).join(' ; '),
        order.totalMinor,
        offered,
        discount,
        order.paidAt ? `${date(order.paidAt)} ${time(order.paidAt)}` : '',
        order.writtenOffAt ? 'oui' : '',
      ]);
    }
    await this.log(scope, query, 'csv');
    const slug = period.name.normalize('NFD').replace(/[^a-zA-Z0-9]+/g, '-').replace(/^-|-$/g, '').toLowerCase();
    return { filename: `ventes-${slug}-${query.from}-${query.to}.csv`, body: toCsv(rows) };
  }

  /** Spec 040, R4 : récapitulatif de la période, aux mêmes chiffres que le CSV (R5). */
  async summary(scope: Scope, query: PeriodQuery) {
    await this.plans.assertFeature(scope.tenantId, 'exports');
    const period = await this.bounds(scope, query);
    const orders = await this.orders(scope, period.start, period.stop);
    const totalMinor = orders.reduce((sum, order) => sum + order.totalMinor, 0);
    let offeredMinor = 0;
    let discountMinor = 0;
    const products = new Map<string, { name: string; quantity: number; amountMinor: number }>();
    const servers = new Map<string, { name: string; orders: number; amountMinor: number }>();
    for (const order of orders) {
      const { offered, discount } = this.lineTotals(order);
      offeredMinor += offered;
      discountMinor += discount;
      for (const line of order.items) {
        const product = products.get(line.name) ?? { name: line.name, quantity: 0, amountMinor: 0 };
        product.quantity += line.quantity;
        if (!line.offeredAt) product.amountMinor += line.unitPriceMinor * line.quantity;
        products.set(line.name, product);
      }
      const name = order.server ?? 'Sans serveur';
      const server = servers.get(name) ?? { name, orders: 0, amountMinor: 0 };
      server.orders += 1;
      server.amountMinor += order.totalMinor;
      servers.set(name, server);
    }
    const [money] = await this.prisma.$queryRaw<{ paidMinor: number; writtenOffMinor: number }[]>`
      SELECT
        coalesce(sum(r."totalMinor") FILTER (WHERE r."paidAt" >= ${period.start} AND r."paidAt" < ${period.stop}), 0)::float8 AS "paidMinor",
        coalesce(sum(r."totalMinor") FILTER (WHERE r."writtenOffAt" >= ${period.start} AND r."writtenOffAt" < ${period.stop}), 0)::float8 AS "writtenOffMinor"
      FROM "ServiceRequest" r
      WHERE r."establishmentId" = ${scope.establishmentId}::uuid AND r."tenantId" = ${scope.tenantId}::uuid AND r."totalMinor" IS NOT NULL`;
    await this.log(scope, query, 'summary');
    return {
      establishment: period.name,
      currency: period.currency,
      from: query.from,
      to: query.to,
      editedAt: new Date().toISOString(),
      totalMinor,
      orders: orders.length,
      averageMinor: orders.length > 0 ? Math.round(totalMinor / orders.length) : null,
      paidMinor: Math.round(money.paidMinor),
      // Vendu sur la période et pas encore réglé (hors « Parti sans payer »).
      outstandingMinor: orders.filter((order) => !order.paidAt && !order.writtenOffAt).reduce((sum, order) => sum + order.totalMinor, 0),
      offeredMinor,
      discountMinor,
      writtenOffMinor: Math.round(money.writtenOffMinor),
      topProducts: [...products.values()].sort((a, b) => b.amountMinor - a.amountMinor || b.quantity - a.quantity).slice(0, 10),
      servers: [...servers.values()].sort((a, b) => b.amountMinor - a.amountMinor),
    };
  }

  /** Spec 038, R8 bis : ventes de chaque option, sur la période. */
  async optionSales(scope: Scope, query: PeriodQuery) {
    await this.plans.assertFeature(scope.tenantId, 'options');
    const period = await this.bounds(scope, query);
    const rows = await this.prisma.$queryRaw<{ menuItemId: string; item: string; group: string; option: string; quantity: number; amountMinor: number }[]>`
      SELECT i."menuItemId" AS "menuItemId", (array_agg(i.name ORDER BY r."createdAt" DESC))[1] AS item,
        o->>'group' AS "group", o->>'name' AS option,
        sum(i.quantity)::int AS quantity, sum(i.quantity * (o->>'priceMinor')::int)::float8 AS "amountMinor"
      FROM "ServiceRequestItem" i
      JOIN "ServiceRequest" r ON r.id = i."requestId"
      CROSS JOIN LATERAL jsonb_array_elements(i.options) AS o
      WHERE r."establishmentId" = ${scope.establishmentId}::uuid AND r."tenantId" = ${scope.tenantId}::uuid
        AND i.options IS NOT NULL AND NOT EXISTS (SELECT 1 FROM "ServiceRequestItemOffer" f WHERE f."itemId" = i.id)
        AND ${SOLD} AND ${SOLD_AT} >= ${period.start} AND ${SOLD_AT} < ${period.stop}
      GROUP BY i."menuItemId", o->>'group', o->>'name'
      ORDER BY item, "group", quantity DESC`;
    return rows.map((row) => ({ ...row, amountMinor: Math.round(row.amountMinor) }));
  }

  private lineTotals(order: OrderRow): { offered: number; discount: number } {
    let offered = 0;
    let discount = 0;
    for (const line of order.items) {
      if (line.offeredAt) offered += line.unitPriceMinor * line.quantity;
      else if (line.listPriceMinor !== null) discount += (line.listPriceMinor - line.unitPriceMinor) * line.quantity;
    }
    return { offered, discount };
  }

  private details(line: OrderRow['items'][number]): string {
    const parts = [...(line.choices ?? []), ...(line.options ?? [])].map((part) => part.name);
    return `${parts.length ? ` (${parts.join(', ')})` : ''}${line.offeredAt ? ' [offert]' : ''}`;
  }

  /** R6 : chaque export au journal. */
  private log(scope: Scope, query: PeriodQuery, format: 'csv' | 'summary') {
    return this.audit.record({
      action: 'analytics.exported',
      tenantId: scope.tenantId,
      establishmentId: scope.establishmentId,
      actorId: scope.userId,
      metadata: { from: query.from, to: query.to, format },
      ip: scope.ip,
    });
  }
}

@ApiTags('Indicateurs')
@ApiBearerAuth()
@Controller({ path: 'establishments/:establishmentId/analytics', version: '1' })
export class ExportsController {
  constructor(private readonly exports: ExportsService) {}

  @Get('export.csv')
  @RequirePermissions('analytics.read')
  @Header('cache-control', 'no-store')
  @ApiOperation({ summary: 'Spec 040 : commandes vendues de la période, en CSV (point-virgule, UTF-8 avec BOM)' })
  async csv(@CurrentScope() scope: Scope, @Query() query: PeriodQuery, @Res() reply: FastifyReply): Promise<void> {
    const { filename, body } = await this.exports.csv(scope, query);
    void reply
      .header('content-type', 'text/csv; charset=utf-8')
      .header('content-disposition', `attachment; filename="${filename}"`)
      .send(body);
  }

  @Get('summary')
  @RequirePermissions('analytics.read')
  @ApiOperation({ summary: 'Spec 040 : récapitulatif de la période' })
  summary(@CurrentScope() scope: Scope, @Query() query: PeriodQuery) {
    return this.exports.summary(scope, query);
  }

  @Get('options')
  @RequirePermissions('analytics.read')
  @ApiOperation({ summary: 'Spec 038 : ventes par option sur la période' })
  options(@CurrentScope() scope: Scope, @Query() query: PeriodQuery) {
    return this.exports.optionSales(scope, query);
  }
}
