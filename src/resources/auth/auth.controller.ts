import { Body, Controller, Get, HttpCode, Inject, Post, Req, Res } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { rateLimit } from '../../commons/utils/rate-limit';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { APP_ENV, AppEnv } from '../../commons/config/env';
import { CurrentUser, Public } from '../../commons/decorators';
import type { AuthUser } from '../../commons/types';
import { AuthService, ClientContext, IssuedTokens } from './auth.service';
import { ChangePasswordDto, LoginDto, RegisterDto, ResetPasswordDto } from './dto';

const REFRESH_COOKIE = 'tabilo_rt';
const COOKIE_PATH = '/api/v1/auth';

/**
 * Authentification du personnel.
 * - Jeton d'accès court (JWT), renvoyé dans le corps et porté par l'en-tête Authorization :
 *   aucune requête métier n'est authentifiée par cookie, donc pas de CSRF sur l'API.
 * - Refresh token opaque en cookie HttpOnly, SameSite=Strict, limité au chemin /api/v1/auth.
 */
@ApiTags('Authentification')
@Controller({ path: 'auth', version: '1' })
export class AuthController {
  constructor(
    private readonly auth: AuthService,
    @Inject(APP_ENV) private readonly env: AppEnv,
  ) {}

  @Public()
  @Throttle(rateLimit(5, 3_600_000))
  @Post('register')
  @ApiOperation({ summary: 'Créer un compte client (tenant + établissement + propriétaire)' })
  async register(@Body() dto: RegisterDto, @Req() req: FastifyRequest, @Res({ passthrough: true }) reply: FastifyReply) {
    return this.respond(await this.auth.register(dto, this.client(req)), reply);
  }

  /** Spec 036, R5 : lien à usage unique donné par l'éditeur ; toutes les sessions du compte sont fermées. */
  @Public()
  @Throttle(rateLimit(10, 900_000))
  @Post('reset-password')
  @HttpCode(204)
  async resetPassword(@Body() dto: ResetPasswordDto, @Req() req: FastifyRequest): Promise<void> {
    await this.auth.resetPassword(dto, this.client(req));
  }

  @Public()
  @Throttle(rateLimit(10, 60_000))
  @Post('login')
  @HttpCode(200)
  async login(@Body() dto: LoginDto, @Req() req: FastifyRequest, @Res({ passthrough: true }) reply: FastifyReply) {
    return this.respond(await this.auth.login(dto, this.client(req)), reply);
  }

  @Public()
  @Throttle(rateLimit(60, 60_000))
  @Post('refresh')
  @HttpCode(200)
  @ApiOperation({ summary: "Renouveler le jeton d'accès (rotation du refresh token)" })
  async refresh(@Req() req: FastifyRequest, @Res({ passthrough: true }) reply: FastifyReply) {
    try {
      return this.respond(await this.auth.refresh(req.cookies[REFRESH_COOKIE], this.client(req)), reply);
    } catch (error) {
      this.clearCookie(reply);
      throw error;
    }
  }

  @Public()
  @Post('logout')
  @HttpCode(204)
  async logout(@Req() req: FastifyRequest, @Res({ passthrough: true }) reply: FastifyReply): Promise<void> {
    await this.auth.logout(req.cookies[REFRESH_COOKIE]);
    this.clearCookie(reply);
  }

  @ApiBearerAuth()
  @Get('me')
  @ApiOperation({ summary: 'Profil, établissements accessibles et permissions' })
  me(@CurrentUser() user: AuthUser) {
    return this.auth.me(user);
  }

  @ApiBearerAuth()
  @Throttle(rateLimit(10, 60_000))
  @Post('change-password')
  @HttpCode(200)
  async changePassword(
    @CurrentUser() user: AuthUser,
    @Body() dto: ChangePasswordDto,
    @Req() req: FastifyRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ) {
    return this.respond(await this.auth.changePassword(user, dto, this.client(req)), reply);
  }

  private client(req: FastifyRequest): ClientContext {
    return { ip: req.ip, userAgent: req.headers['user-agent'] };
  }

  private respond(tokens: IssuedTokens, reply: FastifyReply) {
    void reply.setCookie(REFRESH_COOKIE, tokens.refreshToken, {
      httpOnly: true,
      secure: this.env.cookieSecure,
      sameSite: 'strict',
      path: COOKIE_PATH,
      expires: tokens.refreshExpiresAt,
    });
    return { accessToken: tokens.accessToken, expiresIn: tokens.expiresIn };
  }

  private clearCookie(reply: FastifyReply): void {
    void reply.clearCookie(REFRESH_COOKIE, { path: COOKIE_PATH });
  }
}
