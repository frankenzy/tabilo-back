import { Body, Controller, Get, HttpCode, Param, ParseUUIDPipe, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { CurrentScope, RequirePermissions } from '../../commons/decorators';
import type { Scope } from '../../commons/types';
import {
  AssignRequestDto,
  CreateStaffRequestDto,
  ListRequestsQuery,
  OptionalReasonDto,
  ReasonDto,
} from './dto';
import { ServiceRequestsService } from './service-requests.service';

@ApiTags('Demandes')
@ApiBearerAuth()
@Controller({ path: 'establishments/:establishmentId/requests', version: '1' })
export class ServiceRequestsController {
  constructor(private readonly requests: ServiceRequestsService) {}

  @Get()
  @RequirePermissions('requests.read')
  @ApiOperation({ summary: 'Lister les demandes (filtres, pagination)' })
  list(@CurrentScope() scope: Scope, @Query() query: ListRequestsQuery) {
    return this.requests.list(scope, query);
  }

  @Post()
  @RequirePermissions('requests.create')
  @ApiOperation({ summary: 'Créer une demande pour une table (client sans smartphone)' })
  create(@CurrentScope() scope: Scope, @Body() dto: CreateStaffRequestDto) {
    return this.requests.createByStaff(scope, dto);
  }

  @Get(':id')
  @RequirePermissions('requests.read')
  @ApiOperation({ summary: "Détail d'une demande et historique de ses événements" })
  get(@CurrentScope() scope: Scope, @Param('id', ParseUUIDPipe) id: string) {
    return this.requests.get(scope, id);
  }

  @Post(':id/accept')
  @HttpCode(200)
  @RequirePermissions('requests.handle')
  accept(@CurrentScope() scope: Scope, @Param('id', ParseUUIDPipe) id: string) {
    return this.requests.accept(scope, id);
  }

  @Post(':id/start')
  @HttpCode(200)
  @RequirePermissions('requests.handle')
  start(@CurrentScope() scope: Scope, @Param('id', ParseUUIDPipe) id: string) {
    return this.requests.start(scope, id);
  }

  @Post(':id/prepare')
  @HttpCode(200)
  @RequirePermissions('requests.handle')
  @ApiOperation({ summary: 'Préparer une commande : accepter et démarrer en un geste (spec 007)' })
  prepare(@CurrentScope() scope: Scope, @Param('id', ParseUUIDPipe) id: string) {
    return this.requests.prepare(scope, id);
  }

  @Post(':id/ready')
  @HttpCode(200)
  @RequirePermissions('requests.handle')
  @ApiOperation({ summary: 'Signaler une commande prête (cuisine séparée, spec 007)' })
  ready(@CurrentScope() scope: Scope, @Param('id', ParseUUIDPipe) id: string) {
    return this.requests.markReady(scope, id);
  }

  @Post(':id/resolve')
  @HttpCode(200)
  @RequirePermissions('requests.handle')
  resolve(@CurrentScope() scope: Scope, @Param('id', ParseUUIDPipe) id: string) {
    return this.requests.resolve(scope, id);
  }

  @Post(':id/release')
  @HttpCode(200)
  @RequirePermissions('requests.handle')
  @ApiOperation({ summary: 'Libérer une demande affectée (retour en attente, motif obligatoire)' })
  release(@CurrentScope() scope: Scope, @Param('id', ParseUUIDPipe) id: string, @Body() dto: ReasonDto) {
    return this.requests.release(scope, id, dto.reason);
  }

  @Post(':id/transfer')
  @HttpCode(200)
  @RequirePermissions('requests.handle')
  @ApiOperation({ summary: 'Transférer une demande en cours à un collègue' })
  transfer(@CurrentScope() scope: Scope, @Param('id', ParseUUIDPipe) id: string, @Body() dto: AssignRequestDto) {
    return this.requests.transfer(scope, id, dto);
  }

  @Post(':id/assign')
  @HttpCode(200)
  @RequirePermissions('requests.assign')
  @ApiOperation({ summary: 'Affecter ou réaffecter une demande (supervision)' })
  assign(@CurrentScope() scope: Scope, @Param('id', ParseUUIDPipe) id: string, @Body() dto: AssignRequestDto) {
    return this.requests.assign(scope, id, dto);
  }

  @Post(':id/cancel')
  @HttpCode(200)
  @RequirePermissions('requests.cancel')
  cancel(@CurrentScope() scope: Scope, @Param('id', ParseUUIDPipe) id: string, @Body() dto: OptionalReasonDto) {
    return this.requests.cancel(scope, id, dto.reason);
  }

  @Post(':id/acknowledge-escalation')
  @HttpCode(200)
  @RequirePermissions('requests.supervise')
  acknowledge(@CurrentScope() scope: Scope, @Param('id', ParseUUIDPipe) id: string) {
    return this.requests.acknowledgeEscalation(scope, id);
  }
}
