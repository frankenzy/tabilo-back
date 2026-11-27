import { Controller, Get, HttpCode, Injectable, Module, Post, Res } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { randomBytes } from 'node:crypto';
import type { FastifyReply } from 'fastify';
import { LEGAL_VERSION } from '../../commons/constants/legal';
import { AllowSuspended, CurrentScope, CurrentUser } from '../../commons/decorators';
import { PrismaService, Tx } from '../../commons/prisma/prisma.service';
import { AuditService } from '../../commons/services/audit.service';
import type { AuthUser, Scope } from '../../commons/types';
import { forbidden, tooMany } from '../../commons/utils/errors';
import { zip } from '../../commons/utils/zip';
import { toCsv } from '../analytics/exports';

const EXPORT_EVERY_MS = 3_600_000;
const DAY_MS = 86_400_000;
const MIME_EXT: Record<string, string> = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp' };

/**
 * Spec 041, R4 : ordre d'effacement d'un compte, des tables qui référencent vers celles qui sont référencées.
 * Restent : le compte anonymisé et ses paiements d'abonnement (comptabilité de l'éditeur), le journal de la plateforme.
 */
const ERASE_ORDER = [
  'LoyaltyStamp', 'LoyaltyRedemption', 'LoyaltyCard', 'LoyaltyProgram',
  'ServiceRequestEvent', 'ServiceRequestItemOffer', 'ServiceRequestItem', 'ServiceAssignment', 'Notification', 'UnpaidAlert', 'OutboxEvent',
  'ServiceRequest', 'TableSession', 'QrCode', 'EscalationRule', 'DiningTable', 'RequestType', 'DiningArea',
  'MenuOption', 'MenuOptionGroup', 'MenuBundleGroup', 'MenuItem', 'MenuCategory', 'Membership',
] as const;

