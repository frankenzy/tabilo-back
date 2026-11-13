import { Body, Controller, Get, Param, ParseUUIDPipe, Patch, Post, Put } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiProperty, ApiPropertyOptional, ApiTags } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { ArrayMaxSize, IsArray, IsEmail, IsIn, IsOptional, IsString, IsUUID, MaxLength, MinLength } from 'class-validator';
import { CurrentScope, RequirePermissions } from '../../commons/decorators';
import type { Scope } from '../../commons/types';
import { PASSWORD_MIN_LENGTH } from '../auth/dto';
import { StaffService } from './staff.service';

const trim = ({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() : value);
const lower = ({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim().toLowerCase() : value);

export class CreateStaffDto {
  @ApiProperty() @Transform(lower) @IsEmail() @MaxLength(160)
  email: string;

  @ApiProperty() @Transform(trim) @IsString() @MinLength(1) @MaxLength(60)
  firstName: string;

  @ApiProperty() @Transform(trim) @IsString() @MinLength(1) @MaxLength(60)
  lastName: string;

  @ApiProperty() @IsUUID()
  roleId: string;

  @ApiProperty({ minLength: PASSWORD_MIN_LENGTH, description: 'Mot de passe initial, à changer à la première connexion.' })
  @IsString() @MinLength(PASSWORD_MIN_LENGTH) @MaxLength(128)
  password: string;
}

export class UpdateStaffDto {
  @ApiPropertyOptional() @IsOptional() @Transform(trim) @IsString() @MinLength(1) @MaxLength(60)
  firstName?: string;

  @ApiPropertyOptional() @IsOptional() @Transform(trim) @IsString() @MinLength(1) @MaxLength(60)
  lastName?: string;

  @ApiPropertyOptional() @IsOptional() @IsUUID()
  roleId?: string;

  @ApiPropertyOptional({ enum: ['active', 'disabled'] }) @IsOptional() @IsIn(['active', 'disabled'])
  status?: 'active' | 'disabled';

  @ApiPropertyOptional({ minLength: PASSWORD_MIN_LENGTH })
  @IsOptional() @IsString() @MinLength(PASSWORD_MIN_LENGTH) @MaxLength(128)
  password?: string;
}

export class StaffPermissionsDto {
  @ApiProperty({ type: [String], description: 'Permissions effectives voulues, toutes incluses dans le rôle (spec 010).' })
  @IsArray() @ArrayMaxSize(100) @IsString({ each: true })
  permissions: string[];
}

@ApiTags('Équipe')
@ApiBearerAuth()
@Controller({ path: 'establishments/:establishmentId/staff', version: '1' })
export class StaffController {
  constructor(private readonly staff: StaffService) {}

  @Get()
  @RequirePermissions('staff.read')
  list(@CurrentScope() scope: Scope) {
    return this.staff.list(scope);
  }

  @Post()
  @RequirePermissions('staff.manage')
  @ApiOperation({ summary: "Ajouter un membre à l'équipe" })
  create(@CurrentScope() scope: Scope, @Body() dto: CreateStaffDto) {
    return this.staff.create(scope, dto);
  }

  @Patch(':userId')
  @RequirePermissions('staff.manage')
  update(@CurrentScope() scope: Scope, @Param('userId', ParseUUIDPipe) userId: string, @Body() dto: UpdateStaffDto) {
    return this.staff.update(scope, userId, dto);
  }

  @Put(':userId/permissions')
  @RequirePermissions('staff.manage')
  @ApiOperation({ summary: "Ajuster les permissions d'un employé dans les limites de son rôle (spec 010)" })
  setPermissions(@CurrentScope() scope: Scope, @Param('userId', ParseUUIDPipe) userId: string, @Body() dto: StaffPermissionsDto) {
    return this.staff.setPermissions(scope, userId, dto.permissions);
  }
}
