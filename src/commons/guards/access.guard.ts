import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { JwtService } from '@nestjs/jwt';
import { isUUID } from 'class-validator';
import { effectivePermissions, PermissionKey } from '../constants/permissions';
import { ALLOW_SUSPENDED, IS_PUBLIC, REQUIRED_PERMISSIONS } from '../decorators';
import { PrismaService } from '../prisma/prisma.service';
import { AuditService } from '../services/audit.service';
import type { AppRequest } from '../types';
import { forbidden, notFound, unauthorized } from '../utils/errors';

export interface AccessTokenPayload {
  sub: string;
  tid: string;
}

/**
 * Garde global, en trois temps :
 *  1. identification — jeton d'accès valide, compte et tenant actifs ;
 *  2. périmètre — sur /establishments/:establishmentId, l'adhésion est relue en base ;
 *     l'identifiant de l'URL ne vaut jamais autorisation ;
 *  3. permissions — celles du rôle, comparées à @RequirePermissions.
 *
 * Un établissement d'un autre tenant répond 404, comme s'il n'existait pas.
 */
@Injectable()
export class AccessGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly jwt: JwtService,
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    if (context.getType() !== 'http') return true;
    const targets = [context.getHandler(), context.getClass()];
    if (this.reflector.getAllAndOverride<boolean>(IS_PUBLIC, targets)) return true;

    const request = context.switchToHttp().getRequest<AppRequest>();
    const payload = await this.verify(request);
    const establishmentId = (request.params as Record<string, string> | undefined)?.establishmentId;

    const user = await this.prisma.user.findUnique({
      where: { id: payload.sub },
      select: {
        id: true,
        tenantId: true,
        status: true,
        tenant: { select: { status: true, accountState: true } },
      },
    });
    if (!user || user.status !== 'active' || user.tenant.status !== 'active' || user.tenantId !== payload.tid) {
      throw unauthorized('SESSION_INVALID', 'Session invalide. Reconnectez-vous.');
    }
    request.user = { id: user.id, tenantId: user.tenantId };
    // Spec 035, R6 : compte suspendu — seules la page « Abonnement » et les routes hors établissement restent ouvertes.
    const suspended = user.tenant.accountState === 'suspended';

    const required = this.reflector.getAllAndOverride<PermissionKey[]>(REQUIRED_PERMISSIONS, targets) ?? [];
    if (establishmentId === undefined) {
      if (required.length > 0) {
        throw new Error('@RequirePermissions exige une route /establishments/:establishmentId');
      }
      return true;
    }

    const membership = isUUID(establishmentId)
      ? await this.prisma.membership.findFirst({
          where: { userId: user.id, establishmentId, tenantId: user.tenantId, establishment: { archivedAt: null } },
          select: { revokedPermissions: true, role: { select: { key: true, permissions: true } } },
        })
      : null;
    if (!membership) {
      throw notFound('ESTABLISHMENT_NOT_FOUND', 'Établissement introuvable.');
    }
    if (suspended && !this.reflector.getAllAndOverride<boolean>(ALLOW_SUSPENDED, targets)) {
      throw forbidden('ACCOUNT_SUSPENDED', 'Votre abonnement est suspendu. Ouvrez la page « Abonnement » pour le réactiver.');
    }
    // Spec 010 : permissions effectives (rôle moins retraits propres à l'employé).
    const permissions = new Set(effectivePermissions(membership.role.permissions, membership.revokedPermissions));
    const missing = required.filter((permission) => !permissions.has(permission));
    if (missing.length > 0) {
      await this.audit.recordSafely({
        action: 'security.permission_denied',
        tenantId: user.tenantId,
        establishmentId,
        actorId: user.id,
        metadata: { missing, route: request.routeOptions?.url ?? null, method: request.method },
        ip: request.ip,
      });
      throw forbidden('PERMISSION_DENIED', "Vous n'avez pas les droits pour cette action.");
    }
    request.scope = {
      userId: user.id,
      tenantId: user.tenantId,
      establishmentId,
      roleKey: membership.role.key,
      permissions,
      ip: request.ip,
    };
    return true;
  }

  private async verify(request: AppRequest): Promise<AccessTokenPayload> {
    const header = request.headers.authorization;
    const token = header?.startsWith('Bearer ') ? header.slice(7) : undefined;
    if (!token) throw unauthorized('AUTH_REQUIRED', 'Authentification requise.');
    try {
      const payload = await this.jwt.verifyAsync<AccessTokenPayload>(token);
      if (typeof payload.sub !== 'string' || typeof payload.tid !== 'string') throw new Error('payload');
      return payload;
    } catch {
      throw unauthorized('TOKEN_INVALID', 'Jeton invalide ou expiré.');
    }
  }
}
