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
import { FlagSnapshot } from './bucketing';

/** Вход UpsertFlag (camelCase — как в proto после загрузчика) */
export interface UpsertFlagInput {
  key: string;
  description: string;
  enabled: boolean;
  percentage: number;
  killed: boolean;
  /** варианты A/B-эксперимента — ПОЛНОЕ состояние (upsert перезаписывает) */
  variants?: FlagSnapshot['variants'];
  updatedBy: string;
}

/** Ответы proto-loader не типизированы — описываем форму сами */
export interface EvaluateGrpcResponse {
  enabled?: boolean;
  reason?: string;
  percentage?: number;
  variant?: string;
}

/** Ответ ReportExposure/ReportConversion */
export interface ReportGrpcResponse {
  variant?: string;
  counted?: boolean;
}

export interface FlagStateGrpc extends FlagSnapshot {}

type FlagsStub = {
  Evaluate(
    request: { key: string; entityId: string },
    options: { deadline: Date },
    callback: (err: ServiceError | null, response: EvaluateGrpcResponse) => void,
  ): void;
  ListFlags(
    request: object,
    options: { deadline: Date },
    callback: (err: ServiceError | null, response: { flags?: FlagStateGrpc[] }) => void,
  ): void;
  UpsertFlag(
    request: UpsertFlagInput,
    options: { deadline: Date },
    callback: (err: ServiceError | null, response: FlagStateGrpc) => void,
  ): void;
  DeleteFlag(
    request: { key: string },
    options: { deadline: Date },
    callback: (err: ServiceError | null, response: { deleted?: boolean }) => void,
  ): void;
  ReportExposure(
    request: { key: string; entityId: string },
    options: { deadline: Date },
    callback: (err: ServiceError | null, response: ReportGrpcResponse) => void,
  ): void;
  ReportConversion(
    request: { key: string; entityId: string },
    options: { deadline: Date },
    callback: (err: ServiceError | null, response: ReportGrpcResponse) => void,
  ): void;
};

/** Конструктор сервиса из загруженного пакета proto */
type FlagsCtor = new (url: string, creds: ChannelCredentials) => FlagsStub;

/**
 * Тонкая обёртка над gRPC-клиентом «Суфлёра»: proto-loader читает
 * контракт (.proto) в рантайме — кодоген для Node не нужен. Соединение
 * ленивое: клиент строится и без поднятого сервиса. Вызовы уходят
 * с коротким дедлайном — вердикты стоят на пути запросов; недоступность
 * гасится офлайн-снимком у вызывающего (FlagsEvaluator, fail-safe).
 */
@Injectable()
export class FlagsClient {
  private readonly stub: FlagsStub;

  constructor() {
    const def = loadSync(protoPath(), {
      keepCase: false, // поля в camelCase (entityId), как в остальном API
      longs: Number,
      enums: String,
      defaults: true,
      oneofs: true,
    });
    const pkg = loadPackageDefinition(def) as unknown as {
      cine: {
        flags: {
          v1: { Flags: FlagsCtor };
        };
      };
    };
    this.stub = new pkg.cine.flags.v1.Flags(
      grpcUrl(),
      credentials.createInsecure(), // внутри docker-сети стенда TLS не нужен
    );
  }

  /** Авторитетный вердикт сервиса (кэш API считает локально сам) */
  evaluate(key: string, entityId: string): Promise<EvaluateGrpcResponse> {
    return new Promise((resolve, reject) => {
      this.stub.Evaluate(
        { key, entityId },
        { deadline: new Date(Date.now() + deadlineMs()) },
        (err, res) => (err ? reject(err) : resolve(res)),
      );
    });
  }

  /** Снимок всех флагов — топливо локального кэша состояний */
  listFlags(): Promise<FlagSnapshot[]> {
    return new Promise((resolve, reject) => {
      this.stub.ListFlags(
        {},
        { deadline: new Date(Date.now() + deadlineMs()) },
        (err, res) => (err ? reject(err) : resolve(res.flags ?? [])),
      );
    });
  }

  /** Создать/обновить флаг (админка); штамп времени ставит сервис */
  upsertFlag(input: UpsertFlagInput): Promise<FlagSnapshot> {
    return new Promise((resolve, reject) => {
      this.stub.UpsertFlag(
        input,
        { deadline: new Date(Date.now() + deadlineMs()) },
        (err, res) => (err ? reject(err) : resolve(res)),
      );
    });
  }

  /** Удалить флаг; аудит правок в сервисе переживает удаление */
  deleteFlag(key: string): Promise<{ deleted?: boolean }> {
    return new Promise((resolve, reject) => {
      this.stub.DeleteFlag(
        { key },
        { deadline: new Date(Date.now() + deadlineMs()) },
        (err, res) => (err ? reject(err) : resolve(res)),
      );
    });
  }

  /**
   * Засчитать экспозицию: точка применения показана сущности. Вариант
   * не присылаем — сервис пересчитает его из бакетинга; несуществующий
   * флаг — counted=false, не ошибка.
   */
  reportExposure(key: string, entityId: string): Promise<ReportGrpcResponse> {
    return this.report('ReportExposure', key, entityId);
  }

  /** Засчитать конверсию: бизнес-событие сущности после экспозиции. */
  reportConversion(key: string, entityId: string): Promise<ReportGrpcResponse> {
    return this.report('ReportConversion', key, entityId);
  }

  private report(
    method: 'ReportExposure' | 'ReportConversion',
    key: string,
    entityId: string,
  ): Promise<ReportGrpcResponse> {
    return new Promise((resolve, reject) => {
      this.stub[method](
        { key, entityId },
        { deadline: new Date(Date.now() + deadlineMs()) },
        (err, res) => (err ? reject(err) : resolve(res)),
      );
    });
  }
}

/** Куда ходить за вердиктами: dev — хост-порт стенда, compose — сеть */
function grpcUrl(): string {
  return process.env.GRPC_FLAGS_URL ?? 'localhost:18095';
}

/** Дедлайн gRPC-вызова: вердикт не стоит долгого ожидания */
function deadlineMs(): number {
  const parsed = Number.parseInt(
    process.env.GRPC_FLAGS_TIMEOUT_MS ?? '',
    10,
  );
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 1000;
}

/**
 * .proto живёт рядом с кодом (копия контракта из fullstackProject/proto —
 * обновляет scripts/protogen.sh), поэтому __dirname покрывает и jest
 * (src/flags/proto), и dist после nest build (assets).
 */
function protoPath(): string {
  const local = join(__dirname, 'proto', 'flags.proto');
  if (existsSync(local)) return local;
  // запасной путь — канонический контракт монорепо (запуск из apps/api)
  return join(process.cwd(), '..', '..', 'proto', 'flags.proto');
}
