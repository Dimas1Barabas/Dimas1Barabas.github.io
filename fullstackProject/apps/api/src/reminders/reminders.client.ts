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

/** Что API шлёт при планировании напоминания (camelCase — как в proto после загрузчика) */
export interface ScheduleReminderInput {
  bookingId: string;
  userId: string;
  email: string;
  movieId: string;
  movieTitle: string;
  hall: string;
  /** момент сеанса, ISO */
  sessionAt: string;
  seats: string[];
}

/** Ответ proto-loader не типизирован — описываем форму сами */
export interface ScheduleReminderGrpcResponse {
  status?: string; // SCHEDULED
  dueAt?: string; // момент письма, RFC3339
}

export interface CancelReminderGrpcResponse {
  status?: string; // CANCELLED | MISSING
}

/** Сгенерированный стаб proto-loader'ом: callback-стиль grpc-js */
type RemindersStub = {
  Schedule(
    request: ScheduleReminderInput,
    options: { deadline: Date },
    callback: (err: ServiceError | null, response: ScheduleReminderGrpcResponse) => void,
  ): void;
  Cancel(
    request: { bookingId: string },
    options: { deadline: Date },
    callback: (err: ServiceError | null, response: CancelReminderGrpcResponse) => void,
  ): void;
};

/** Конструктор сервиса из загруженного пакета proto */
type RemindersCtor = new (url: string, creds: ChannelCredentials) => RemindersStub;

/**
 * Тонкая обёртка над gRPC-клиентом напоминаний: proto-loader читает
 * контракт (.proto) в рантайме — кодоген для Node не нужен. Соединение
 * ленивое: клиент строится и без поднятого сервиса. Вызовы уходят
 * с дедлайном и всегда fire-and-forget — недоступность напоминаний
 * не должна валить вердикты брони.
 */
@Injectable()
export class RemindersClient {
  private readonly stub: RemindersStub;

  constructor() {
    const def = loadSync(protoPath(), {
      keepCase: false, // поля в camelCase (bookingId), как в остальном API
      longs: Number,
      enums: String,
      defaults: true,
      oneofs: true,
    });
    const pkg = loadPackageDefinition(def) as unknown as {
      cine: {
        reminders: {
          v1: { Reminders: RemindersCtor };
        };
      };
    };
    this.stub = new pkg.cine.reminders.v1.Reminders(
      grpcUrl(),
      credentials.createInsecure(), // внутри docker-сети стенда TLS не нужен
    );
  }

  /** Запланировать письмо «скоро сеанс»; дедлайн оберегает вердиктный цикл */
  schedule(input: ScheduleReminderInput): Promise<ScheduleReminderGrpcResponse> {
    return new Promise((resolve, reject) => {
      this.stub.Schedule(
        input,
        { deadline: new Date(Date.now() + deadlineMs()) },
        (err, res) => (err ? reject(err) : resolve(res)),
      );
    });
  }

  /** Погасить напоминание при возврате билетов; MISSING — нормальный ответ */
  cancel(bookingId: string): Promise<CancelReminderGrpcResponse> {
    return new Promise((resolve, reject) => {
      this.stub.Cancel(
        { bookingId },
        { deadline: new Date(Date.now() + deadlineMs()) },
        (err, res) => (err ? reject(err) : resolve(res)),
      );
    });
  }
}

/** Куда ходить за напоминаниями: dev — хост-порт стенда, compose — сеть */
function grpcUrl(): string {
  return process.env.GRPC_REMINDER_URL ?? 'localhost:18086';
}

/** Дедлайн gRPC-вызова: планирование не стоит долгого ожидания */
function deadlineMs(): number {
  const parsed = Number.parseInt(
    process.env.GRPC_REMINDER_TIMEOUT_MS ?? '',
    10,
  );
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 3000;
}

/**
 * .proto живёт рядом с кодом (копия контракта из fullstackProject/proto —
 * обновляет scripts/protogen.sh), поэтому __dirname покрывает и jest
 * (src/reminders/proto), и dist после nest build (assets).
 */
function protoPath(): string {
  const local = join(__dirname, 'proto', 'reminder.proto');
  if (existsSync(local)) return local;
  // запасной путь — канонический контракт монорепо (запуск из apps/api)
  return join(process.cwd(), '..', '..', 'proto', 'reminder.proto');
}
