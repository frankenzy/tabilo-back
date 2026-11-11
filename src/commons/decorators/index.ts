import { createParamDecorator, ExecutionContext, SetMetadata } from '@nestjs/common';
import type { PermissionKey } from '../constants/permissions';
import type { AppRequest, AuthUser, GuestSession, Scope } from '../types';

export const IS_PUBLIC = 'tabilo:isPublic';
export const REQUIRED_PERMISSIONS = 'tabilo:permissions';

/** Route accessible sans jeton du personnel (auth, parcours client, santé). */
export const Public = () => SetMetadata(IS_PUBLIC, true);

/** Permissions exigées (toutes) sur une route rattachée à un établissement. */
export const RequirePermissions = (...permissions: PermissionKey[]) =>
  SetMetadata(REQUIRED_PERMISSIONS, permissions);

export const CurrentUser = createParamDecorator((_: unknown, ctx: ExecutionContext): AuthUser => {
  const user = ctx.switchToHttp().getRequest<AppRequest>().user;
  if (!user) throw new Error('CurrentUser utilisé sur une route non authentifiée');
  return user;
});

export const CurrentScope = createParamDecorator((_: unknown, ctx: ExecutionContext): Scope => {
  const scope = ctx.switchToHttp().getRequest<AppRequest>().scope;
  if (!scope) throw new Error("CurrentScope utilisé hors d'une route /establishments/:establishmentId");
  return scope;
});

export const CurrentGuest = createParamDecorator((_: unknown, ctx: ExecutionContext): GuestSession => {
  const guest = ctx.switchToHttp().getRequest<AppRequest>().guest;
  if (!guest) throw new Error('CurrentGuest utilisé sans GuestSessionGuard');
  return guest;
});
