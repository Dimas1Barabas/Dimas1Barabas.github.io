import { Injectable } from '@nestjs/common';
import {
  ChannelCredentials,
  ServiceError,
  credentials,
  loadPackageDefinition,
} from '@grpc/grpc-js';
import { loadSync } from '@grpc/proto-loader';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

/** Что API спрашивает у Привратника (camelCase — как в proto после загрузчика) */
export interface CheckRateInput {
  /** действие из таблицы политик сервиса: bookings.create | auth.login */
  action: string;
  /** кто спрашивает: user id / email / ip */
  key: string;
}

/** Ответ proto-loader не типизирован — описываем форму сами */
export interface CheckRateGrpcResponse {
  allowed?: boolean;
  retryAfterMs?: number;
  remaining?: number;
  limit?: number;
  capacity?: number;
}

/** Сгенерированный стаб proto-loader'ом: callback-стиль grpc-js */
type RateLimiterStub = {
  Check(
    request: CheckRateInput,
    options: { deadline: Date },
    callback: (err: ServiceError | null, response: CheckRateGrpcResponse) => void,
  ): void;
};

/** Конструктор сервиса из загруженного пакета proto */
type RateLimiterCtor = new (
  url: string,
  creds: ChannelCredentials,
) => RateLimiterStub;

/**
 * Тонкая обёртка над gRPC-клиентом «Привратника»: proto-loader читает
 * контракт (.proto) в рантайме — кодоген для Node не нужен. Соединение
 * ленивое: клиент строится и без поднятого сервиса. Вызовы уходят
 * с коротким дедлайном — проверка стоит на пути каждого лимитируемого
 * запроса; недоступность гасится fail-open'ом у вызывающего (гварда).
 */
@Injectable()
export class RateLimiterClient {
  private readonly stub: RateLimiterStub;

  constructor() {
    const def = loadSync(protoPath(), {
      keepCase: false, // поля в camelCase (retryAfterMs), как в остальном API
      longs: Number,
      enums: String,
      defaults: true,
      oneofs: true,
    });
    const pkg = loadPackageDefinition(def) as unknown as {
      cine: {
        ratelimiter: {
          v1: { RateLimiter: RateLimiterCtor };
        };
      };
    };
    this.stub = new pkg.cine.ratelimiter.v1.RateLimiter(
      grpcUrl(),
      credentials.createInsecure(), // внутри docker-сети стенда TLS не нужен
    );
  }

  /** Снять токен корзины; дедлайн оберегает запрос пользователя */
  check(input: CheckRateInput): Promise<CheckRateGrpcResponse> {
    return new Promise((resolve, reject) => {
      this.stub.Check(
        input,
        { deadline: new Date(Date.now() + deadlineMs()) },
        (err, res) => (err ? reject(err) : resolve(res)),
      );
    });
  }
}

/** Куда ходить за вердиктом: dev — хост-порт стенда, compose — сеть */
function grpcUrl(): string {
  return process.env.GRPC_RATELIMITER_URL ?? 'localhost:18090';
}

/** Дедлайн gRPC-вызова: проверка не стоит долгого ожидания */
function deadlineMs(): number {
  const parsed = Number.parseInt(
    process.env.GRPC_RATELIMITER_TIMEOUT_MS ?? '',
    10,
  );
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 1000;
}

/**
 * .proto живёт рядом с кодом (копия контракта из fullstackProject/proto —
 * обновляет scripts/protogen.sh), поэтому __dirname покрывает и jest
 * (src/ratelimiter/proto), и dist после nest build (assets).
 */
function protoPath(): string {
  const local = join(__dirname, 'proto', 'ratelimiter.proto');
  if (existsSync(local)) return local;
  // запасной путь — канонический контракт монорепо (запуск из apps/api)
  return join(process.cwd(), '..', '..', 'proto', 'ratelimiter.proto');
}
