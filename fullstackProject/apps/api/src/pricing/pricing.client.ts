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

/** Что API спрашивает у Тарификатора (camelCase — как в proto после загрузчика) */
export interface QuoteInput {
  sessionId: string;
  /** момент сеанса, RFC3339 — от него факторы времени суток/выходного */
  sessionAt: string;
  basePriceRub: number;
  /** ёмкость зала (геометрия общая — 8×10) */
  capacity: number;
}

/** Фактор раскладки цены: «вечерний прайм +20%» */
export interface PriceFactorDto {
  code: string;
  label: string;
  percent: number;
}

/** Ответ proto-loader не типизирован — описываем форму сами */
export interface QuoteGrpcResponse {
  priceRub?: number;
  basePriceRub?: number;
  factors?: PriceFactorDto[];
  occupied?: number;
  capacity?: number;
}

/** Сгенерированный стаб proto-loader'ом: callback-стиль grpc-js */
type PricingStub = {
  Quote(
    request: QuoteInput,
    options: { deadline: Date },
    callback: (err: ServiceError | null, response: QuoteGrpcResponse) => void,
  ): void;
};

/** Конструктор сервиса из загруженного пакета proto */
type PricingCtor = new (url: string, creds: ChannelCredentials) => PricingStub;

/**
 * Тонкая обёртка над gRPC-клиентом Тарификатора: proto-loader читает
 * контракт (.proto) в рантайме — кодоген для Node не нужен. Соединение
 * ленивое: клиент строится и без поднятого сервиса. Вызовы уходят
 * с коротким дедлайном — цена нужна на критическом пути создания
 * брони, недоступность сервиса гасится fallback'ом на базовую цену
 * там, где клиент зовут.
 */
@Injectable()
export class PricingClient {
  private readonly stub: PricingStub;

  constructor() {
    const def = loadSync(protoPath(), {
      keepCase: false, // поля в camelCase (priceRub), как в остальном API
      longs: Number,
      enums: String,
      defaults: true,
      oneofs: true,
    });
    const pkg = loadPackageDefinition(def) as unknown as {
      cine: {
        pricing: {
          v1: { Pricing: PricingCtor };
        };
      };
    };
    this.stub = new pkg.cine.pricing.v1.Pricing(
      grpcUrl(),
      credentials.createInsecure(), // внутри docker-сети стенда TLS не нужен
    );
  }

  /** Цена места сеанса с раскладкой факторов; дедлайн оберегает бронь */
  quote(input: QuoteInput): Promise<QuoteGrpcResponse> {
    return new Promise((resolve, reject) => {
      this.stub.Quote(
        input,
        { deadline: new Date(Date.now() + deadlineMs()) },
        (err, res) => (err ? reject(err) : resolve(res)),
      );
    });
  }
}

/** Куда ходить за ценой: dev — хост-порт стенда, compose — сеть */
function grpcUrl(): string {
  return process.env.GRPC_PRICING_URL ?? 'localhost:18088';
}

/** Дедлайн gRPC-вызова: цена не стоит долгого ожидания */
function deadlineMs(): number {
  const parsed = Number.parseInt(
    process.env.GRPC_PRICING_TIMEOUT_MS ?? '',
    10,
  );
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 1000;
}

/**
 * .proto живёт рядом с кодом (копия контракта из fullstackProject/proto —
 * обновляет scripts/protogen.sh), поэтому __dirname покрывает и jest
 * (src/pricing/proto), и dist после nest build (assets).
 */
function protoPath(): string {
  const local = join(__dirname, 'proto', 'pricing.proto');
  if (existsSync(local)) return local;
  // запасной путь — канонический контракт монорепо (запуск из apps/api)
  return join(process.cwd(), '..', '..', 'proto', 'pricing.proto');
}
