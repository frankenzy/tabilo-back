import {
  ConflictException,
  ForbiddenException,
  HttpException,
  HttpStatus,
  NotFoundException,
  UnauthorizedException,
  UnprocessableEntityException,
} from '@nestjs/common';

/** Erreurs métier : un code stable pour le frontend, un message lisible pour l'utilisateur. */
export const notFound = (code: string, message: string) => new NotFoundException({ code, message });
export const conflict = (code: string, message: string) => new ConflictException({ code, message });
export const forbidden = (code: string, message: string) => new ForbiddenException({ code, message });
export const unauthorized = (code: string, message: string) =>
  new UnauthorizedException({ code, message });
export const unprocessable = (code: string, message: string) =>
  new UnprocessableEntityException({ code, message });
export const tooMany = (code: string, message: string) =>
  new HttpException({ code, message }, HttpStatus.TOO_MANY_REQUESTS);
