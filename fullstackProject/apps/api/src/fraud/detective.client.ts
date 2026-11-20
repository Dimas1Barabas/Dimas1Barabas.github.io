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

/** Что API знает о брони на момент скоринга (факты собирает fraud-snapshot) */
export interface ScoreInput {
  /** идемпотентность: вердикт живёт в витрине под этим ключом; API
   *  генерирует его заранее и создаёт бронь с тем же id */
  bookingId: string;
  userId: string;
  sessionId: string;
  seatsCount: number;
  totalRub: number;
  accountAgeDays: number;
  bookings24h: number;
  cancels24h: number;
  failed24h: number;
}

/** Вердикт антифрода: allow | review | block */
export type FraudVerdict = 'allow' | 'review' | 'block';

/** Ответ proto-loader не типизирован — описываем форму сами */
export interface ScoreGrpcResponse {
  verdict?: string;
  score?: number;
  reasons?: string[];
}

export interface ResolveGrpcResponse {
  resolved?: boolean;
  status?: string;
}

/** Сгенерированный стаб proto-loader'ом: callback-стиль grpc-js */
type DetectiveStub = {
  Score(
    request: Record<string, unknown>,
    options: { deadline: Date },
    callback: (err: ServiceError | null, response: ScoreGrpcResponse) => void,
  ): void;
  Resolve(
    request: Record<string, unknown>,
    options: { deadline: Date },
    callback: (err: ServiceError | null, response: ResolveGrpcResponse) => void,
  ): void;
};

/** Конструктор сервиса из загруженного пакета proto */
type DetectiveCtor = new (
  url: string,
  creds: ChannelCredentials,
) => DetectiveStub;

/**
 * Тонкая обёртка над gRPC-клиентом «Детектива»: proto-loader читает
 * контракт (.proto) в рантайме — кодоген для Node не нужен. Соединение
 * ленивое: клиент строится и без поднятого сервиса. Вызовы уходят
 * с коротким дедлайном — скоринг стоит на пути каждого чекаута;
 * недоступность гасится fail-open'ом у вызывающего (checkout).
 */
@Injectable()
export class DetectiveClient {
  private readonly stub: DetectiveStub;

  constructor() {
    const def = loadSync(protoPath(), {
      keepCase: false, // поля в camelCase, как в остальном API
      longs: Number,
      enums: String,
      defaults: true,
      oneofs: true,
    });
    const pkg = loadPackageDefinition(def) as unknown as {
      cine: {
        detective: {
          v1: { Detective: DetectiveCtor };
        };
      };
    };
    this.stub = new pkg.cine.detective.v1.Detective(
      grpcUrl(),
      credentials.createInsecure(), // внутри docker-сети стенда TLS не нужен
    );
  }

  /** Спросить вердикт по фактам брони; дедлайн бережёт чекаут */
  score(input: ScoreInput): Promise<ScoreGrpcResponse> {
    return new Promise((resolve, reject) => {
      this.stub.Score(
        input as unknown as Record<string, unknown>,
        { deadline: new Date(Date.now() + deadlineMs()) },
        (err, res) => (err ? reject(err) : resolve(res)),
      );
    });
  }

  /** Решение человека по брони из очереди ревью (админ-витрина) */
  resolve(input: {
    bookingId: string;
    action: 'approve' | 'reject';
    resolvedBy: string;
  }): Promise<ResolveGrpcResponse> {
    return new Promise((resolve, reject) => {
      this.stub.Resolve(
        input,
        { deadline: new Date(Date.now() + deadlineMs()) },
        (err, res) => (err ? reject(err) : resolve(res)),
      );
    });
  }
}

/** Куда ходить за вердиктом: dev — хост-порт стенда, compose — сеть */
function grpcUrl(): string {
  return process.env.GRPC_DETECTIVE_URL ?? 'localhost:18092';
}

/** Дедлайн gRPC-вызова: скоринг не стоит долгого ожидания */
function deadlineMs(): number {
  const parsed = Number.parseInt(
    process.env.GRPC_DETECTIVE_TIMEOUT_MS ?? '',
    10,
  );
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 1000;
}

/**
 * .proto живёт рядом с кодом (копия контракта из fullstackProject/proto —
 * обновляет scripts/protogen.sh), поэтому __dirname покрывает и jest
 * (src/fraud/proto), и dist после nest build (assets).
 */
function protoPath(): string {
  const local = join(__dirname, 'proto', 'detective.proto');
  if (existsSync(local)) return local;
  // запасной путь — канонический контракт монорепо (запуск из apps/api)
  return join(process.cwd(), '..', '..', 'proto', 'detective.proto');
}
