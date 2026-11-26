import { Module } from '@nestjs/common';
import { EscalationModule } from '../resources/escalation/escalation.module';
import { UnpaidAlertsModule } from '../resources/unpaid-alerts/unpaid-alerts';
import { SubscriptionModule } from '../resources/subscription/subscription';
import { PrivacyModule } from '../resources/privacy/privacy';
import { TasksService } from './tasks.service';

@Module({ imports: [EscalationModule, UnpaidAlertsModule, SubscriptionModule, PrivacyModule], providers: [TasksService], exports: [TasksService] })
export class TasksModule {}
