import { Global, Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { APP_ENV, AppEnv, loadEnv } from './config/env';
import { PrismaService } from './prisma/prisma.service';
import { RedisService } from './redis/redis.service';
import { AuditService } from './services/audit.service';

/** Briques transverses : configuration validée, base de données, Redis, JWT, audit. */
@Global()
@Module({
  imports: [
    JwtModule.registerAsync({
      useFactory: () => {
        const env = loadEnv();
        return {
          secret: env.jwtAccessSecret,
          signOptions: { algorithm: 'HS256', expiresIn: env.jwtAccessTtlSeconds, issuer: 'tabilo' },
          verifyOptions: { algorithms: ['HS256'], issuer: 'tabilo' },
        };
      },
    }),
  ],
  providers: [
    { provide: APP_ENV, useFactory: (): AppEnv => loadEnv() },
    PrismaService,
    RedisService,
    AuditService,
  ],
  exports: [APP_ENV, PrismaService, RedisService, AuditService, JwtModule],
})
export class CommonsModule {}
