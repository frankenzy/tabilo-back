import { Body, Controller, Delete, Get, HttpCode, Param, ParseUUIDPipe, Patch, Post } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiProperty, ApiPropertyOptional, ApiTags } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsInt, IsOptional, IsString, IsUUID, Max, MaxLength, Min, MinLength } from 'class-validator';
import { CurrentScope, RequirePermissions } from '../../commons/decorators';
import type { Scope } from '../../commons/types';
import { FloorService } from './floor.service';

const trim = ({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() : value);

export class CreateAreaDto {
  @ApiProperty() @Transform(trim) @IsString() @MinLength(1) @MaxLength(40)
  name: string;
}

export class UpdateAreaDto {
  @ApiPropertyOptional() @IsOptional() @Transform(trim) @IsString() @MinLength(1) @MaxLength(40)
  name?: string;

  @ApiPropertyOptional() @IsOptional() @IsInt() @Min(0) @Max(1000)
  position?: number;
}

export class CreateTableDto {
  @ApiProperty() @IsUUID()
  areaId: string;

  @ApiProperty({ example: '12' }) @Transform(trim) @IsString() @MinLength(1) @MaxLength(12)
  label: string;

  @ApiPropertyOptional({ default: 2 }) @IsOptional() @IsInt() @Min(1) @Max(50)
  seats?: number;
}

export class UpdateTableDto {
  @ApiPropertyOptional() @IsOptional() @IsUUID()
  areaId?: string;

  @ApiPropertyOptional() @IsOptional() @Transform(trim) @IsString() @MinLength(1) @MaxLength(12)
  label?: string;

  @ApiPropertyOptional() @IsOptional() @IsInt() @Min(1) @Max(50)
  seats?: number;
}

@ApiTags('Salle : zones, tables, QR codes, sessions')
@ApiBearerAuth()
@Controller({ path: 'establishments/:establishmentId', version: '1' })
export class FloorController {
  constructor(private readonly floor: FloorService) {}

  @Get('floor')
  @RequirePermissions('floor.read')
  @ApiOperation({ summary: 'Zones et tables actives, avec sessions ouvertes' })
  overview(@CurrentScope() scope: Scope) {
    return this.floor.overview(scope);
  }

  @Post('areas')
  @RequirePermissions('floor.manage')
  createArea(@CurrentScope() scope: Scope, @Body() dto: CreateAreaDto) {
    return this.floor.createArea(scope, dto);
  }

  @Patch('areas/:id')
  @RequirePermissions('floor.manage')
  updateArea(@CurrentScope() scope: Scope, @Param('id', ParseUUIDPipe) id: string, @Body() dto: UpdateAreaDto) {
    return this.floor.updateArea(scope, id, dto);
  }

  @Delete('areas/:id')
  @HttpCode(204)
  @RequirePermissions('floor.manage')
  archiveArea(@CurrentScope() scope: Scope, @Param('id', ParseUUIDPipe) id: string) {
    return this.floor.archiveArea(scope, id);
  }

  @Post('tables')
  @RequirePermissions('floor.manage')
  createTable(@CurrentScope() scope: Scope, @Body() dto: CreateTableDto) {
    return this.floor.createTable(scope, dto);
  }

  @Patch('tables/:id')
  @RequirePermissions('floor.manage')
  updateTable(@CurrentScope() scope: Scope, @Param('id', ParseUUIDPipe) id: string, @Body() dto: UpdateTableDto) {
    return this.floor.updateTable(scope, id, dto);
  }

  @Delete('tables/:id')
  @HttpCode(204)
  @RequirePermissions('floor.manage')
  archiveTable(@CurrentScope() scope: Scope, @Param('id', ParseUUIDPipe) id: string) {
    return this.floor.archiveTable(scope, id);
  }

  @Get('qr-codes')
  @RequirePermissions('qr.manage')
  @ApiOperation({ summary: 'QR codes actifs (URL, SVG, PNG) pour impression' })
  qrCodes(@CurrentScope() scope: Scope) {
    return this.floor.qrCodes(scope);
  }

  @Post('tables/:id/qr/regenerate')
  @HttpCode(200)
  @RequirePermissions('qr.manage')
  @ApiOperation({ summary: "Révoquer le QR d'une table et en générer un nouveau" })
  regenerateQr(@CurrentScope() scope: Scope, @Param('id', ParseUUIDPipe) id: string) {
    return this.floor.regenerateQr(scope, id);
  }

  @Post('tables/:id/sessions/close')
  @HttpCode(200)
  @RequirePermissions('sessions.manage')
  @ApiOperation({ summary: "Fermer les sessions ouvertes d'une table" })
  closeSessions(@CurrentScope() scope: Scope, @Param('id', ParseUUIDPipe) id: string) {
    return this.floor.closeSessions(scope, id);
  }
}
