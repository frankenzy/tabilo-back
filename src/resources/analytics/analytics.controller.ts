import { Controller, Get, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiProperty, ApiPropertyOptional, ApiTags } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsDate, IsIn, IsInt, IsOptional, IsUUID, Max, Min } from 'class-validator';
import { CurrentScope, RequirePermissions } from '../../commons/decorators';
import type { Scope } from '../../commons/types';
import { AnalyticsService, TIMELINE_BUCKETS, type SalesPeriod, type TimelineBucket } from './analytics.service';

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

export class TimelineQuery {
  @ApiPropertyOptional({ enum: TIMELINE_BUCKETS, default: 'hour' }) @IsOptional() @IsIn([...TIMELINE_BUCKETS])
  bucket: TimelineBucket = 'hour';

  @ApiPropertyOptional() @IsOptional() @Type(() => Number) @IsInt() @Min(2000) @Max(2100)
  year?: number;

  @ApiPropertyOptional() @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(12)
  month?: number;

  @ApiPropertyOptional() @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(31)
  day?: number;
}

export class SalesQuery {
  @ApiPropertyOptional({ enum: ['month', 'year'], default: 'month' }) @IsOptional() @IsIn(['month', 'year'])
  period: SalesPeriod = 'month';
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

  @Get('today')
  @RequirePermissions('analytics.read')
  @ApiOperation({ summary: "Aujourd'hui : demandes par heure et top 3 des produits (spec 008)" })
  today(@CurrentScope() scope: Scope) {
    return this.analytics.today(scope);
  }

  @Get('timeline')
  @RequirePermissions('analytics.read')
  @ApiOperation({ summary: "Demandes par mois d'une année, par jour d'un mois ou par heure d'un jour, par état actuel (spec 008, R7)" })
  timeline(@CurrentScope() scope: Scope, @Query() query: TimelineQuery) {
    return this.analytics.timeline(scope, query);
  }

  @Get('sales')
  @RequirePermissions('analytics.read')
  @ApiOperation({ summary: 'Ventes du mois ou de l’année en cours, comparées à la période précédente (spec 009)' })
  sales(@CurrentScope() scope: Scope, @Query() query: SalesQuery) {
    return this.analytics.sales(scope, query.period);
  }

  @Get('report')
  @RequirePermissions('analytics.read')
  @ApiOperation({ summary: 'Indicateurs sur une période (médianes, retards, répartitions)' })
  report(@CurrentScope() scope: Scope, @Query() query: ReportQuery) {
    return this.analytics.report(scope, query);
  }
}
