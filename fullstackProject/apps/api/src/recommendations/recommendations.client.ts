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

/** Кандидат афиши для КиноСоветника (camelCase — как в proto после загрузчика) */
export interface RecommendationCandidate {
  movieId: string;
  title: string;
  genre: string;
  ratingAvg: number;
  ratingCount: number;
}

/** Позиция топа «Вам понравится» */
export interface RecommendationItem {
  movieId: string;
  title: string;
  genre: string;
  score: number;
  reason: string;
}

/** На чём построен топ: профиль / холодный старт / нечего советовать / сервис недоступен */
export type RecommendationsBasis =
  | 'profile'
  | 'popular'
  | 'empty'
  | 'unavailable';

/** Ответ proto-loader не типизирован — описываем форму сами */
export interface RecommendationsGrpcResponse {
  items?: RecommendationItem[];
  basis?: string;
}

/** Сгенерированный стаб proto-loader'ом: callback-стиль grpc-js */
type RecommendationsStub = {
  GetRecommendations(
    request: { userId: string; candidates: RecommendationCandidate[]; limit: number },
    options: { deadline: Date },
    callback: (err: ServiceError | null, response: RecommendationsGrpcResponse) => void,
  ): void;
};

/** Конструктор сервиса из загруженного пакета proto */
type RecommendationsCtor = new (
  url: string,
  creds: ChannelCredentials,
) => RecommendationsStub;

/**
 * Тонкая обёртка над gRPC-клиентом КиноСоветника: proto-loader читает
 * контракт (.proto) в рантайме — кодоген для Node не нужен; grpc-js даёт
 * честные Promise. Соединение ленивое: клиент строится и без поднятого
 * сервиса, запросы уходят с дедлайном и не подвешивают витрину.
 */
@Injectable()
export class RecommendationsClient {
  private readonly stub: RecommendationsStub;

  constructor() {
    const def = loadSync(protoPath(), {
      keepCase: false, // поля в camelCase (movieId), как в остальном API
      longs: Number,
      enums: String,
      defaults: true,
      oneofs: true,
    });
    const pkg = loadPackageDefinition(def) as unknown as {
      cine: {
        recommendations: {
          v1: { Recommendations: RecommendationsCtor };
        };
      };
    };
    this.stub = new pkg.cine.recommendations.v1.Recommendations(
      grpcUrl(),
      credentials.createInsecure(), // внутри docker-сети стенда TLS не нужен
    );
  }

  /** Топ афиши зрителя; дедлайн оберегает вызывающего от зависшего сервиса */
  forUser(
    userId: string,
    candidates: RecommendationCandidate[],
    limit = 4,
  ): Promise<RecommendationsGrpcResponse> {
    return new Promise((resolve, reject) => {
      this.stub.GetRecommendations(
        { userId, candidates, limit },
        { deadline: new Date(Date.now() + deadlineMs()) },
        (err, res) => (err ? reject(err) : resolve(res)),
      );
    });
  }
}

/** Куда ходить за рекомендациями: dev — хост-порт стенда, compose — сеть */
function grpcUrl(): string {
  return process.env.GRPC_RECOMMENDATION_URL ?? 'localhost:18084';
}

/** Дедлайн gRPC-вызова: витрина не ждёт дольше, чем стоит блок «Вам понравится» */
function deadlineMs(): number {
  const parsed = Number.parseInt(
    process.env.GRPC_RECOMMENDATION_TIMEOUT_MS ?? '',
    10,
  );
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 3000;
}

/**
 * .proto живёт рядом с кодом (копия контракта из fullstackProject/proto —
 * обновляет scripts/protogen.sh), поэтому __dirname покрывает и jest
 * (src/recommendations/proto), и dist после nest build (assets).
 */
function protoPath(): string {
  const local = join(__dirname, 'proto', 'recommendation.proto');
  if (existsSync(local)) return local;
  // запасной путь — канонический контракт монорепо (запуск из apps/api)
  return join(process.cwd(), '..', '..', 'proto', 'recommendation.proto');
}
