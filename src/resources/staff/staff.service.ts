import { Injectable } from '@nestjs/common';
import { effectivePermissions, isPermissionKey } from '../../commons/constants/permissions';
import { PrismaService, Tx } from '../../commons/prisma/prisma.service';
import { AuditService } from '../../commons/services/audit.service';
import type { Scope } from '../../commons/types';
import { conflict, forbidden, notFound, unprocessable } from '../../commons/utils/errors';
import { hashPassword } from '../auth/auth.service';

export interface StaffView {
  id: string;
  email: string;
  firstName: string;
  lastName: string;
  status: 'active' | 'disabled';
  mustChangePassword: boolean;
  lastLoginAt: string | null;
  role: { id: string; key: string; name: string };
  /** Spec 010 : toutes les permissions du rôle (bornes de l'ajustement). */
  rolePermissions: string[];
  /** Permissions effectives : rôle moins retraits. */
  permissions: string[];
  /** Permissions retirées à cet employé ; vide = rôle complet. */
  revokedPermissions: string[];
  canHandleRequests: boolean;
}

export interface CreateStaffInput {
  email: string;
  firstName: string;
  lastName: string;
  roleId: string;
  password: string;
}

export interface UpdateStaffInput {
  firstName?: string;
  lastName?: string;
  roleId?: string;
  status?: 'active' | 'disabled';
  password?: string;
}

const INCLUDE = { user: true, role: { select: { id: true, key: true, name: true, permissions: true } } } as const;

