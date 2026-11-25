import { isAllowedOrigin } from '../../commons/utils/origins';
import { Logger, OnModuleInit } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { OnGatewayInit, WebSocketGateway, WebSocketServer } from '@nestjs/websockets';
import { isUUID } from 'class-validator';
import type { Server, Socket } from 'socket.io';
import { loadEnv } from '../../commons/config/env';
import type { AccessTokenPayload } from '../../commons/guards/access.guard';
import { GuestSessionResolver } from '../../commons/guards/guest-session.guard';
import { PrismaService } from '../../commons/prisma/prisma.service';
import { DomainEvent, OutboxService } from '../outbox/outbox.service';
import { ServiceRequestsService } from '../service-requests/service-requests.service';
import { isPerSession, toGuestRequestView, toRequestView } from '../service-requests/request.views';

const staffRoom = (establishmentId: string) => `est:${establishmentId}`;
const tableRoom = (tableId: string) => `table:${tableId}`;
const sessionRoom = (sessionId: string) => `session:${sessionId}`;

/**
 * Passerelle temps réel (Socket.IO).
 *
 * Aucune connexion anonyme : la poignée de main exige soit un jeton d'accès du personnel
 * et un établissement dont il est membre, soit un jeton de session de table valide.
 * Les salons sont attribués par le serveur ; un client ne peut pas en rejoindre un lui-même
 * (aucun message entrant n'est écouté).
 *
 * Le temps réel n'est qu'un accélérateur : les clients resynchronisent par HTTP à la
 * (re)connexion et dédupliquent par `eventId`.
 */
@WebSocketGateway({
  cors: {
    origin: (origin: string | undefined, callback: (error: Error | null, allow?: boolean) => void) => {
      callback(null, isAllowedOrigin(origin, loadEnv()));
    },
    credentials: true,
  },
})
export class RealtimeGateway implements OnGatewayInit, OnModuleInit {
  private readonly logger = new Logger(RealtimeGateway.name);

  @WebSocketServer()
  private server: Server;

  constructor(
    private readonly jwt: JwtService,
    private readonly prisma: PrismaService,
    private readonly guests: GuestSessionResolver,
    private readonly outbox: OutboxService,
    private readonly requests: ServiceRequestsService,
  ) {}

  onModuleInit(): void {
    this.outbox.registerHandler('realtime', (event, tx) => this.broadcast(event, tx));
  }

  afterInit(server: Server): void {
    server.use((socket, next) => {
      this.authenticate(socket)
        .then(() => next())
        .catch(() => next(new Error('UNAUTHORIZED')));
    });
  }

  private async authenticate(socket: Socket): Promise<void> {
    const auth = socket.handshake.auth as Record<string, unknown>;
    if (typeof auth.sessionToken === 'string') {
      const guest = await this.guests.resolve(auth.sessionToken);
      if (!guest) throw new Error('session');
      await socket.join([tableRoom(guest.tableId), sessionRoom(guest.id)]);
      return;
    }
    if (typeof auth.token !== 'string' || typeof auth.establishmentId !== 'string' || !isUUID(auth.establishmentId)) {
      throw new Error('credentials');
    }
    const payload = await this.jwt.verifyAsync<AccessTokenPayload>(auth.token);
    const membership = await this.prisma.membership.findFirst({
      where: {
        userId: payload.sub,
        establishmentId: auth.establishmentId,
        tenantId: payload.tid,
        user: { status: 'active' },
        role: { permissions: { has: 'requests.read' } },
        NOT: { revokedPermissions: { has: 'requests.read' } },
      },
      select: { id: true },
    });
    if (!membership) throw new Error('membership');
    await socket.join(staffRoom(auth.establishmentId));
    // Le jeton d'accès expire : la connexion aussi. Le client se reconnecte avec un jeton frais.
    const exp = (payload as AccessTokenPayload & { exp?: number }).exp;
    if (exp) {
      const timer = setTimeout(() => socket.disconnect(true), Math.max(exp * 1000 - Date.now(), 0));
      socket.on('disconnect', () => clearTimeout(timer));
    }
  }

  private async broadcast(event: DomainEvent, tx: Parameters<ServiceRequestsService['loadForBroadcast']>[0]) {
    if (!this.server) return;
    if (event.type === 'session.closed' || event.type === 'session.settled') {
      for (const sessionId of event.sessionIds ?? []) {
        // Spec 027, R4 : « session.settled » fait afficher « Réglé · Merci » au téléphone.
        this.server.to(sessionRoom(sessionId)).emit(event.type, { eventId: event.eventId });
        this.server.in(sessionRoom(sessionId)).disconnectSockets(true);
      }
      // Le personnel rafraîchit la vue « Tables » et la fiche de table.
      this.server.to(staffRoom(event.establishmentId)).emit('session.changed', { eventId: event.eventId, type: event.type });
      return;
    }
    if (event.type === 'alert.changed') {
      // Spec 027, R9 : identifiant seulement ; le tableau de bord relit les alertes avec ses droits.
      this.server.to(staffRoom(event.establishmentId)).emit('alert.changed', { eventId: event.eventId, alertId: event.alertId });
      return;
    }
    if (!event.requestId) return;
    // État courant relu en base : un rejeu tardif diffuse la vérité du moment, pas un instantané périmé.
    const request = await this.requests.loadForBroadcast(tx, event.requestId);
    if (!request || request.establishmentId !== event.establishmentId) return;
    const envelope = { eventId: event.eventId, type: event.type, occurredAt: event.occurredAt.toISOString() };
    this.server.to(staffRoom(request.establishmentId)).emit('request.changed', {
      ...envelope,
      actorId: event.actorId ?? null,
      request: toRequestView(request),
    });
    if (event.type !== 'request.escalated' && event.type !== 'request.escalation_acknowledged') {
      // Spec 027, R1 : une commande (ou « L'addition ») ne va qu'au téléphone de son client.
      const room = isPerSession(request) && request.sessionId ? sessionRoom(request.sessionId) : tableRoom(request.tableId);
      this.server.to(room).emit('request.changed', {
        ...envelope,
        request: toGuestRequestView(request),
      });
    }
  }

  /** Supervision. */
  connectedClients(): number {
    return this.server?.engine?.clientsCount ?? 0;
  }
}
