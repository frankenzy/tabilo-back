import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { Equals, IsEmail, IsOptional, IsString, IsTimeZone, MaxLength, MinLength } from 'class-validator';

const trim = ({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() : value);
const email = ({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim().toLowerCase() : value);

export const PASSWORD_MIN_LENGTH = 10;

export class RegisterDto {
  @ApiProperty({ description: "Raison sociale ou nom de l'entreprise" })
  @Transform(trim) @IsString() @MinLength(2) @MaxLength(80)
  organizationName: string;

  @ApiProperty() @Transform(trim) @IsString() @MinLength(2) @MaxLength(80)
  establishmentName: string;

  @ApiPropertyOptional({ example: 'Africa/Abidjan' })
  @IsOptional() @IsTimeZone()
  timezone?: string;

  /** Spec 041, R2 : conditions d'utilisation et politique de confidentialité acceptées. */
  @ApiProperty({ description: 'Spec 041 : doit valoir true' }) @Equals(true, { message: 'Acceptez les conditions d’utilisation et la politique de confidentialité.' })
  acceptTerms: boolean;

  @ApiProperty() @Transform(trim) @IsString() @MinLength(1) @MaxLength(60)
  firstName: string;

  @ApiProperty() @Transform(trim) @IsString() @MinLength(1) @MaxLength(60)
  lastName: string;

  @ApiProperty() @Transform(email) @IsEmail() @MaxLength(160)
  email: string;

  @ApiProperty({ minLength: PASSWORD_MIN_LENGTH })
  @IsString() @MinLength(PASSWORD_MIN_LENGTH) @MaxLength(128)
  password: string;
}

export class LoginDto {
  @ApiProperty() @Transform(email) @IsEmail() @MaxLength(160)
  email: string;

  @ApiProperty() @IsString() @MinLength(1) @MaxLength(128)
  password: string;
}

export class ChangePasswordDto {
  @ApiProperty() @IsString() @MinLength(1) @MaxLength(128)
  currentPassword: string;

  @ApiProperty({ minLength: PASSWORD_MIN_LENGTH })
  @IsString() @MinLength(PASSWORD_MIN_LENGTH) @MaxLength(128)
  newPassword: string;
}

/** Spec 036, R5 : nouveau mot de passe choisi avec un lien de réinitialisation. */
export class ResetPasswordDto {
  @ApiProperty() @IsString() @MinLength(32) @MaxLength(128)
  token: string;

  @ApiProperty({ minLength: PASSWORD_MIN_LENGTH })
  @IsString() @MinLength(PASSWORD_MIN_LENGTH) @MaxLength(128)
  password: string;
}
