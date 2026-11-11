import { Controller, Get, Module, ServiceUnavailableException } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { SkipThrottle } from '@nestjs/throttler';
import { Public } from '../../commons/decorators';
import { PrismaService } from '../../commons/prisma/prisma.service';
import { RedisService } from '../../commons/redis/redis.service';
import { TasksModule } from '../../tasks/tasks.module';
import { TasksService } from '../../tasks/tasks.service';
import { OutboxService } from '../outbox/outbox.service';

/**
 * Sondes de santé.
 *  - /health/live  : le processus répond (redémarrage par l'orchestrateur sinon) ;
 *  - /health/ready : PostgreSQL joignable. Redis est signalé « dégradé » sans rendre
 *    l'instance indisponible : l'application fonctionne sans lui.
 * Aucune donnée métier ni configuration n'est exposée.
 */
@ApiTags('Santé')
@Public()
@SkipThrottle()
@Controller({ path: 'health', version: '1' })
export class HealthController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly redis: RedisService,
    private readonly outbox: OutboxService,
    private readonly tasks: TasksService,
  ) {}

  @Get('live')
  live() {
    return { status: 'ok' };
  }

  @Get('ready')
  @ApiOperation({ summary: 'Prêt à servir : base, Redis, outbox, worker' })
  async ready() {
    let database = true;
    try {
      await this.prisma.$queryRaw`SELECT 1`;
    } catch {
      database = false;
    }
    const redis = await this.redis.ping();
    if (!database) {
      throw new ServiceUnavailableException({ code: 'NOT_READY', message: 'Base de données injoignable.' });
    }
    const [outbox, worker] = await Promise.all([this.outbox.backlog(), this.tasks.status()]);
    return { status: redis ? 'ok' : 'degraded', database: 'up', redis: redis ? 'up' : 'down', outbox, worker };
  }
}

@Module({ imports: [TasksModule], controllers: [HealthController] })
export class HealthModule {}
