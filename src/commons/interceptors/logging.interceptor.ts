import { CallHandler, ExecutionContext, Injectable, Logger, NestInterceptor } from '@nestjs/common';
import type { Observable } from 'rxjs';
import { tap } from 'rxjs/operators';
import type { AppRequest } from '../types';

/**
 * Journal d'accès minimal : méthode, route (gabarit, pas l'URL brute), statut, durée.
 * Ni corps, ni en-têtes, ni jetons : rien de sensible ne part dans les logs.
 */
@Injectable()
export class LoggingInterceptor implements NestInterceptor {
  private readonly logger = new Logger('HTTP');

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    if (context.getType() !== 'http') return next.handle();
    const request = context.switchToHttp().getRequest<AppRequest>();
    const startedAt = Date.now();
    const route = request.routeOptions?.url ?? 'unknown';
    const done = (status: number | string) =>
      this.logger.log(
        `${request.method} ${route} ${status} ${Date.now() - startedAt}ms id=${request.id}` +
          (request.user ? ` user=${request.user.id}` : ''),
      );
    return next.handle().pipe(
      tap({
        next: () => done(context.switchToHttp().getResponse<{ statusCode: number }>().statusCode),
        error: (error: { status?: number }) => done(error.status ?? 500),
      }),
    );
  }
}
