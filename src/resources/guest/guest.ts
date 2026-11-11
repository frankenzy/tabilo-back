import {
  Body, Controller, Get, Headers, HttpCode, Injectable, Module, Param, ParseUUIDPipe, Post, UseGuards,
} from '@nestjs/common';
import { ApiHeader, ApiOperation, ApiProperty, ApiPropertyOptional, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { rateLimit } from '../../commons/utils/rate-limit';
import { Transform } from 'class-transformer';
import { IsOptional, IsString, IsUUID, Matches, MaxLength } from 'class-validator';
import { CurrentGuest, Public } from '../../commons/decorators';
import { GuestSessionGuard, SESSION_HEADER } from '../../commons/guards/guest-session.guard';
import { PrismaService } from '../../commons/prisma/prisma.service';
import type { GuestSession } from '../../commons/types';
import { hashToken, randomToken } from '../../commons/utils/crypto';
import { notFound, tooMany, unprocessable } from '../../commons/utils/errors';
import { RealtimeModule } from '../realtime/realtime.module';
import { NOTE_MAX_LENGTH } from '../service-requests/dto';
import { ServiceRequestsModule } from '../service-requests/service-requests.module';
import { ServiceRequestsService } from '../service-requests/service-requests.service';

const trim = ({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() : value);

/** Sessions ouvrables par table sur 10 minutes : borne l'abus d'un QR photographié. */
const MAX_SESSIONS_PER_TABLE_WINDOW = 20;
const SESSION_WINDOW_MS = 10 * 60_000;

export class OpenSessionDto {
  @ApiProperty({ description: 'Code lu dans le QR de la table' })
  @IsString() @Matches(/^[A-Za-z0-9_-]{16,64}$/)
  code: string;
}

export class GuestCreateRequestDto {
  @ApiProperty() @IsUUID()
  requestTypeId: string;

  @ApiPropertyOptional({ maxLength: NOTE_MAX_LENGTH })
  @IsOptional() @Transform(trim) @IsString() @MaxLength(NOTE_MAX_LENGTH)
  note?: string;
}

@Injectable()
export class GuestService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Ouvre une session de table à partir du QR. Le jeton renvoyé n'existe en clair que chez
   * le client. Il prouve qu'un QR valide a été lu, pas que le client est physiquement à table :
   * d'où les plafonds, le dédoublonnage et la fermeture de session par le personnel.
   */
  async openSession(code: string) {
    const qr = await this.prisma.qrCode.findUnique({
      where: { code },
      include: {
        table: { select: { id: true, archivedAt: true } },
        establishment: { select: { sessionTtlMinutes: true, archivedAt: true, tenant: { select: { status: true } } } },
      },
    });
    if (
      !qr || qr.status !== 'active' || qr.table.archivedAt || qr.establishment.archivedAt ||
      qr.establishment.tenant.status !== 'active'
    ) {
      throw notFound('QR_INVALID', "Ce QR code n'est plus valide. Adressez-vous au personnel.");
    }
    const recent = await this.prisma.tableSession.count({
      where: { tableId: qr.tableId, openedAt: { gt: new Date(Date.now() - SESSION_WINDOW_MS) } },
    });
    if (recent >= MAX_SESSIONS_PER_TABLE_WINDOW) {
      throw tooMany('TOO_MANY_SESSIONS', 'Trop de connexions pour cette table. Réessayez dans quelques minutes.');
    }
    const token = randomToken(32);
    const expiresAt = new Date(Date.now() + qr.establishment.sessionTtlMinutes * 60_000);
    const session = await this.prisma.tableSession.create({
      data: {
        tenantId: qr.tenantId,
        establishmentId: qr.establishmentId,
        tableId: qr.tableId,
        qrCodeId: qr.id,
        tokenHash: hashToken(token),
        expiresAt,
      },
    });
    return { token, expiresAt: expiresAt.toISOString(), ...(await this.context({ ...session })) };
  }

  /** Ce que le client voit : nom du lieu, sa table, les demandes possibles. Rien d'autre. */
  async context(guest: Pick<GuestSession, 'establishmentId' | 'tableId'>) {
    const [establishment, table, requestTypes] = await Promise.all([
      this.prisma.establishment.findUniqueOrThrow({ where: { id: guest.establishmentId }, select: { name: true } }),
      this.prisma.diningTable.findUniqueOrThrow({
        where: { id: guest.tableId },
        select: { label: true, area: { select: { name: true } } },
      }),
      this.prisma.requestType.findMany({
        where: { establishmentId: guest.establishmentId, isActive: true, archivedAt: null },
        orderBy: [{ position: 'asc' }, { createdAt: 'asc' }],
        select: { id: true, label: true, icon: true, allowNote: true },
      }),
    ]);
    return {
      establishment: { name: establishment.name },
      table: { label: table.label, area: table.area.name },
      requestTypes,
    };
  }
}

@ApiTags('Parcours client (sans compte)')
@Public()
@Controller({ path: 'guest', version: '1' })
export class GuestController {
  constructor(
    private readonly guests: GuestService,
    private readonly requests: ServiceRequestsService,
  ) {}

  @Post('sessions')
  @Throttle(rateLimit(12, 60_000))
  @ApiOperation({ summary: 'Ouvrir une session de table après le scan du QR' })
  open(@Body() dto: OpenSessionDto) {
    return this.guests.openSession(dto.code);
  }

  @Get('session')
  @UseGuards(GuestSessionGuard)
  @ApiHeader({ name: SESSION_HEADER, required: true })
  @ApiOperation({ summary: 'Contexte de la session : établissement, table, types de demande' })
  context(@CurrentGuest() guest: GuestSession) {
    return this.guests.context(guest);
  }

  @Get('requests')
  @UseGuards(GuestSessionGuard)
  @ApiHeader({ name: SESSION_HEADER, required: true })
  @ApiOperation({ summary: 'Suivi des demandes de la table (repli HTTP du temps réel)' })
  list(@CurrentGuest() guest: GuestSession) {
    return this.requests.listForGuest(guest);
  }

  @Post('requests')
  @HttpCode(200)
  @UseGuards(GuestSessionGuard)
  @Throttle(rateLimit(20, 60_000))
  @ApiHeader({ name: SESSION_HEADER, required: true })
  @ApiHeader({ name: 'idempotency-key', required: false, description: 'Rejouer la même clé renvoie la même demande.' })
  @ApiOperation({ summary: 'Créer une demande depuis la table' })
  create(
    @CurrentGuest() guest: GuestSession,
    @Body() dto: GuestCreateRequestDto,
    @Headers('idempotency-key') idempotencyKey?: string,
  ) {
    if (idempotencyKey !== undefined && !/^[A-Za-z0-9_-]{8,64}$/.test(idempotencyKey)) {
      throw unprocessable('IDEMPOTENCY_KEY_INVALID', "Clé d'idempotence invalide.");
    }
    return this.requests.createByGuest(guest, dto, idempotencyKey ?? null);
  }

  @Post('requests/:id/cancel')
  @HttpCode(200)
  @UseGuards(GuestSessionGuard)
  @ApiHeader({ name: SESSION_HEADER, required: true })
  @ApiOperation({ summary: 'Annuler sa demande tant qu’elle est en attente' })
  cancel(@CurrentGuest() guest: GuestSession, @Param('id', ParseUUIDPipe) id: string) {
    return this.requests.cancelByGuest(guest, id);
  }
}

@Module({
  imports: [ServiceRequestsModule, RealtimeModule],
  controllers: [GuestController],
  providers: [GuestService],
})
export class GuestModule {}
