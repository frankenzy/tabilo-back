import { Module } from '@nestjs/common';
import { AnalyticsController } from './analytics.controller';
import { AnalyticsService } from './analytics.service';
import { ExportsController, ExportsService } from './exports';

@Module({ controllers: [AnalyticsController, ExportsController], providers: [AnalyticsService, ExportsService] })
export class AnalyticsModule {}
