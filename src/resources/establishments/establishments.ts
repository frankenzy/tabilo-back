import { Body, Controller, Delete, Get, Injectable, Module, Patch, Post, Put } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiProperty, ApiPropertyOptional, ApiTags, PartialType } from '@nestjs/swagger';
import { ServiceMode } from '@prisma/client';
import { Transform } from 'class-transformer';
import { IsBoolean, IsEnum, IsIn, IsInt, IsNumber, IsOptional, IsString, IsTimeZone, Max, MaxLength, Min, MinLength, ValidateIf } from 'class-validator';
import { CurrentScope, CurrentUser, RequirePermissions } from '../../commons/decorators';
import { PrismaService, Tx } from '../../commons/prisma/prisma.service';
import { AuditService } from '../../commons/services/audit.service';
import { PlanService } from '../../commons/services/plan.service';
import type { AuthUser, Scope } from '../../commons/types';
import { forbidden, unprocessable } from '../../commons/utils/errors';
import { decodeImage } from '../menu/menu.service';
import { MenuImageDto } from '../menu/menu.controller';
import { BRAND_COLORS, LOGO_MAX_BYTES, WELCOME_MAX } from './branding';
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

  @ApiPropertyOptional({ enum: ServiceMode, description: 'Spec 030, R1 : façon de servir' })
  @IsOptional() @IsEnum(ServiceMode)
  serviceMode?: ServiceMode;

  @ApiPropertyOptional({ description: 'Spec 030, R9 : lancer la préparation dès l’envoi (sans effet en pay_first)' })
  @IsOptional() @IsBoolean()
  autoStartOrders?: boolean;

  @ApiPropertyOptional({ enum: BRAND_COLORS, description: 'Spec 031, R2 : couleur principale, dans la palette' })
  @IsOptional() @IsIn([...BRAND_COLORS])
  brandColor?: string;

  @ApiPropertyOptional({ nullable: true, description: 'Spec 031, R6 : mot d’accueil, 80 caractères au plus ; vide ou null le retire' })
  @IsOptional() @Transform(({ value }) => (typeof value === 'string' ? value.trim() || null : value))
  @ValidateIf((_, value) => value !== null) @IsString() @MaxLength(WELCOME_MAX)
  welcomeText?: string | null;
}

const SELECT = {
  id: true, name: true, timezone: true, currency: true, address: true, phone: true, sessionTtlMinutes: true,
  maxActiveRequestsPerTable: true, maxRequestsPerSession: true, requestCooldownSeconds: true, separateKitchen: true, pairingsEnabled: true,
  zoneLatitude: true, zoneLongitude: true, zoneRadiusM: true, unpaidAlertMinutes: true, serviceMode: true, autoStartOrders: true,
  logoImageId: true, brandColor: true, welcomeText: true,
} as const;

@Injectable()
export class EstablishmentsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly plans: PlanService,
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

  /** Spec 031, R1 : le logo remplace le précédent, réduit à 100 Ko au plus. */
  async setLogo(scope: Scope, dto: MenuImageDto) {
    const bytes = decodeImage(dto, LOGO_MAX_BYTES);
    return this.prisma.$transaction(async (tx) => {
      const current = await tx.establishment.findFirstOrThrow({ where: { id: scope.establishmentId, tenantId: scope.tenantId }, select: { logoImageId: true } });
      const image = await tx.menuImage.create({
        data: { tenantId: scope.tenantId, establishmentId: scope.establishmentId, mime: dto.mime, data: bytes },
        select: { id: true },
      });
      const updated = await tx.establishment.update({ where: { id: scope.establishmentId }, data: { logoImageId: image.id }, select: SELECT });
      if (current.logoImageId) await tx.menuImage.delete({ where: { id: current.logoImageId } });
      await this.logBranding(tx, scope, 'establishment.logo_updated');
      return updated;
    });
  }

  /** Spec 031, R10 : retirer le logo ; l'initiale du nom revient. */
  async removeLogo(scope: Scope) {
    return this.prisma.$transaction(async (tx) => {
      const current = await tx.establishment.findFirstOrThrow({ where: { id: scope.establishmentId, tenantId: scope.tenantId }, select: { logoImageId: true } });
      const updated = await tx.establishment.update({ where: { id: scope.establishmentId }, data: { logoImageId: null }, select: SELECT });
      if (current.logoImageId) {
        await tx.menuImage.delete({ where: { id: current.logoImageId } });
        await this.logBranding(tx, scope, 'establishment.logo_removed');
      }
      return updated;
    });
  }

  private logBranding(tx: Tx, scope: Scope, action: string) {
    return this.audit.record(
      { action, tenantId: scope.tenantId, establishmentId: scope.establishmentId, actorId: scope.userId, entityType: 'Establishment', entityId: scope.establishmentId, ip: scope.ip },
      tx,
    );
  }

  /** Ouvrir un établissement supplémentaire : réservé aux propriétaires du tenant. */
  async create(user: AuthUser, dto: CreateEstablishmentDto) {
    const ownerRole = await this.prisma.role.findFirstOrThrow({ where: { tenantId: null, key: 'owner' } });
    const isOwner = await this.prisma.membership.findFirst({
      where: { userId: user.id, tenantId: user.tenantId, roleId: ownerRole.id },
      select: { id: true },
    });
    if (!isOwner) throw forbidden('PERMISSION_DENIED', 'Seul un propriétaire peut ouvrir un établissement.');
    // Spec 035, R6 et spec 034, R3 : pas de nouvel établissement si le compte est suspendu ou à sa limite.
    const tenant = await this.prisma.tenant.findUniqueOrThrow({ where: { id: user.tenantId }, select: { accountState: true } });
    if (tenant.accountState === 'suspended') throw forbidden('ACCOUNT_SUSPENDED', 'Votre abonnement est suspendu.');
    await this.plans.assertLimit(user.tenantId, 'establishments');
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

  @Put('establishments/:establishmentId/logo')
  @RequirePermissions('establishment.update')
  @ApiOperation({ summary: 'Spec 031 : logo de l’établissement (JPEG, PNG ou WebP, 100 Ko au plus)' })
  setLogo(@CurrentScope() scope: Scope, @Body() dto: MenuImageDto) {
    return this.establishments.setLogo(scope, dto);
  }

  @Delete('establishments/:establishmentId/logo')
  @RequirePermissions('establishment.update')
  @ApiOperation({ summary: 'Spec 031 : retirer le logo' })
  removeLogo(@CurrentScope() scope: Scope) {
    return this.establishments.removeLogo(scope);
  }
}

@Module({ controllers: [EstablishmentsController], providers: [EstablishmentsService] })
export class EstablishmentsModule {}
