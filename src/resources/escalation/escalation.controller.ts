import { Body, Controller, Delete, Get, HttpCode, Param, ParseUUIDPipe, Patch, Post } from '@nestjs/common';
import { ApiBearerAuth, ApiProperty, ApiPropertyOptional, ApiTags, PartialType } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsBoolean, IsEnum, IsInt, IsOptional, IsString, IsUUID, Max, MaxLength, Min, MinLength } from 'class-validator';
import { EscalationTrigger } from '@prisma/client';
import { CurrentScope, RequirePermissions } from '../../commons/decorators';
import type { Scope } from '../../commons/types';
import { EscalationService } from './escalation.service';

const trim = ({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() : value);

export class CreateEscalationRuleDto {
  @ApiProperty() @Transform(trim) @IsString() @MinLength(2) @MaxLength(60)
  name: string;

  @ApiProperty({ enum: EscalationTrigger }) @IsEnum(EscalationTrigger)
  trigger: EscalationTrigger;

  @ApiProperty({ minimum: 30, maximum: 7200 }) @IsInt() @Min(30) @Max(7200)
  afterSeconds: number;

  @ApiPropertyOptional({ nullable: true, description: 'Vide = tous les types.' })
  @IsOptional() @IsUUID()
  requestTypeId?: string | null;

  @ApiPropertyOptional() @IsOptional() @IsBoolean()
  isActive?: boolean;
}

export class UpdateEscalationRuleDto extends PartialType(CreateEscalationRuleDto) {}

@ApiTags('Escalade')
@ApiBearerAuth()
@Controller({ path: 'establishments/:establishmentId/escalation-rules', version: '1' })
export class EscalationController {
  constructor(private readonly escalation: EscalationService) {}

  @Get()
  @RequirePermissions('escalation.manage')
  list(@CurrentScope() scope: Scope) {
    return this.escalation.list(scope);
  }

  @Post()
  @RequirePermissions('escalation.manage')
  create(@CurrentScope() scope: Scope, @Body() dto: CreateEscalationRuleDto) {
    return this.escalation.create(scope, dto);
  }

  @Patch(':id')
  @RequirePermissions('escalation.manage')
  update(@CurrentScope() scope: Scope, @Param('id', ParseUUIDPipe) id: string, @Body() dto: UpdateEscalationRuleDto) {
    return this.escalation.update(scope, id, dto);
  }

  @Delete(':id')
  @HttpCode(204)
  @RequirePermissions('escalation.manage')
  archive(@CurrentScope() scope: Scope, @Param('id', ParseUUIDPipe) id: string) {
    return this.escalation.archive(scope, id);
  }
}
