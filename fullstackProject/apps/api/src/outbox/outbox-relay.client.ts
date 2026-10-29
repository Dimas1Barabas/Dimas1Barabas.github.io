import { Injectable, Logger } from '@nestjs/common';
import {
  ChannelCredentials,
  ServiceError,
  credentials,
  loadPackageDefinition,
} from '@grpc/grpc-js';
import { loadSync } from '@grpc/proto-loader';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

/** Ответ proto-loader не типизирован — описываем форму сами */
interface NotifyGrpcResponse {
  accepted?: boolean;
}

/** Сгенерированный стаб proto-loader'ом: callback-стиль grpc-js */
type OutboxRelayStub = {
  Notify(
    request: object,
    options: { deadline: Date },
    callback: (err: ServiceError | null, response: NotifyGrpcResponse) => void,
  ): void;
};

/** Конструктор сервиса из загруженного пакета proto */
type OutboxRelayCtor = new (
  url: string,
  creds: ChannelCredentials,
) => OutboxRelayStub;

/**
 * Тонкая обёртка над gRPC-клиентом Курьера (services/outbox-relay):
 * proto-loader читает контракт (.proto) в рантайме — кодоген для Node
 * не нужен. Соединение ленивое: клиент строится и без поднятого релея.
 *
 * poke() — будильник «я закоммитил записи в outbox»: тикер доставки
 * просыпается сразу, не дожидаясь poll-тика. Это ускоритель латентности,
 * а не гарантия доставки: потеря RPC безвредна (тикер заберёт записи по
 * расписанию), поэтому ошибки глотаются, а путь запроса ничего не ждёт.
 */
@Injectable()
export class OutboxRelayClient {
  private readonly logger = new Logger(OutboxRelayClient.name);
  private readonly stub: OutboxRelayStub;

  constructor() {
    const def = loadSync(protoPath(), {
      keepCase: false,
      longs: Number,
      enums: String,
      defaults: true,
      oneofs: true,
    });
    const pkg = loadPackageDefinition(def) as unknown as {
      cine: {
        outbox: {
          v1: { OutboxRelay: OutboxRelayCtor };
        };
      };
    };
    this.stub = new pkg.cine.outbox.v1.OutboxRelay(
      grpcUrl(),
      credentials.createInsecure(), // внутри docker-сети стенда TLS не нужен
    );
  }

  /** fire-and-forget: короткий дедлайн, тихий отказ (fail-open) */
  poke(): void {
    this.stub.Notify(
      {},
      { deadline: new Date(Date.now() + deadlineMs()) },
      (err) => {
        // недоступность/дедлайн — штатный фон: доставит poll-тик.
        // debug, а не warn: без релея poke звучит на каждый коммит
        if (err) {
          this.logger.debug(`Notify Курьеру не дошёл: ${err.message}`);
        }
      },
    );
  }
}

/** Куда будить: dev — хост-порт стенда, compose/k8s — сеть */
function grpcUrl(): string {
  return process.env.GRPC_OUTBOX_URL ?? 'localhost:18093';
}

/** Дедлайн gRPC-вызова: будильник не стоит долгого ожидания */
function deadlineMs(): number {
  const parsed = Number.parseInt(
    process.env.GRPC_OUTBOX_TIMEOUT_MS ?? '',
    10,
  );
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 1000;
}

/**
 * .proto живёт рядом с кодом (копия контракта из fullstackProject/proto —
 * обновляет scripts/protogen.sh), поэтому __dirname покрывает и jest
 * (src/outbox/proto), и dist после nest build (assets).
 */
function protoPath(): string {
  const local = join(__dirname, 'proto', 'outbox.proto');
  if (existsSync(local)) return local;
  // запасной путь — канонический контракт монорепо (запуск из apps/api)
  return join(process.cwd(), '..', '..', 'proto', 'outbox.proto');
}
