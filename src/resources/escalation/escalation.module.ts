import { Module } from '@nestjs/common';
import { ServiceRequestsModule } from '../service-requests/service-requests.module';
import { EscalationController } from './escalation.controller';
import { EscalationService } from './escalation.service';

@Module({
  imports: [ServiceRequestsModule],
  controllers: [EscalationController],
  providers: [EscalationService],
  exports: [EscalationService],
})
export class EscalationModule {}
