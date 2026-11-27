import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { ALLOW_SETTLED_SESSION } from '../decorators';
import { PrismaService } from '../prisma/prisma.service';
import type { AppRequest, GuestSession } from '../types';
import { hashToken } from '../utils/crypto';
import { forbidden, unauthorized } from '../utils/errors';

export const SESSION_HEADER = 'x-table-session';

/** Résout un jeton de session de table. Partagé par le garde HTTP et la passerelle WebSocket. */
@Injectable()
export class GuestSessionResolver {
  constructor(private readonly prisma: PrismaService) {}

  async resolve(token: unknown): Promise<GuestSession | null> {
    const result = await this.inspect(token);
    return result === 'settled' || result === 'suspended' || result === null ? null : result;
  }

  /** Comme `resolve`, mais distingue une session réglée (spec 027, R4) d'une session invalide. */
  async inspect(token: unknown, allowSettled = false): Promise<GuestSession | 'settled' | 'suspended' | null> {
    if (typeof token !== 'string' || token.length < 32 || token.length > 128) return null;
    const session = await this.prisma.tableSession.findUnique({
      where: { tokenHash: hashToken(token) },
      select: {
        id: true, tenantId: true, establishmentId: true, tableId: true, status: true, expiresAt: true, markerIndex: true,
        establishment: { select: { tenant: { select: { accountState: true, status: true } } } },
      },
    });
    if (!session) return null;
    // Spec 035, R6 : compte suspendu, le téléphone affiche l'écran d'indisponibilité.
    // Spec 041, R4 : un compte fermé aussi.
    if (session.establishment.tenant.accountState === 'suspended' || session.establishment.tenant.status !== 'active') return 'suspended';
    const view = {
      id: session.id,
      tenantId: session.tenantId,
      establishmentId: session.establishmentId,
      tableId: session.tableId,
      markerIndex: session.markerIndex,
    };
    if (session.status === 'settled') return allowSettled ? { ...view, settled: true } : 'settled';
    if (session.status !== 'open' || session.expiresAt <= new Date()) return null;
    return view;
  }
}

/**
 * Parcours client : la session de table (jeton opaque, haché en base) remplace le compte.
 * Une session fermée, expirée ou inconnue est refusée de la même façon.
 */
@Injectable()
export class GuestSessionGuard implements CanActivate {
  constructor(
    private readonly resolver: GuestSessionResolver,
    private readonly reflector: Reflector,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<AppRequest>();
    const allowSettled = this.reflector.getAllAndOverride<boolean>(ALLOW_SETTLED_SESSION, [context.getHandler(), context.getClass()]) === true;
    const guest = await this.resolver.inspect(request.headers[SESSION_HEADER], allowSettled);
    if (guest === 'settled') {
      // Spec 027, R4 : le téléphone affiche « Réglé · Merci » et propose une nouvelle session.
      throw unauthorized('TABLE_SESSION_SETTLED', 'Votre note est réglée. Merci !');
    }
    if (guest === 'suspended') {
      throw forbidden('ACCOUNT_SUSPENDED', 'Service momentanément indisponible.');
    }
    if (!guest) {
      throw unauthorized('TABLE_SESSION_INVALID', 'Session de table expirée. Scannez à nouveau le QR code.');
    }
    request.guest = guest;
    return true;
  }
}
