import { Body, Controller, Get, Injectable, Module, Patch, Post } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiProperty, ApiPropertyOptional, ApiTags, PartialType } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsIn, IsInt, IsOptional, IsString, IsTimeZone, Max, MaxLength, Min, MinLength } from 'class-validator';
import { CurrentScope, CurrentUser, RequirePermissions } from '../../commons/decorators';
import { PrismaService } from '../../commons/prisma/prisma.service';
import { AuditService } from '../../commons/services/audit.service';
import type { AuthUser, Scope } from '../../commons/types';
import { forbidden } from '../../commons/utils/errors';
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
}

const SELECT = {
  id: true, name: true, timezone: true, currency: true, address: true, phone: true, sessionTtlMinutes: true,
  maxActiveRequestsPerTable: true, maxRequestsPerSession: true, requestCooldownSeconds: true,
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
