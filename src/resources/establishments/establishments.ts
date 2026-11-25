import { Body, Controller, Get, Injectable, Module, Patch, Post } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiProperty, ApiPropertyOptional, ApiTags, PartialType } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsBoolean, IsIn, IsInt, IsNumber, IsOptional, IsString, IsTimeZone, Max, MaxLength, Min, MinLength, ValidateIf } from 'class-validator';
import { CurrentScope, CurrentUser, RequirePermissions } from '../../commons/decorators';
import { PrismaService } from '../../commons/prisma/prisma.service';
import { AuditService } from '../../commons/services/audit.service';
import type { AuthUser, Scope } from '../../commons/types';
import { forbidden, unprocessable } from '../../commons/utils/errors';
import { createEstablishmentDefaults } from './defaults';

/** Devises proposées pour les prix de la carte. */
export const CURRENCIES = ['XOF', 'XAF', 'EUR', 'USD', 'MAD', 'GNF', 'NGN', 'GHS', 'CDF', 'TND', 'DZD', 'CAD', 'CHF', 'GBP'] as const;

const trim = ({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() : value);

export class CreateEstablishmentDto {
  @ApiProperty() @Transform(trim) @IsString() @MinLength(2) @MaxLength(80)
  name: string;

  @ApiPropertyOptional({ example: 'Africa/Abidjan' }) @IsOptional() @IsTimeZone()
  timezone?: string;

  @ApiPropertyOptional() @IsOptional() @Transform(trim) @IsString() @MaxLength(160)
  address?: string;

  @ApiPropertyOptional() @IsOptional() @Transform(trim) @IsString() @MaxLength(30)
  phone?: string;

  @ApiPropertyOptional({ enum: CURRENCIES, description: 'Devise des prix de la carte' })
  @IsOptional() @IsIn([...CURRENCIES])
  currency?: string;
}

export class UpdateEstablishmentDto extends PartialType(CreateEstablishmentDto) {
  @ApiPropertyOptional({ description: 'Durée de vie d’une session de table (minutes)' })
  @IsOptional() @IsInt() @Min(15) @Max(720)
  sessionTtlMinutes?: number;

  @ApiPropertyOptional() @IsOptional() @IsInt() @Min(1) @Max(20)
  maxActiveRequestsPerTable?: number;

  @ApiPropertyOptional() @IsOptional() @IsInt() @Min(1) @Max(200)
  maxRequestsPerSession?: number;

  @ApiPropertyOptional() @IsOptional() @IsInt() @Min(0) @Max(300)
  requestCooldownSeconds?: number;

  @ApiPropertyOptional({ description: 'Cuisine séparée : étape « Prête » des commandes (spec 007)' })
  @IsOptional() @IsBoolean()
  separateKitchen?: boolean;

  @ApiPropertyOptional({ description: "« Souvent pris avec » dans la fiche d'un plat (spec 012, R7)" })
  @IsOptional() @IsBoolean()
  pairingsEnabled?: boolean;

  @ApiPropertyOptional({ nullable: true, description: 'Spec 027, R12 : centre de la zone (avec zoneLongitude) ; null retire la zone' })
  @IsOptional() @ValidateIf((_, value) => value !== null) @IsNumber({ allowNaN: false, allowInfinity: false }) @Min(-90) @Max(90)
  zoneLatitude?: number | null;

  @ApiPropertyOptional({ nullable: true })
  @IsOptional() @ValidateIf((_, value) => value !== null) @IsNumber({ allowNaN: false, allowInfinity: false }) @Min(-180) @Max(180)
  zoneLongitude?: number | null;

  @ApiPropertyOptional({ description: 'Spec 027, R12 : rayon de la zone, de 50 à 500 m' })
  @IsOptional() @IsInt() @Min(50) @Max(500)
  zoneRadiusM?: number;

  @ApiPropertyOptional({ description: 'Spec 027, R12 : délai avant l’alerte de départ sans payer, de 10 à 60 min' })
  @IsOptional() @IsInt() @Min(10) @Max(60)
  unpaidAlertMinutes?: number;
}

const SELECT = {
  id: true, name: true, timezone: true, currency: true, address: true, phone: true, sessionTtlMinutes: true,
  maxActiveRequestsPerTable: true, maxRequestsPerSession: true, requestCooldownSeconds: true, separateKitchen: true, pairingsEnabled: true,
  zoneLatitude: true, zoneLongitude: true, zoneRadiusM: true, unpaidAlertMinutes: true,
} as const;

@Injectable()
export class EstablishmentsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  get(scope: Scope) {
    return this.prisma.establishment.findFirstOrThrow({
      where: { id: scope.establishmentId, tenantId: scope.tenantId },
      select: SELECT,
    });
  }

  async update(scope: Scope, dto: UpdateEstablishmentDto) {
    // Spec 027, R12 : la zone se donne en entier (latitude et longitude) ou se retire en entier.
    const lat = dto.zoneLatitude;
    const lon = dto.zoneLongitude;
    if ((lat === undefined) !== (lon === undefined) || (lat === null) !== (lon === null)) {
      throw unprocessable('ZONE_INCOMPLETE', 'La zone demande une latitude et une longitude.');
    }
    return this.prisma.$transaction(async (tx) => {
      const updated = await tx.establishment.update({ where: { id: scope.establishmentId }, data: dto, select: SELECT });
      await this.audit.record(
        {
          action: 'establishment.updated',
          tenantId: scope.tenantId,
          establishmentId: scope.establishmentId,
          actorId: scope.userId,
          entityType: 'Establishment',
          entityId: scope.establishmentId,
          metadata: { fields: Object.keys(dto) },
          ip: scope.ip,
        },
        tx,
      );
      return updated;
    });
  }

  /** Ouvrir un établissement supplémentaire : réservé aux propriétaires du tenant. */
  async create(user: AuthUser, dto: CreateEstablishmentDto) {
    const ownerRole = await this.prisma.role.findFirstOrThrow({ where: { tenantId: null, key: 'owner' } });
    const isOwner = await this.prisma.membership.findFirst({
      where: { userId: user.id, tenantId: user.tenantId, roleId: ownerRole.id },
      select: { id: true },
    });
    if (!isOwner) throw forbidden('PERMISSION_DENIED', 'Seul un propriétaire peut ouvrir un établissement.');
    return this.prisma.$transaction(async (tx) => {
      const establishment = await tx.establishment.create({
        data: { tenantId: user.tenantId, ...dto, timezone: dto.timezone ?? 'Africa/Abidjan' },
        select: SELECT,
      });
      await tx.membership.create({
        data: { tenantId: user.tenantId, userId: user.id, establishmentId: establishment.id, roleId: ownerRole.id },
      });
      await createEstablishmentDefaults(tx, { tenantId: user.tenantId, establishmentId: establishment.id });
      await this.audit.record(
        {
          action: 'establishment.created',
          tenantId: user.tenantId,
          establishmentId: establishment.id,
          actorId: user.id,
          entityType: 'Establishment',
          entityId: establishment.id,
        },
        tx,
      );
      return establishment;
    });
  }
}

@ApiTags('Établissements')
@ApiBearerAuth()
@Controller({ version: '1' })
export class EstablishmentsController {
  constructor(private readonly establishments: EstablishmentsService) {}

  @Post('establishments')
  @ApiOperation({ summary: 'Ouvrir un établissement supplémentaire (propriétaire)' })
  create(@CurrentUser() user: AuthUser, @Body() dto: CreateEstablishmentDto) {
    return this.establishments.create(user, dto);
  }

  @Get('establishments/:establishmentId')
  get(@CurrentScope() scope: Scope) {
    return this.establishments.get(scope);
  }

  @Patch('establishments/:establishmentId')
  @RequirePermissions('establishment.update')
  update(@CurrentScope() scope: Scope, @Body() dto: UpdateEstablishmentDto) {
    return this.establishments.update(scope, dto);
  }
}

@Module({ controllers: [EstablishmentsController], providers: [EstablishmentsService] })
export class EstablishmentsModule {}
