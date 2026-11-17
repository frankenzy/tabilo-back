import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import {
  IsBoolean,
  IsDate,
  IsEnum,
  IsIn,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
  MinLength,
} from 'class-validator';
import { RequestStatus } from '@prisma/client';
import { PaginationQuery } from '../../commons/utils/pagination';

const trim = ({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() : value);
const toBoolean = ({ value }: { value: unknown }) => value === true || value === 'true';

export const NOTE_MAX_LENGTH = 280;

export class CreateStaffRequestDto {
  @ApiProperty() @IsUUID() tableId: string;
  @ApiProperty() @IsUUID() requestTypeId: string;

  @ApiPropertyOptional({ maxLength: NOTE_MAX_LENGTH })
  @IsOptional()
  @Transform(trim)
  @IsString()
  @MaxLength(NOTE_MAX_LENGTH)
  note?: string;

  @ApiPropertyOptional({ description: 'Prendre immédiatement la demande en charge.' })
  @IsOptional()
  @IsBoolean()
  takeIt?: boolean;
}

export class AssignRequestDto {
  @ApiProperty() @IsUUID() assigneeId: string;

  @ApiPropertyOptional({ description: 'Obligatoire pour une réaffectation ou un transfert.' })
  @IsOptional()
  @Transform(trim)
  @IsString()
  @MaxLength(200)
  reason?: string;
}

export class ReasonDto {
  @ApiProperty({ minLength: 3, maxLength: 200 })
  @Transform(trim)
  @IsString()
  @MinLength(3)
  @MaxLength(200)
  reason: string;
}

export class OptionalReasonDto {
  @ApiPropertyOptional({ maxLength: 200 })
  @IsOptional()
  @Transform(trim)
  @IsString()
  @MaxLength(200)
  reason?: string;
}

export class ListRequestsQuery extends PaginationQuery {
  @ApiPropertyOptional({ enum: ['active', 'closed', 'unpaid', 'all'], default: 'active', description: '`unpaid` : commandes servies non réglées (spec 026).' })
  @IsOptional()
  @IsIn(['active', 'closed', 'unpaid', 'all'])
  scope: 'active' | 'closed' | 'unpaid' | 'all' = 'active';

  @ApiPropertyOptional({ enum: RequestStatus })
  @IsOptional()
  @IsEnum(RequestStatus)
  status?: RequestStatus;

  @ApiPropertyOptional() @IsOptional() @IsUUID() areaId?: string;
  @ApiPropertyOptional() @IsOptional() @IsUUID() tableId?: string;
  @ApiPropertyOptional() @IsOptional() @IsUUID() requestTypeId?: string;
  @ApiPropertyOptional() @IsOptional() @IsUUID() assigneeId?: string;

  @ApiPropertyOptional({ description: 'Demandes dont le délai de prise en charge est dépassé.' })
  @IsOptional()
  @Transform(toBoolean)
  @IsBoolean()
  late?: boolean;

  @ApiPropertyOptional() @IsOptional() @Transform(toBoolean) @IsBoolean() escalated?: boolean;

  @ApiPropertyOptional() @IsOptional() @Type(() => Date) @IsDate() from?: Date;
  @ApiPropertyOptional() @IsOptional() @Type(() => Date) @IsDate() to?: Date;
}

/** Spec 026, R4 : régler toutes les commandes servies non réglées de l'occupation d'une table. */
export class SettleTableDto {
  @ApiProperty() @IsUUID() tableId: string;
}
