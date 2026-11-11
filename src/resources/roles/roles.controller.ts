import { Body, Controller, Delete, Get, HttpCode, Param, ParseUUIDPipe, Patch, Post } from '@nestjs/common';
import { ApiBearerAuth, ApiProperty, ApiPropertyOptional, ApiTags } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { ArrayMaxSize, IsArray, IsOptional, IsString, MaxLength, MinLength } from 'class-validator';
import { CurrentScope, RequirePermissions } from '../../commons/decorators';
import type { Scope } from '../../commons/types';
import { RolesService } from './roles.service';

const trim = ({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() : value);

export class CreateRoleDto {
  @ApiProperty() @Transform(trim) @IsString() @MinLength(2) @MaxLength(40)
  name: string;

  @ApiProperty({ type: [String] }) @IsArray() @ArrayMaxSize(50) @IsString({ each: true })
  permissions: string[];
}

export class UpdateRoleDto {
  @ApiPropertyOptional() @IsOptional() @Transform(trim) @IsString() @MinLength(2) @MaxLength(40)
  name?: string;

  @ApiPropertyOptional({ type: [String] }) @IsOptional() @IsArray() @ArrayMaxSize(50) @IsString({ each: true })
  permissions?: string[];
}

@ApiTags('Rôles et permissions')
@ApiBearerAuth()
@Controller({ path: 'establishments/:establishmentId/roles', version: '1' })
export class RolesController {
  constructor(private readonly roles: RolesService) {}

  @Get()
  @RequirePermissions('staff.read')
  list(@CurrentScope() scope: Scope) {
    return this.roles.list(scope);
  }

  @Get('permissions')
  @RequirePermissions('staff.read')
  catalog() {
    return this.roles.catalog();
  }

  @Post()
  @RequirePermissions('roles.manage')
  create(@CurrentScope() scope: Scope, @Body() dto: CreateRoleDto) {
    return this.roles.create(scope, dto);
  }

  @Patch(':id')
  @RequirePermissions('roles.manage')
  update(@CurrentScope() scope: Scope, @Param('id', ParseUUIDPipe) id: string, @Body() dto: UpdateRoleDto) {
    return this.roles.update(scope, id, dto);
  }

  @Delete(':id')
  @HttpCode(204)
  @RequirePermissions('roles.manage')
  remove(@CurrentScope() scope: Scope, @Param('id', ParseUUIDPipe) id: string) {
    return this.roles.remove(scope, id);
  }
}
