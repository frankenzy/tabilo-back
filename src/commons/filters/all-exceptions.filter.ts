import { ArgumentsHost, Catch, ExceptionFilter, HttpException, HttpStatus, Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import type { FastifyReply, FastifyRequest } from 'fastify';

interface ErrorBody {
  statusCode: number;
  code: string;
  message: string;
  details?: unknown;
  requestId: string;
}

const DEFAULT_CODES: Record<number, string> = {
  400: 'BAD_REQUEST',
  401: 'UNAUTHORIZED',
  403: 'FORBIDDEN',
  404: 'NOT_FOUND',
  409: 'CONFLICT',
  422: 'UNPROCESSABLE',
  429: 'TOO_MANY_REQUESTS',
};

/**
 * Format d'erreur unique. Les erreurs inattendues sont journalisées côté serveur
 * et renvoyées sans détail interne (pas de pile, pas de SQL).
 */
@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  private readonly logger = new Logger('Exception');

  catch(exception: unknown, host: ArgumentsHost): void {
    const http = host.switchToHttp();
    const request = http.getRequest<FastifyRequest>();
    const reply = http.getResponse<FastifyReply>();
    const body = this.toBody(exception, String(request.id));
    if (body.statusCode >= 500) {
      this.logger.error(
        `${request.method} ${request.url} [${body.requestId}]`,
        exception instanceof Error ? exception.stack : String(exception),
      );
    }
    void reply.status(body.statusCode).send(body);
  }

  private toBody(exception: unknown, requestId: string): ErrorBody {
    if (exception instanceof HttpException) {
      const statusCode = exception.getStatus();
      const response = exception.getResponse();
      const fallbackCode = DEFAULT_CODES[statusCode] ?? 'ERROR';
      if (typeof response === 'string') {
        return { statusCode, code: fallbackCode, message: response, requestId };
      }
      const payload = response as { code?: string; message?: string | string[]; details?: unknown };
      if (Array.isArray(payload.message)) {
        return {
          statusCode,
          code: 'VALIDATION_FAILED',
          message: 'Données invalides.',
          details: payload.message,
          requestId,
        };
      }
      return {
        statusCode,
        code: payload.code ?? fallbackCode,
        message: payload.message ?? exception.message,
        details: payload.details,
        requestId,
      };
    }
    if (exception instanceof Prisma.PrismaClientKnownRequestError) {
      if (exception.code === 'P2002') {
        return {
          statusCode: HttpStatus.CONFLICT,
          code: 'ALREADY_EXISTS',
          message: 'Un élément identique existe déjà.',
          requestId,
        };
      }
      if (exception.code === 'P2003' || exception.code === 'P2025') {
        return {
          statusCode: HttpStatus.NOT_FOUND,
          code: 'NOT_FOUND',
          message: 'Élément introuvable.',
          requestId,
        };
      }
    }
    const status = (exception as { statusCode?: number }).statusCode;
    if (typeof status === 'number' && status >= 400 && status < 500) {
      // Erreurs du serveur HTTP lui-même (corps trop volumineux, JSON invalide…).
      return {
        statusCode: status,
        code: DEFAULT_CODES[status] ?? 'BAD_REQUEST',
        message: 'Requête invalide.',
        requestId,
      };
    }
    return {
      statusCode: HttpStatus.INTERNAL_SERVER_ERROR,
      code: 'INTERNAL_ERROR',
      message: 'Une erreur interne est survenue.',
      requestId,
    };
  }
}
