import { Body, Controller, Delete, Get, HttpCode, Injectable, Module, Param, ParseUUIDPipe, Patch, Post } from '@nestjs/common';
import { ApiBearerAuth, ApiProperty, ApiPropertyOptional, ApiTags, PartialType } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsBoolean, IsIn, IsInt, IsOptional, IsString, Max, MaxLength, Min, MinLength } from 'class-validator';
import { RequestPriority } from '@prisma/client';
import { CurrentScope, RequirePermissions } from '../../commons/decorators';
import { PrismaService } from '../../commons/prisma/prisma.service';
import { AuditService } from '../../commons/services/audit.service';
import type { Scope } from '../../commons/types';
import { conflict, notFound } from '../../commons/utils/errors';

const trim = ({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() : value);

/** Icônes proposées au gérant. Le frontend associe chaque clé à une icône Lucide. */
export const REQUEST_TYPE_ICONS = [
  'bell', 'droplet', 'receipt', 'life-buoy', 'message-circle', 'utensils', 'coffee', 'ice-cream',
  'wine', 'sparkles', 'baby', 'accessibility', 'flame', 'shopping-bag',
] as const;

export class CreateRequestTypeDto {
  @ApiProperty() @Transform(trim) @IsString() @MinLength(2) @MaxLength(40)
  label: string;

  @ApiProperty({ enum: REQUEST_TYPE_ICONS }) @IsIn([...REQUEST_TYPE_ICONS])
  icon: string;

  @ApiPropertyOptional({ enum: RequestPriority }) @IsOptional() @IsIn(['normal', 'high'])
  priority?: RequestPriority;

  @ApiProperty({ description: 'Délai cible de prise en charge, en secondes.', minimum: 30, maximum: 3600 })
  @IsInt() @Min(30) @Max(3600)
  slaSeconds: number;

  @ApiPropertyOptional() @IsOptional() @IsBoolean()
  allowNote?: boolean;

  @ApiPropertyOptional() @IsOptional() @IsBoolean()
  isActive?: boolean;

  @ApiPropertyOptional() @IsOptional() @IsInt() @Min(0) @Max(1000)
  position?: number;
}

export class UpdateRequestTypeDto extends PartialType(CreateRequestTypeDto) {}

const SELECT = {
  id: true, label: true, kind: true, icon: true, priority: true, slaSeconds: true, allowNote: true, isActive: true, position: true,
} as const;

@Injectable()
export class RequestTypesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  list(scope: Scope) {
    return this.prisma.requestType.findMany({
      where: { ...this.where(scope), archivedAt: null },
      orderBy: [{ position: 'asc' }, { createdAt: 'asc' }],
      select: SELECT,
    });
  }

  async create(scope: Scope, dto: CreateRequestTypeDto) {
    const last = await this.prisma.requestType.aggregate({
      where: { ...this.where(scope), archivedAt: null },
      _max: { position: true },
    });
    return this.prisma.$transaction(async (tx) => {
      const type = await tx.requestType.create({
        data: { ...this.where(scope), ...dto, position: dto.position ?? (last._max.position ?? -1) + 1 },
        select: SELECT,
      });
      await this.audit.record({ action: 'request_type.created', ...this.ctx(scope), entityType: 'RequestType', entityId: type.id }, tx);
      return type;
    });
  }

  async update(scope: Scope, id: string, dto: UpdateRequestTypeDto) {
    await this.find(scope, id);
    return this.prisma.$transaction(async (tx) => {
      const type = await tx.requestType.update({ where: { id }, data: dto, select: SELECT });
      await this.audit.record({ action: 'request_type.updated', ...this.ctx(scope), entityType: 'RequestType', entityId: id }, tx);
      return type;
    });
  }

  /** Archive : les demandes passées gardent leur type. */
  async archive(scope: Scope, id: string): Promise<void> {
    const type = await this.find(scope, id);
    if (type.kind === 'order') {
      throw conflict('ORDER_TYPE_REQUIRED', 'Le type « Commande » ne se supprime pas. Masquez-le pour suspendre les commandes.');
    }
    // Spec 028, R1 : la demande d'addition se renomme ou se désactive, elle ne se supprime pas.
    if (type.kind === 'bill') {
      throw conflict('BILL_TYPE_REQUIRED', "La demande « L'addition » ne se supprime pas. Masquez-la pour la suspendre.");
    }
    await this.prisma.$transaction(async (tx) => {
      await tx.requestType.update({ where: { id }, data: { archivedAt: new Date(), isActive: false } });
      await this.audit.record({ action: 'request_type.archived', ...this.ctx(scope), entityType: 'RequestType', entityId: id }, tx);
    });
  }

  private async find(scope: Scope, id: string) {
    const type = await this.prisma.requestType.findFirst({ where: { id, ...this.where(scope), archivedAt: null } });
    if (!type) throw notFound('REQUEST_TYPE_NOT_FOUND', 'Type de demande introuvable.');
    return type;
  }

  private where(scope: Scope) {
    return { tenantId: scope.tenantId, establishmentId: scope.establishmentId };
  }

  private ctx(scope: Scope) {
    return { ...this.where(scope), actorId: scope.userId, ip: scope.ip };
  }
}

@ApiTags('Types de demande')
@ApiBearerAuth()
@Controller({ path: 'establishments/:establishmentId/request-types', version: '1' })
export class RequestTypesController {
  constructor(private readonly types: RequestTypesService) {}

  @Get()
  @RequirePermissions('requests.read')
  list(@CurrentScope() scope: Scope) {
    return this.types.list(scope);
  }

  @Post()
  @RequirePermissions('request_types.manage')
  create(@CurrentScope() scope: Scope, @Body() dto: CreateRequestTypeDto) {
    return this.types.create(scope, dto);
  }

  @Patch(':id')
  @RequirePermissions('request_types.manage')
  update(@CurrentScope() scope: Scope, @Param('id', ParseUUIDPipe) id: string, @Body() dto: UpdateRequestTypeDto) {
    return this.types.update(scope, id, dto);
  }

  @Delete(':id')
  @HttpCode(204)
  @RequirePermissions('request_types.manage')
  archive(@CurrentScope() scope: Scope, @Param('id', ParseUUIDPipe) id: string) {
    return this.types.archive(scope, id);
  }
}

@Module({ controllers: [RequestTypesController], providers: [RequestTypesService] })
export class RequestTypesModule {}
