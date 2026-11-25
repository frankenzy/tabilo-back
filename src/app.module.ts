import { Module } from '@nestjs/common';
import { APP_FILTER, APP_GUARD, APP_INTERCEPTOR } from '@nestjs/core';
import { ScheduleModule } from '@nestjs/schedule';
import { ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';
import { CommonsModule } from './commons/commons.module';
import { AllExceptionsFilter } from './commons/filters/all-exceptions.filter';
import { AccessGuard } from './commons/guards/access.guard';
import { LoggingInterceptor } from './commons/interceptors/logging.interceptor';
import { AnalyticsModule } from './resources/analytics/analytics.module';
import { AuditLogsModule } from './resources/audit-logs/audit-logs';
import { AuthModule } from './resources/auth/auth.module';
import { EscalationModule } from './resources/escalation/escalation.module';
import { EstablishmentsModule } from './resources/establishments/establishments';
import { FloorModule } from './resources/floor/floor.module';
import { GuestModule } from './resources/guest/guest';
import { HealthModule } from './resources/health/health';
import { MenuModule } from './resources/menu/menu.module';
import { NotificationsModule } from './resources/notifications/notifications.module';
import { OutboxModule } from './resources/outbox/outbox.module';
import { RealtimeModule } from './resources/realtime/realtime.module';
import { RequestTypesModule } from './resources/request-types/request-types';
import { RolesModule } from './resources/roles/roles.module';
import { ServiceRequestsModule } from './resources/service-requests/service-requests.module';
import { StaffModule } from './resources/staff/staff.module';
import { TasksModule } from './tasks/tasks.module';
import { UnpaidAlertsModule } from './resources/unpaid-alerts/unpaid-alerts';

/**
 * Monolithe modulaire. Ordre des gardes globaux : limitation de débit, puis accès
 * (identification → périmètre établissement → permissions).
 */
@Module({
  imports: [
    CommonsModule,
    ScheduleModule.forRoot(),
    // Plafond global par adresse IP ; les routes sensibles ont leur propre @Throttle plus strict.
    ThrottlerModule.forRoot([{ ttl: 60_000, limit: process.env.NODE_ENV === 'test' ? 10_000 : 300 }]),
    OutboxModule,
    AuthModule,
    RolesModule,
    EstablishmentsModule,
    StaffModule,
    FloorModule,
    RequestTypesModule,
    MenuModule,
    ServiceRequestsModule,
    GuestModule,
    EscalationModule,
    NotificationsModule,
    RealtimeModule,
    AnalyticsModule,
    UnpaidAlertsModule,
    AuditLogsModule,
    TasksModule,
    HealthModule,
  ],
  providers: [
    { provide: APP_GUARD, useClass: ThrottlerGuard },
    { provide: APP_GUARD, useClass: AccessGuard },
    { provide: APP_INTERCEPTOR, useClass: LoggingInterceptor },
    { provide: APP_FILTER, useClass: AllExceptionsFilter },
  ],
})
export class AppModule {}
