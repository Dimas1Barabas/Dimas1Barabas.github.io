import { AmqpConnection } from '@golevelup/nestjs-rabbitmq';
import { Test } from '@nestjs/testing';
import { DataSource } from 'typeorm';
import { RedisService } from '../redis/redis.service';
import { REDIS_CLIENT } from '../redis/redis.tokens';
import { HealthController } from './health.controller';

async function buildController(
  postgresOk: boolean,
  redisOk: boolean,
  rabbitOk: boolean,
): Promise<HealthController> {
  const moduleRef = await Test.createTestingModule({
    controllers: [HealthController],
    providers: [
      RedisService,
      {
        provide: REDIS_CLIENT,
        useValue: { ping: jest.fn(async () => (redisOk ? 'PONG' : null)) },
      },
      {
        provide: DataSource,
        useValue: {
          query: postgresOk
            ? jest.fn(async () => [])
            : jest.fn(async () => {
                throw new Error('connection refused');
              }),
        },
      },
      { provide: AmqpConnection, useValue: { connected: rabbitOk } },
    ],
  }).compile();

  return moduleRef.get(HealthController);
}

describe('HealthController (unit)', () => {
  it('все зависимости живы → status ok', async () => {
    const controller = await buildController(true, true, true);
    const result = await controller.check();

    expect(result.status).toBe('ok');
    expect(result.checks).toEqual({
      postgres: 'up',
      redis: 'up',
      rabbitmq: 'up',
    });
    expect(result.uptimeSec).toBeGreaterThanOrEqual(0);
  });

  it.each([
    ['postgres', false, true, true],
    ['redis', true, false, true],
    ['rabbitmq', true, true, false],
  ])('%s недоступен → degraded', async (_name, pg, redis, rabbit) => {
    const controller = await buildController(pg, redis, rabbit);
    const result = await controller.check();

    expect(result.status).toBe('degraded');
    expect(Object.values(result.checks)).toContain('down');
  });
});
