import { Inject, Injectable } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import * as argon2 from 'argon2';
import { randomUUID } from 'node:crypto';
import { APP_ENV, AppEnv } from '../../commons/config/env';
import type { AccessTokenPayload } from '../../commons/guards/access.guard';
import { PrismaService } from '../../commons/prisma/prisma.service';
import { AuditService } from '../../commons/services/audit.service';
import type { AuthUser } from '../../commons/types';
import { hashToken, randomToken } from '../../commons/utils/crypto';
import { conflict, unauthorized, unprocessable } from '../../commons/utils/errors';
import { createEstablishmentDefaults } from '../establishments/defaults';
import { ChangePasswordDto, LoginDto, RegisterDto } from './dto';

const MAX_FAILED_LOGINS = 5;
const LOCK_MINUTES = 15;

export interface ClientContext {
  ip?: string;
  userAgent?: string;
}

export interface IssuedTokens {
  accessToken: string;
  expiresIn: number;
  refreshToken: string;
  refreshExpiresAt: Date;
}

export interface MeView {
  id: string;
  email: string;
  firstName: string;
  lastName: string;
  mustChangePassword: boolean;
  tenant: { id: string; name: string };
  memberships: {
    establishment: { id: string; name: string; timezone: string };
    role: { key: string; name: string };
    permissions: string[];
  }[];
}

export async function hashPassword(password: string): Promise<string> {
  return argon2.hash(password, { type: argon2.argon2id, memoryCost: 19456, timeCost: 2, parallelism: 1 });
}

@Injectable()
export class AuthService {
  /** Empreinte factice : même coût de calcul quand le compte n'existe pas (pas d'oracle temporel). */
  private readonly dummyHash = hashPassword(randomToken());

  constructor(
    private readonly prisma: PrismaService,
    private readonly jwt: JwtService,
    private readonly audit: AuditService,
    @Inject(APP_ENV) private readonly env: AppEnv,
  ) {}

  /** Inscription d'un nouveau client : tenant, premier établissement, compte propriétaire. */
  async register(dto: RegisterDto, client: ClientContext): Promise<IssuedTokens> {
    const existing = await this.prisma.user.findUnique({ where: { email: dto.email }, select: { id: true } });
    if (existing) throw conflict('EMAIL_TAKEN', 'Un compte existe déjà avec cette adresse e-mail.');
    const ownerRole = await this.prisma.role.findFirst({ where: { tenantId: null, key: 'owner' } });
    if (!ownerRole) throw new Error('Rôle système owner absent');
    const passwordHash = await hashPassword(dto.password);

    const user = await this.prisma.$transaction(async (tx) => {
      const tenant = await tx.tenant.create({ data: { name: dto.organizationName } });
      const establishment = await tx.establishment.create({
        data: { tenantId: tenant.id, name: dto.establishmentName, timezone: dto.timezone ?? 'Africa/Abidjan' },
      });
      const created = await tx.user.create({
        data: {
          tenantId: tenant.id,
          email: dto.email,
          passwordHash,
          firstName: dto.firstName,
          lastName: dto.lastName,
        },
      });
      await tx.membership.create({
        data: { tenantId: tenant.id, userId: created.id, establishmentId: establishment.id, roleId: ownerRole.id },
      });
      const scoped = { tenantId: tenant.id, establishmentId: establishment.id };
      await createEstablishmentDefaults(tx, scoped);
      await this.audit.record(
        { action: 'tenant.registered', ...scoped, actorId: created.id, entityType: 'Tenant', entityId: tenant.id, ip: client.ip },
        tx,
      );
      return created;
    });
    return this.issueTokens({ id: user.id, tenantId: user.tenantId }, randomUUID(), client);
  }

  async login(dto: LoginDto, client: ClientContext): Promise<IssuedTokens> {
    const user = await this.prisma.user.findUnique({
      where: { email: dto.email },
      include: { tenant: { select: { status: true } } },
    });
    const invalid = () => unauthorized('INVALID_CREDENTIALS', 'E-mail ou mot de passe incorrect.');
    if (!user) {
      await argon2.verify(await this.dummyHash, dto.password);
      throw invalid();
    }
    if (user.lockedUntil && user.lockedUntil > new Date()) {
      await this.audit.recordSafely({ action: 'security.login_locked', tenantId: user.tenantId, actorId: user.id, ip: client.ip });
      throw unauthorized('ACCOUNT_LOCKED', `Trop de tentatives. Réessayez dans ${LOCK_MINUTES} minutes.`);
    }
    const valid = await argon2.verify(user.passwordHash, dto.password);
    if (!valid) {
      const failed = user.failedLoginCount + 1;
      const lock = failed >= MAX_FAILED_LOGINS;
      await this.prisma.user.update({
        where: { id: user.id },
        data: {
          failedLoginCount: lock ? 0 : failed,
          lockedUntil: lock ? new Date(Date.now() + LOCK_MINUTES * 60_000) : null,
        },
      });
      await this.audit.recordSafely({
        action: lock ? 'security.account_locked' : 'security.login_failed',
        tenantId: user.tenantId,
        actorId: user.id,
        ip: client.ip,
      });
      throw invalid();
    }
    if (user.status !== 'active' || user.tenant.status !== 'active') {
      throw unauthorized('ACCOUNT_DISABLED', 'Ce compte est désactivé.');
    }
    await this.prisma.user.update({
      where: { id: user.id },
      data: { failedLoginCount: 0, lockedUntil: null, lastLoginAt: new Date() },
    });
    await this.audit.recordSafely({ action: 'auth.login', tenantId: user.tenantId, actorId: user.id, ip: client.ip });
    return this.issueTokens({ id: user.id, tenantId: user.tenantId }, randomUUID(), client);
  }

