import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import type { AppRequest, GuestSession } from '../types';
import { hashToken } from '../utils/crypto';
import { unauthorized } from '../utils/errors';

export const SESSION_HEADER = 'x-table-session';

/** Résout un jeton de session de table. Partagé par le garde HTTP et la passerelle WebSocket. */
@Injectable()
export class GuestSessionResolver {
  constructor(private readonly prisma: PrismaService) {}

  async resolve(token: unknown): Promise<GuestSession | null> {
    if (typeof token !== 'string' || token.length < 32 || token.length > 128) return null;
    const session = await this.prisma.tableSession.findUnique({
      where: { tokenHash: hashToken(token) },
      select: { id: true, tenantId: true, establishmentId: true, tableId: true, status: true, expiresAt: true },
    });
    if (!session || session.status !== 'open' || session.expiresAt <= new Date()) return null;
    return {
      id: session.id,
      tenantId: session.tenantId,
      establishmentId: session.establishmentId,
      tableId: session.tableId,
    };
  }
}

/**
 * Parcours client : la session de table (jeton opaque, haché en base) remplace le compte.
 * Une session fermée, expirée ou inconnue est refusée de la même façon.
 */
@Injectable()
export class GuestSessionGuard implements CanActivate {
  constructor(private readonly resolver: GuestSessionResolver) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<AppRequest>();
    const guest = await this.resolver.resolve(request.headers[SESSION_HEADER]);
    if (!guest) {
      throw unauthorized('TABLE_SESSION_INVALID', 'Session de table expirée. Scannez à nouveau le QR code.');
    }
    request.guest = guest;
    return true;
  }
}
