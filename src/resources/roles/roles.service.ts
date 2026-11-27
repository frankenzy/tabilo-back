import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { isPermissionKey, PERMISSIONS, PermissionKey, SYSTEM_ROLES } from '../../commons/constants/permissions';
import { PrismaService } from '../../commons/prisma/prisma.service';
import { PlanService } from '../../commons/services/plan.service';
import { AuditService } from '../../commons/services/audit.service';
import type { Scope } from '../../commons/types';
import { conflict, forbidden, notFound, unprocessable } from '../../commons/utils/errors';

export interface RoleView {
  id: string;
  key: string;
  name: string;
  isSystem: boolean;
  permissions: string[];
  members: number;
}

@Injectable()
export class RolesService implements OnModuleInit {
  private readonly logger = new Logger(RolesService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly plans: PlanService,
  ) {}

  /** Aligne les rôles système sur la matrice du code à chaque démarrage (idempotent). */
  async onModuleInit(): Promise<void> {
    for (const definition of SYSTEM_ROLES) {
      const existing = await this.prisma.role.findFirst({ where: { tenantId: null, key: definition.key } });
      const data = { name: definition.name, permissions: definition.permissions, isSystem: true };
      if (existing) await this.prisma.role.update({ where: { id: existing.id }, data });
      else await this.prisma.role.create({ data: { ...data, key: definition.key } });
    }
    this.logger.log('Rôles système synchronisés');
  }

  catalog(): { key: string; description: string }[] {
    return Object.entries(PERMISSIONS).map(([key, description]) => ({ key, description }));
  }

  async list(scope: Scope): Promise<RoleView[]> {
    const roles = await this.prisma.role.findMany({
      where: { OR: [{ tenantId: null }, { tenantId: scope.tenantId }] },
      include: { _count: { select: { memberships: { where: { tenantId: scope.tenantId } } } } },
      orderBy: [{ isSystem: 'desc' }, { createdAt: 'asc' }],
    });
    return roles.map((role) => ({
      id: role.id,
      key: role.key,
      name: role.name,
      isSystem: role.isSystem,
      permissions: role.permissions,
      members: role._count.memberships,
    }));
  }

  async create(scope: Scope, dto: { name: string; permissions: string[] }): Promise<RoleView> {
    // Spec 034, R4 : rôles personnalisés réservés aux formules qui les comprennent.
    await this.plans.assertFeature(scope.tenantId, 'custom_roles');
    const permissions = this.sanitize(scope, dto.permissions);
    const key = `custom-${dto.name.toLowerCase().normalize('NFD').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')}`;
    const duplicate = await this.prisma.role.findFirst({ where: { tenantId: scope.tenantId, key } });
    if (duplicate) throw conflict('ROLE_EXISTS', 'Un rôle porte déjà ce nom.');
    const role = await this.prisma.$transaction(async (tx) => {
      const created = await tx.role.create({ data: { tenantId: scope.tenantId, key, name: dto.name, permissions } });
      await this.audit.record(
        { action: 'role.created', ...this.ctx(scope), entityType: 'Role', entityId: created.id, metadata: { permissions } },
        tx,
      );
      return created;
    });
    return { ...role, members: 0 };
  }

  async update(scope: Scope, id: string, dto: { name?: string; permissions?: string[] }): Promise<RoleView> {
    const role = await this.findCustom(scope, id);
    const permissions = dto.permissions ? this.sanitize(scope, dto.permissions) : undefined;
    const updated = await this.prisma.$transaction(async (tx) => {
      const result = await tx.role.update({ where: { id: role.id }, data: { name: dto.name, permissions } });
      await this.audit.record(
        { action: 'role.updated', ...this.ctx(scope), entityType: 'Role', entityId: id, metadata: { permissions: permissions ?? null } },
        tx,
      );
      return result;
    });
    const members = await this.prisma.membership.count({ where: { roleId: id } });
    return { ...updated, members };
  }

  async remove(scope: Scope, id: string): Promise<void> {
    const role = await this.findCustom(scope, id);
    const members = await this.prisma.membership.count({ where: { roleId: role.id } });
    if (members > 0) throw conflict('ROLE_IN_USE', 'Ce rôle est encore attribué à des membres.');
    await this.prisma.$transaction(async (tx) => {
      await tx.role.delete({ where: { id: role.id } });
      await this.audit.record({ action: 'role.deleted', ...this.ctx(scope), entityType: 'Role', entityId: id }, tx);
    });
  }

  private async findCustom(scope: Scope, id: string) {
    const role = await this.prisma.role.findFirst({ where: { id, OR: [{ tenantId: scope.tenantId }, { tenantId: null }] } });
    if (!role) throw notFound('ROLE_NOT_FOUND', 'Rôle introuvable.');
    if (role.isSystem || role.tenantId === null) {
      throw forbidden('SYSTEM_ROLE', 'Les rôles système ne sont pas modifiables.');
    }
    return role;
  }

  /** Nul ne peut accorder une permission qu'il ne détient pas lui-même. */
  private sanitize(scope: Scope, permissions: string[]): PermissionKey[] {
    const unique = [...new Set(permissions)];
    const unknown = unique.filter((p) => !isPermissionKey(p));
    if (unknown.length > 0) throw unprocessable('UNKNOWN_PERMISSION', `Permission inconnue : ${unknown.join(', ')}`);
    const valid = unique.filter(isPermissionKey);
    if (valid.some((p) => !scope.permissions.has(p))) {
      throw forbidden('PRIVILEGE_ESCALATION', 'Vous ne pouvez pas accorder une permission que vous ne détenez pas.');
    }
    return valid;
  }

  private ctx(scope: Scope) {
    return { tenantId: scope.tenantId, establishmentId: scope.establishmentId, actorId: scope.userId, ip: scope.ip };
  }
}
