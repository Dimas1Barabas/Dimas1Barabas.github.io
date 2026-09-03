import { AmqpConnection } from '@golevelup/nestjs-rabbitmq';
import { Controller, Get } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { RedisService } from '../redis/redis.service';

type CheckStatus = 'up' | 'down';

@Controller('health')
export class HealthController {
  constructor(
    private readonly dataSource: DataSource,
    private readonly redis: RedisService,
    private readonly rabbit: AmqpConnection,
  ) {}

  private async postgres(): Promise<CheckStatus> {
    try {
      await this.dataSource.query('SELECT 1');
      return 'up';
    } catch {
      return 'down';
    }
  }

  private async rabbitmq(): Promise<CheckStatus> {
    try {
      return this.rabbit.connected ? 'up' : 'down';
    } catch {
      return 'down';
    }
  }

  @Get()
  async check() {
    const [postgres, redis, rabbitmq] = await Promise.all([
      this.postgres(),
      this.redis.ping().then((ok): CheckStatus => (ok ? 'up' : 'down')),
      this.rabbitmq(),
    ]);

    const checks = { postgres, redis, rabbitmq };
    const status = Object.values(checks).every((c) => c === 'up')
      ? 'ok'
      : 'degraded';

    return {
      status,
      checks,
      uptimeSec: Math.round(process.uptime()),
      timestamp: new Date().toISOString(),
    };
  }
}