@Injectable()
export class PrivacyService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  /** R2 : le propriétaire accepte la version en vigueur. */
  async acceptTerms(user: AuthUser): Promise<{ termsVersion: string }> {
    await this.assertOwnerOfTenant(user);
    await this.prisma.tenant.update({ where: { id: user.tenantId }, data: { termsVersion: LEGAL_VERSION, termsAcceptedAt: new Date() } });
    await this.audit.record({ action: 'legal.terms_accepted', tenantId: user.tenantId, actorId: user.id, metadata: { version: LEGAL_VERSION } });
    return { termsVersion: LEGAL_VERSION };
  }

  /** R3 : toutes les données du compte, sans secret, en CSV et JSON ; une fois par heure au plus. */
  async export(scope: Scope): Promise<{ filename: string; body: Buffer }> {
    if (scope.roleKey !== 'owner') throw forbidden('OWNER_ONLY', 'Seul le propriétaire télécharge les données du compte.');
    const tenantId = scope.tenantId;
    const now = new Date();
    const reserved = await this.prisma.tenant.updateMany({
      where: { id: tenantId, OR: [{ lastExportAt: null }, { lastExportAt: { lt: new Date(now.getTime() - EXPORT_EVERY_MS) } }] },
      data: { lastExportAt: now },
    });
    if (reserved.count !== 1) throw tooMany('EXPORT_TOO_SOON', 'Un export a déjà été fait il y a moins d’une heure.');

    const where = { tenantId };
    const [tenant, establishments, categories, items, areas, tables, users, memberships, roles, orders, payments, audit, images] = await Promise.all([
      this.prisma.tenant.findUniqueOrThrow({ where: { id: tenantId }, select: { id: true, name: true, plan: true, accountState: true, paidUntil: true, createdAt: true, termsVersion: true, termsAcceptedAt: true } }),
      this.prisma.establishment.findMany({ where }),
      this.prisma.menuCategory.findMany({ where }),
      this.prisma.menuItem.findMany({ where, include: { bundleGroups: true, optionGroups: { include: { options: true } } } }),
      this.prisma.diningArea.findMany({ where }),
      this.prisma.diningTable.findMany({ where }),
      this.prisma.user.findMany({ where, select: { id: true, email: true, firstName: true, lastName: true, status: true, createdAt: true } }),
      this.prisma.membership.findMany({ where, select: { userId: true, establishmentId: true, roleId: true, revokedPermissions: true } }),
      this.prisma.role.findMany({ where: { OR: [{ tenantId }, { tenantId: null }] }, select: { id: true, key: true, name: true, permissions: true } }),
      this.prisma.serviceRequest.findMany({ where: { ...where, totalMinor: { not: null } }, include: { items: true, table: { select: { label: true } } }, orderBy: { createdAt: 'asc' } }),
      this.prisma.subscriptionPayment.findMany({ where }),
      this.prisma.auditLog.findMany({ where, select: { action: true, actorId: true, establishmentId: true, entityType: true, entityId: true, metadata: true, createdAt: true } }),
      this.prisma.menuImage.findMany({ where, select: { id: true, mime: true, data: true } }),
    ]);
    const files: { name: string; data: Buffer | string }[] = [
      {
        name: 'carte.csv',
        data: toCsv([
          ['Établissement', 'Rubrique', 'Article', 'Prix', 'Prix promo', 'Disponible', 'Formule'],
          ...items.map((item) => [
            establishments.find((e) => e.id === item.establishmentId)?.name ?? '',
            categories.find((c) => c.id === item.categoryId)?.name ?? '',
            item.name, item.priceMinor, item.promoPriceMinor ?? '', item.isAvailable ? 'oui' : 'non', item.isBundle ? 'oui' : 'non',
          ]),
        ]),
      },
      {
        name: 'tables.csv',
        data: toCsv([['Établissement', 'Zone', 'Table', 'Places'], ...tables.map((t) => [
          establishments.find((e) => e.id === t.establishmentId)?.name ?? '', areas.find((a) => a.id === t.areaId)?.name ?? '', t.label, t.seats,
        ])]),
      },
      {
        name: 'equipe.csv',
        data: toCsv([['Prénom', 'Nom', 'E-mail', 'État', 'Rôle'], ...users.map((u) => [
          u.firstName, u.lastName, u.email, u.status,
          memberships.filter((m) => m.userId === u.id).map((m) => roles.find((r) => r.id === m.roleId)?.name ?? '').join(', '),
        ])]),
      },
      {
        name: 'commandes.csv',
        data: toCsv([['Commande', 'Créée le', 'Table', 'État', 'Montant', 'Réglée le', 'Articles'], ...orders.map((o) => [
          o.id, o.createdAt.toISOString(), o.table.label, o.status, o.totalMinor ?? 0, o.paidAt?.toISOString() ?? '',
          o.items.map((i) => `${i.quantity} × ${i.name}`).join(' ; '),
        ])]),
      },
      {
        name: 'paiements-abonnement.csv',
        data: toCsv([['Reçu', 'Date', 'Montant', 'Moyen', 'Mois', 'Formule', 'Annulé'], ...payments.map((p) => [
          p.number, p.createdAt.toISOString(), p.amountMinor, p.method, p.months, p.plan, p.cancelledAt ? 'oui' : '',
        ])]),
      },
      {
        name: 'donnees.json',
        data: JSON.stringify(
          { exportedAt: now.toISOString(), tenant, establishments, categories, items, areas, tables, users, memberships, roles, orders, payments, audit },
          (_, value: unknown) => (typeof value === 'bigint' ? value.toString() : value),
          2,
        ),
      },
      ...images.map((image) => ({ name: `photos/${image.id}.${MIME_EXT[image.mime] ?? 'bin'}`, data: Buffer.from(image.data) })),
    ];
    await this.audit.record({ action: 'privacy.exported', tenantId, establishmentId: scope.establishmentId, actorId: scope.userId, ip: scope.ip });
    const slug = tenant.name.normalize('NFD').replace(/[^a-zA-Z0-9]+/g, '-').replace(/^-|-$/g, '').toLowerCase();
    return { filename: `tabilo-${slug}-${now.toISOString().slice(0, 10)}.zip`, body: zip(files, now) };
  }

  /** R4 : efface les comptes fermés dont le délai est écoulé. */
  async eraseDue(now = new Date()): Promise<number> {
    const due = await this.prisma.tenant.findMany({ where: { closedAt: { not: null }, erasedAt: null, deleteAfter: { lte: now } }, select: { id: true } });
    for (const tenant of due) await this.prisma.$transaction((tx) => this.erase(tx, tenant.id, now), { timeout: 60_000 });
    return due.length;
  }

  /** R4 : effacement définitif ; restent le compte anonymisé et ses paiements d'abonnement anonymes. */
  async erase(tx: Tx, tenantId: string, now = new Date()): Promise<void> {
    // Seule exception aux tables append-only, limitée à cette transaction (migration `effacement`).
    await tx.$executeRaw`SELECT set_config('tabilo.allow_erasure', 'on', true)`;
    for (const table of ERASE_ORDER) {
      await tx.$executeRawUnsafe(`DELETE FROM "${table}" WHERE "tenantId" = $1::uuid`, tenantId);
    }
    await tx.$executeRaw`DELETE FROM "RefreshSession" WHERE "userId" IN (SELECT id FROM "User" WHERE "tenantId" = ${tenantId}::uuid)`;
    await tx.$executeRaw`DELETE FROM "PasswordResetToken" WHERE "userId" IN (SELECT id FROM "User" WHERE "tenantId" = ${tenantId}::uuid)`;
    await tx.$executeRaw`DELETE FROM "User" WHERE "tenantId" = ${tenantId}::uuid`;
    await tx.$executeRaw`DELETE FROM "Role" WHERE "tenantId" = ${tenantId}::uuid`;
    await tx.$executeRaw`DELETE FROM "Establishment" WHERE "tenantId" = ${tenantId}::uuid`;
    await tx.$executeRaw`DELETE FROM "MenuImage" WHERE "tenantId" = ${tenantId}::uuid`;
    await tx.$executeRaw`DELETE FROM "AuditLog" WHERE "tenantId" = ${tenantId}::uuid`;
    await tx.subscriptionPayment.updateMany({ where: { tenantId }, data: { reference: null } });
    await tx.tenant.update({ where: { id: tenantId }, data: { name: 'Compte supprimé', erasedAt: now, closeReason: null } });
  }

  /** R6 : purge des données personnelles qui ne servent plus. */
  async purge(now = new Date()): Promise<void> {
    const months = (count: number) => new Date(now.getTime() - count * 30 * DAY_MS);
    // Le journal est append-only : la purge des IP passe par l'exception d'effacement, limitée à sa transaction.
    await this.prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT set_config('tabilo.allow_erasure', 'on', true)`;
      await tx.auditLog.updateMany({ where: { ip: { not: null }, createdAt: { lt: months(12) } }, data: { ip: null } });
    });
    await this.prisma.serviceRequest.updateMany({
      where: { createdAt: { lt: new Date(now.getTime() - 90 * DAY_MS) }, OR: [{ zoneCheck: { not: null } }, { zoneDistanceM: { not: null } }] },
      data: { zoneCheck: null, zoneDistanceM: null },
    });
    const stale = await this.prisma.user.findMany({
      where: { status: 'disabled', updatedAt: { lt: months(24) }, NOT: { email: { endsWith: '@supprime.invalid' } } },
      select: { id: true },
      take: 500,
    });
    for (const user of stale) {
      await this.prisma.user.update({
        where: { id: user.id },
        data: { email: `ancien-${user.id}@supprime.invalid`, firstName: 'Ancien', lastName: 'membre', passwordHash: `!${randomBytes(24).toString('hex')}` },
      });
    }
  }

  private async assertOwnerOfTenant(user: AuthUser): Promise<void> {
    const owner = await this.prisma.membership.findFirst({ where: { userId: user.id, tenantId: user.tenantId, role: { key: 'owner', tenantId: null } }, select: { id: true } });
    if (!owner) throw forbidden('OWNER_ONLY', 'Seul le propriétaire accepte les conditions pour le compte.');
  }
}

@ApiTags('Données personnelles')
@ApiBearerAuth()
@Controller({ version: '1' })
export class PrivacyController {
  constructor(private readonly privacy: PrivacyService) {}

  @Post('auth/accept-terms')
  @HttpCode(200)
  @ApiOperation({ summary: 'Spec 041, R2 : le propriétaire accepte la version en vigueur des conditions' })
  acceptTerms(@CurrentUser() user: AuthUser) {
    return this.privacy.acceptTerms(user);
  }

  @Get('establishments/:establishmentId/subscription/export')
  @AllowSuspended()
  @ApiOperation({ summary: 'Spec 041, R3 : toutes les données du compte en ZIP (propriétaire, une fois par heure)' })
  async export(@CurrentScope() scope: Scope, @Res() reply: FastifyReply): Promise<void> {
    const { filename, body } = await this.privacy.export(scope);
    void reply
      .header('content-type', 'application/zip')
      .header('content-disposition', `attachment; filename="${filename}"`)
      .header('cache-control', 'no-store')
      .send(body);
  }
}

@Module({ controllers: [PrivacyController], providers: [PrivacyService], exports: [PrivacyService] })
export class PrivacyModule {}
