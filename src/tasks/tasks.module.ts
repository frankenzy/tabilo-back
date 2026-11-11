import { Module } from '@nestjs/common';
import { EscalationModule } from '../resources/escalation/escalation.module';
import { TasksService } from './tasks.service';

@Module({ imports: [EscalationModule], providers: [TasksService], exports: [TasksService] })
export class TasksModule {}