@Injectable()
export class StaffService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  async list(scope: Scope): Promise<StaffView[]> {
    const members = await this.prisma.membership.findMany({
      where: { establishmentId: scope.establishmentId, tenantId: scope.tenantId },
      include: INCLUDE,
      orderBy: { user: { firstName: 'asc' } },
    });
    return members.map((m) => this.toView(m));
  }

  /**
   * Crée un membre avec un mot de passe initial choisi par le gérant.
   * Le membre doit le changer à sa première connexion (mustChangePassword).
   */
  async create(scope: Scope, dto: CreateStaffInput): Promise<StaffView> {
    const role = await this.assignableRole(scope, dto.roleId);
    const taken = await this.prisma.user.findUnique({ where: { email: dto.email }, select: { id: true } });
    if (taken) throw conflict('EMAIL_TAKEN', 'Un compte existe déjà avec cette adresse e-mail.');
    const passwordHash = await hashPassword(dto.password);
    const membership = await this.prisma.$transaction(async (tx) => {
      const user = await tx.user.create({
        data: {
          tenantId: scope.tenantId,
          email: dto.email,
          firstName: dto.firstName,
          lastName: dto.lastName,
          passwordHash,
          mustChangePassword: true,
        },
      });
      const created = await tx.membership.create({
        data: { tenantId: scope.tenantId, userId: user.id, establishmentId: scope.establishmentId, roleId: role.id },
        include: INCLUDE,
      });
      await this.log(tx, scope, 'staff.created', user.id, { role: role.key });
      return created;
    });
    return this.toView(membership);
  }

  async update(scope: Scope, userId: string, dto: UpdateStaffInput): Promise<StaffView> {
    const membership = await this.find(scope, userId);
    // Seul un propriétaire peut modifier un propriétaire.
    if (membership.role.key === 'owner' && scope.roleKey !== 'owner') {
      throw forbidden('OWNER_PROTECTED', 'Seul un propriétaire peut modifier ce compte.');
    }
    const isSelf = userId === scope.userId;
    if (isSelf && (dto.status === 'disabled' || (dto.roleId && dto.roleId !== membership.roleId))) {
      throw unprocessable('SELF_CHANGE_FORBIDDEN', 'Vous ne pouvez pas modifier votre propre rôle ni vous désactiver.');
    }
    const role = dto.roleId && dto.roleId !== membership.roleId ? await this.assignableRole(scope, dto.roleId) : null;
    const losesOwnership =
      membership.role.key === 'owner' && ((role && role.key !== 'owner') || dto.status === 'disabled');
    if (losesOwnership) await this.assertAnotherOwner(scope, userId);
    const passwordHash = dto.password ? await hashPassword(dto.password) : undefined;

    const updated = await this.prisma.$transaction(async (tx) => {
      await tx.user.update({
        where: { id: userId },
        data: {
          firstName: dto.firstName,
          lastName: dto.lastName,
          status: dto.status,
          passwordHash,
          mustChangePassword: passwordHash ? true : undefined,
          failedLoginCount: passwordHash ? 0 : undefined,
          lockedUntil: passwordHash ? null : undefined,
        },
      });
      // Spec 010, R5 : un nouveau rôle repart complet, sans les retraits de l'ancien.
      if (role) await tx.membership.update({ where: { id: membership.id }, data: { roleId: role.id, revokedPermissions: [] } });
      // Désactivation, changement de rôle ou de mot de passe : les sessions ouvertes tombent.
      if (dto.status === 'disabled' || passwordHash || role) {
        await tx.refreshSession.updateMany({ where: { userId, revokedAt: null }, data: { revokedAt: new Date() } });
      }
      await this.log(tx, scope, 'staff.updated', userId, {
        role: role?.key ?? null,
        status: dto.status ?? null,
        passwordReset: Boolean(passwordHash),
      });
      return tx.membership.findUniqueOrThrow({ where: { id: membership.id }, include: INCLUDE });
    });
    return this.toView(updated);
  }

  /**
   * Spec 010 : ajuste les permissions d'un employé dans les limites de son rôle.
   * `wanted` est l'ensemble effectif voulu ; on enregistre ce qui est retiré par rapport au rôle.
   */
  async setPermissions(scope: Scope, userId: string, wanted: string[]): Promise<StaffView> {
    const membership = await this.find(scope, userId);
    if (userId === scope.userId) {
      throw unprocessable('SELF_CHANGE_FORBIDDEN', 'Vous ne pouvez pas ajuster vos propres permissions.');
    }
    if (membership.role.key === 'owner') {
      throw forbidden('OWNER_PROTECTED', 'Un propriétaire garde toujours toutes ses permissions.');
    }
    const role = membership.role.permissions.filter(isPermissionKey);
    const outside = wanted.filter((permission) => !role.includes(permission as never));
    if (outside.length > 0) {
      throw unprocessable('PERMISSION_OUTSIDE_ROLE', 'Une permission demandée ne fait pas partie du rôle de cet employé.');
    }
    const before = new Set(effectivePermissions(membership.role.permissions, membership.revokedPermissions));
    const after = new Set(wanted);
    // R3 : on ne change l'état que des permissions que l'on détient soi-même.
    const touched = role.filter((permission) => before.has(permission) !== after.has(permission));
    if (touched.some((permission) => !scope.permissions.has(permission))) {
      throw forbidden('PRIVILEGE_ESCALATION', 'Vous ne pouvez ajuster que des permissions que vous détenez vous-même.');
    }
    const revoked = role.filter((permission) => !after.has(permission));
    const updated = await this.prisma.$transaction(async (tx) => {
      await tx.membership.update({ where: { id: membership.id }, data: { revokedPermissions: revoked } });
      // R6 : ses sessions ouvertes tombent, ses droits se rechargent à la reconnexion.
      if (touched.length > 0) {
        await tx.refreshSession.updateMany({ where: { userId, revokedAt: null }, data: { revokedAt: new Date() } });
      }
      await this.log(tx, scope, 'staff.permissions_updated', userId, { revoked: revoked.join(',') || null });
      return tx.membership.findUniqueOrThrow({ where: { id: membership.id }, include: INCLUDE });
    });
    return this.toView(updated);
  }

  private async find(scope: Scope, userId: string) {
    const membership = await this.prisma.membership.findFirst({
      where: { userId, establishmentId: scope.establishmentId, tenantId: scope.tenantId },
      include: INCLUDE,
    });
    if (!membership) throw notFound('STAFF_NOT_FOUND', 'Membre introuvable.');
    return membership;
  }

  /** Un rôle n'est attribuable que si toutes ses permissions sont détenues par l'acteur. */
  private async assignableRole(scope: Scope, roleId: string) {
    const role = await this.prisma.role.findFirst({
      where: { id: roleId, OR: [{ tenantId: null }, { tenantId: scope.tenantId }] },
    });
    if (!role) throw notFound('ROLE_NOT_FOUND', 'Rôle introuvable.');
    const exceeds = role.permissions.filter(isPermissionKey).some((p) => !scope.permissions.has(p));
    if (exceeds || (role.key === 'owner' && scope.roleKey !== 'owner')) {
      throw forbidden('PRIVILEGE_ESCALATION', 'Vous ne pouvez pas attribuer un rôle plus élevé que le vôtre.');
    }
    return role;
  }

  private async assertAnotherOwner(scope: Scope, userId: string): Promise<void> {
    const others = await this.prisma.membership.count({
      where: {
        establishmentId: scope.establishmentId,
        userId: { not: userId },
        role: { key: 'owner', tenantId: null },
        user: { status: 'active' },
      },
    });
    if (others === 0) throw conflict('LAST_OWNER', "L'établissement doit garder au moins un propriétaire actif.");
  }

  private log(tx: Tx, scope: Scope, action: string, entityId: string, metadata: Record<string, string | boolean | null>) {
    return this.audit.record(
      {
        action,
        tenantId: scope.tenantId,
        establishmentId: scope.establishmentId,
        actorId: scope.userId,
        entityType: 'User',
        entityId,
        metadata,
        ip: scope.ip,
      },
      tx,
    );
  }

  private toView(m: {
    user: { id: string; email: string; firstName: string; lastName: string; status: 'active' | 'disabled'; mustChangePassword: boolean; lastLoginAt: Date | null };
    role: { id: string; key: string; name: string; permissions: string[] };
    revokedPermissions: string[];
  }): StaffView {
    const permissions = effectivePermissions(m.role.permissions, m.revokedPermissions);
    return {
      id: m.user.id,
      email: m.user.email,
      firstName: m.user.firstName,
      lastName: m.user.lastName,
      status: m.user.status,
      mustChangePassword: m.user.mustChangePassword,
      lastLoginAt: m.user.lastLoginAt ? m.user.lastLoginAt.toISOString() : null,
      role: { id: m.role.id, key: m.role.key, name: m.role.name },
      rolePermissions: m.role.permissions.filter(isPermissionKey),
      permissions,
      revokedPermissions: m.revokedPermissions.filter((p) => m.role.permissions.includes(p)),
      canHandleRequests: permissions.includes('requests.handle'),
    };
  }
}
