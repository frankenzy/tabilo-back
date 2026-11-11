import { Controller, Get, Injectable, Module, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiPropertyOptional, ApiTags } from '@nestjs/swagger';
import { IsOptional, IsString, MaxLength } from 'class-validator';
import { CurrentScope, RequirePermissions } from '../../commons/decorators';
import { PrismaService } from '../../commons/prisma/prisma.service';
import type { Scope } from '../../commons/types';
import { PaginationQuery, skipTake, toPage } from '../../commons/utils/pagination';

export class AuditQuery extends PaginationQuery {
  @ApiPropertyOptional({ description: "Préfixe d'action, ex. « security. » ou « staff. »" })
  @IsOptional() @IsString() @MaxLength(60)
  action?: string;
}

@Injectable()
export class AuditLogsService {
  constructor(private readonly prisma: PrismaService) {}

  async list(scope: Scope, query: AuditQuery) {
    const where = {
      tenantId: scope.tenantId,
      establishmentId: scope.establishmentId,
      action: query.action ? { startsWith: query.action } : undefined,
    };
    const [rows, total] = await Promise.all([
      this.prisma.auditLog.findMany({ where, orderBy: { createdAt: 'desc' }, ...skipTake(query) }),
      this.prisma.auditLog.count({ where }),
    ]);
    const actorIds = [...new Set(rows.map((r) => r.actorId).filter((id): id is string => !!id))];
    const actors = await this.prisma.user.findMany({
      where: { id: { in: actorIds }, tenantId: scope.tenantId },
      select: { id: true, firstName: true, lastName: true },
    });
    const names = new Map(actors.map((a) => [a.id, `${a.firstName} ${a.lastName}`]));
    const items = rows.map((row) => ({
      id: row.id,
      action: row.action,
      actorName: row.actorId ? (names.get(row.actorId) ?? null) : null,
      entityType: row.entityType,
      entityId: row.entityId,
      metadata: row.metadata,
      createdAt: row.createdAt.toISOString(),
    }));
    return toPage(items, total, query);
  }
}

@ApiTags("Journal d'audit")
@ApiBearerAuth()
@Controller({ path: 'establishments/:establishmentId/audit-logs', version: '1' })
export class AuditLogsController {
  constructor(private readonly logs: AuditLogsService) {}

  @Get()
  @RequirePermissions('audit.read')
  list(@CurrentScope() scope: Scope, @Query() query: AuditQuery) {
    return this.logs.list(scope, query);
  }
}

@Module({ controllers: [AuditLogsController], providers: [AuditLogsService] })
export class AuditLogsModule {}
