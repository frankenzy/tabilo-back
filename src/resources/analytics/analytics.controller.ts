import { Controller, Get, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiProperty, ApiPropertyOptional, ApiTags } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsDate, IsOptional, IsUUID } from 'class-validator';
import { CurrentScope, RequirePermissions } from '../../commons/decorators';
import type { Scope } from '../../commons/types';
import { AnalyticsService } from './analytics.service';

export class ReportQuery {
  @ApiProperty() @Type(() => Date) @IsDate()
  from: Date;

  @ApiProperty() @Type(() => Date) @IsDate()
  to: Date;

  @ApiPropertyOptional() @IsOptional() @IsUUID()
  areaId?: string;

  @ApiPropertyOptional() @IsOptional() @IsUUID()
  assigneeId?: string;
}

@ApiTags('Indicateurs')
@ApiBearerAuth()
@Controller({ path: 'establishments/:establishmentId/analytics', version: '1' })
export class AnalyticsController {
  constructor(private readonly analytics: AnalyticsService) {}

  @Get('live')
  @RequirePermissions('analytics.read')
  @ApiOperation({ summary: "Situation de la salle à l'instant" })
  live(@CurrentScope() scope: Scope) {
    return this.analytics.live(scope);
  }

  @Get('report')
  @RequirePermissions('analytics.read')
  @ApiOperation({ summary: 'Indicateurs sur une période (médianes, retards, répartitions)' })
  report(@CurrentScope() scope: Scope, @Query() query: ReportQuery) {
    return this.analytics.report(scope, query);
  }
}
