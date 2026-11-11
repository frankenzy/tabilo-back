import {
  Body, Controller, Get, Headers, HttpCode, Injectable, Module, Param, ParseUUIDPipe, Post, Query, Res, UseGuards,
} from '@nestjs/common';
import type { FastifyReply } from 'fastify';
import { ApiHeader, ApiOperation, ApiProperty, ApiPropertyOptional, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { rateLimit } from '../../commons/utils/rate-limit';
import { Transform, Type } from 'class-transformer';
import {
  ArrayMaxSize, ArrayMinSize, IsArray, IsInt, IsOptional, IsString, IsUUID, Matches, Max, MaxLength, Min, ValidateNested,
} from 'class-validator';
import { CurrentGuest, Public } from '../../commons/decorators';
import { GuestSessionGuard, SESSION_HEADER } from '../../commons/guards/guest-session.guard';
import { PrismaService } from '../../commons/prisma/prisma.service';
import type { GuestSession } from '../../commons/types';
import { hashToken, randomToken } from '../../commons/utils/crypto';
import { notFound, tooMany, unprocessable } from '../../commons/utils/errors';
import { MenuModule } from '../menu/menu.module';
import { MenuService } from '../menu/menu.service';
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

  @ApiPropertyOptional({ minimum: 1, maximum: 10, description: "Quantité demandée (ex. bouteilles d'eau)" })
  @IsOptional() @IsInt() @Min(1) @Max(10)
  quantity?: number;
}

export class OrderLineDto {
  @ApiProperty() @IsUUID()
  menuItemId: string;

  @ApiProperty({ minimum: 1, maximum: 20 }) @IsInt() @Min(1) @Max(20)
  quantity: number;
}

export class GuestCreateOrderDto {
  @ApiProperty({ type: [OrderLineDto], description: 'Identifiants et quantités seulement : les prix viennent de la carte.' })
  @IsArray() @ArrayMinSize(1) @ArrayMaxSize(30) @ValidateNested({ each: true }) @Type(() => OrderLineDto)
  items: OrderLineDto[];

  @ApiPropertyOptional({ maxLength: NOTE_MAX_LENGTH })
  @IsOptional() @Transform(trim) @IsString() @MaxLength(NOTE_MAX_LENGTH)
  note?: string;
}

export class SuggestionsQueryDto {
  @ApiPropertyOptional({ description: "Identifiants des articles de la commande, séparés par des virgules (30 au plus)" })
  @IsOptional()
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.split(',').map((id) => id.trim()).filter(Boolean) : value,
  )
  @IsArray() @ArrayMaxSize(30) @IsUUID('all', { each: true })
  items?: string[];
}

@Injectable()
export class GuestService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly menu: MenuService,
  ) {}

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
    const [establishment, table, types, menu] = await Promise.all([
      this.prisma.establishment.findUniqueOrThrow({ where: { id: guest.establishmentId }, select: { name: true, currency: true } }),
      this.prisma.diningTable.findUniqueOrThrow({
        where: { id: guest.tableId },
        select: { label: true, area: { select: { name: true } } },
      }),
      this.prisma.requestType.findMany({
        where: { establishmentId: guest.establishmentId, isActive: true, archivedAt: null },
        orderBy: [{ position: 'asc' }, { createdAt: 'asc' }],
        select: { id: true, label: true, icon: true, allowNote: true, kind: true },
      }),
      this.menu.overview(guest.establishmentId),
    ]);
    const categories = menu.filter((category) => category.items.length > 0);
    return {
      establishment: { name: establishment.name, currency: establishment.currency },
      table: { label: table.label, area: table.area.name },
      requestTypes: types.filter((type) => type.kind === 'service').map(({ kind: _kind, ...type }) => type),
      menu: categories,
      // La commande n'est proposée que si la carte existe et que le type « Commande » est actif.
      orderingEnabled: categories.length > 0 && types.some((type) => type.kind === 'order'),
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
    private readonly menu: MenuService,
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
    return this.requests.createByGuest(guest, { kind: 'service', ...dto }, this.key(idempotencyKey));
  }

  @Get('suggestions')
  @UseGuards(GuestSessionGuard)
  @ApiHeader({ name: SESSION_HEADER, required: true })
  @ApiOperation({ summary: 'Articles souvent commandés avec ceux de la commande (6 au plus)' })
  async suggestions(@CurrentGuest() guest: GuestSession, @Query() query: SuggestionsQueryDto) {
    return { menuItemIds: await this.menu.suggestions(guest.establishmentId, query.items ?? []) };
  }

  @Post('orders')
  @HttpCode(200)
  @UseGuards(GuestSessionGuard)
  @Throttle(rateLimit(20, 60_000))
  @ApiHeader({ name: SESSION_HEADER, required: true })
  @ApiHeader({ name: 'idempotency-key', required: false, description: 'Rejouer la même clé renvoie la même commande.' })
  @ApiOperation({ summary: 'Passer une commande depuis la carte' })
  order(
    @CurrentGuest() guest: GuestSession,
    @Body() dto: GuestCreateOrderDto,
    @Headers('idempotency-key') idempotencyKey?: string,
  ) {
    return this.requests.createByGuest(guest, { kind: 'order', ...dto }, this.key(idempotencyKey));
  }

  @Get('menu-images/:id')
  @ApiOperation({ summary: "Photo d'un article de la carte" })
  async image(@Param('id', ParseUUIDPipe) id: string, @Res() reply: FastifyReply): Promise<void> {
    const image = await this.menu.image(id);
    // Une photo ne change jamais sous le même identifiant : cache long, sans revalidation.
    void reply
      .header('content-type', image.mime)
      .header('cache-control', 'public, max-age=31536000, immutable')
      // Photo publique, affichée par le frontend depuis une autre origine (helmet pose same-site par défaut).
      .header('cross-origin-resource-policy', 'cross-origin')
      .send(image.data);
  }

  private key(idempotencyKey?: string): string | null {
    if (idempotencyKey !== undefined && !/^[A-Za-z0-9_-]{8,64}$/.test(idempotencyKey)) {
      throw unprocessable('IDEMPOTENCY_KEY_INVALID', "Clé d'idempotence invalide.");
    }
    return idempotencyKey ?? null;
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
  imports: [ServiceRequestsModule, RealtimeModule, MenuModule],
  controllers: [GuestController],
  providers: [GuestService],
})
export class GuestModule {}
