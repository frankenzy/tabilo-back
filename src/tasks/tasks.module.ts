import { Module } from '@nestjs/common';
import { EscalationModule } from '../resources/escalation/escalation.module';
import { UnpaidAlertsModule } from '../resources/unpaid-alerts/unpaid-alerts';
import { TasksService } from './tasks.service';

@Module({ imports: [EscalationModule, UnpaidAlertsModule], providers: [TasksService], exports: [TasksService] })
export class TasksModule {}