  /**
   * Rotation du refresh token. Chaque jeton ne sert qu'une fois ; présenter un jeton déjà
   * consommé signale un vol : toute la famille de sessions est révoquée.
   */
  async refresh(refreshToken: string | undefined, client: ClientContext): Promise<IssuedTokens> {
    const invalid = () => unauthorized('SESSION_INVALID', 'Session expirée. Reconnectez-vous.');
    if (!refreshToken) throw invalid();
    const session = await this.prisma.refreshSession.findUnique({
      where: { tokenHash: hashToken(refreshToken) },
      include: { user: { select: { id: true, tenantId: true, status: true, tenant: { select: { status: true } } } } },
    });
    if (!session) throw invalid();
    if (session.revokedAt) {
      await this.prisma.refreshSession.updateMany({
        where: { familyId: session.familyId, revokedAt: null },
        data: { revokedAt: new Date() },
      });
      await this.audit.recordSafely({
        action: 'security.refresh_token_reuse',
        tenantId: session.user.tenantId,
        actorId: session.userId,
        ip: client.ip,
      });
      throw invalid();
    }
    if (session.expiresAt <= new Date() || session.user.status !== 'active' || session.user.tenant.status !== 'active') {
      throw invalid();
    }
    // Révocation conditionnelle : deux rafraîchissements simultanés ne passent pas tous les deux.
    const revoked = await this.prisma.refreshSession.updateMany({
      where: { id: session.id, revokedAt: null },
      data: { revokedAt: new Date() },
    });
    if (revoked.count !== 1) throw invalid();
    return this.issueTokens({ id: session.user.id, tenantId: session.user.tenantId }, session.familyId, client);
  }

  async logout(refreshToken: string | undefined): Promise<void> {
    if (!refreshToken) return;
    const session = await this.prisma.refreshSession.findUnique({
      where: { tokenHash: hashToken(refreshToken) },
      select: { familyId: true },
    });
    if (!session) return;
    await this.prisma.refreshSession.updateMany({
      where: { familyId: session.familyId, revokedAt: null },
      data: { revokedAt: new Date() },
    });
  }

  async me(user: AuthUser): Promise<MeView> {
    const row = await this.prisma.user.findUniqueOrThrow({
      where: { id: user.id },
      include: {
        tenant: { select: { id: true, name: true } },
        memberships: {
          where: { establishment: { archivedAt: null } },
          include: {
            establishment: { select: { id: true, name: true, timezone: true } },
            role: { select: { key: true, name: true, permissions: true } },
          },
          orderBy: { createdAt: 'asc' },
        },
      },
    });
    return {
      id: row.id,
      email: row.email,
      firstName: row.firstName,
      lastName: row.lastName,
      mustChangePassword: row.mustChangePassword,
      tenant: row.tenant,
      memberships: row.memberships.map((m) => ({
        establishment: m.establishment,
        role: { key: m.role.key, name: m.role.name },
        permissions: m.role.permissions,
      })),
    };
  }

  /** Changer son mot de passe révoque toutes les sessions, puis en ouvre une nouvelle. */
  async changePassword(user: AuthUser, dto: ChangePasswordDto, client: ClientContext): Promise<IssuedTokens> {
    const row = await this.prisma.user.findUniqueOrThrow({ where: { id: user.id } });
    if (!(await argon2.verify(row.passwordHash, dto.currentPassword))) {
      throw unprocessable('WRONG_PASSWORD', 'Le mot de passe actuel est incorrect.');
    }
    if (dto.currentPassword === dto.newPassword) {
      throw unprocessable('SAME_PASSWORD', "Le nouveau mot de passe doit être différent de l'ancien.");
    }
    const passwordHash = await hashPassword(dto.newPassword);
    await this.prisma.$transaction([
      this.prisma.user.update({ where: { id: user.id }, data: { passwordHash, mustChangePassword: false } }),
      this.prisma.refreshSession.updateMany({ where: { userId: user.id, revokedAt: null }, data: { revokedAt: new Date() } }),
    ]);
    await this.audit.recordSafely({ action: 'auth.password_changed', tenantId: user.tenantId, actorId: user.id, ip: client.ip });
    return this.issueTokens(user, randomUUID(), client);
  }

  private async issueTokens(user: AuthUser, familyId: string, client: ClientContext): Promise<IssuedTokens> {
    const payload: AccessTokenPayload = { sub: user.id, tid: user.tenantId };
    const accessToken = await this.jwt.signAsync(payload);
    const refreshToken = randomToken(48);
    const refreshExpiresAt = new Date(Date.now() + this.env.refreshTtlDays * 86_400_000);
    await this.prisma.refreshSession.create({
      data: {
        userId: user.id,
        familyId,
        tokenHash: hashToken(refreshToken),
        expiresAt: refreshExpiresAt,
        ip: client.ip,
        userAgent: client.userAgent?.slice(0, 255),
      },
    });
    return { accessToken, expiresIn: this.env.jwtAccessTtlSeconds, refreshToken, refreshExpiresAt };
  }
}
