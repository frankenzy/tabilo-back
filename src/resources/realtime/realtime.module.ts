import { Module } from '@nestjs/common';
import { GuestSessionGuard, GuestSessionResolver } from '../../commons/guards/guest-session.guard';
import { ServiceRequestsModule } from '../service-requests/service-requests.module';
import { RealtimeGateway } from './realtime.gateway';

@Module({
  imports: [ServiceRequestsModule],
  providers: [RealtimeGateway, GuestSessionResolver, GuestSessionGuard],
  exports: [RealtimeGateway, GuestSessionResolver, GuestSessionGuard],
})
export class RealtimeModule {}
