import { Controller, Get, HttpCode, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { CurrentScope } from '../../commons/decorators';
import type { Scope } from '../../commons/types';
import { PaginationQuery } from '../../commons/utils/pagination';
import { NotificationsService } from './notifications.service';

@ApiTags('Notifications')
@ApiBearerAuth()
@Controller({ path: 'establishments/:establishmentId/notifications', version: '1' })
export class NotificationsController {
  constructor(private readonly notifications: NotificationsService) {}

  @Get()
  @ApiOperation({ summary: "Notifications de l'utilisateur connecté" })
  list(@CurrentScope() scope: Scope, @Query() query: PaginationQuery) {
    return this.notifications.list(scope, query);
  }

  @Post('read-all')
  @HttpCode(200)
  markAllRead(@CurrentScope() scope: Scope) {
    return this.notifications.markAllRead(scope);
  }
}
