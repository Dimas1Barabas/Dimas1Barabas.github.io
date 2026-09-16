import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DEMO_PAYMENT_TIMEOUT_MS, demoEngine } from './demoEngine';
import { ApiError } from './client';
import { HALL_CAPACITY } from '../utils/hall';
import type { SeatMap } from './types';

/** Движок демо-режима должен повторять контракт реального API + поведение Go-воркера */

/** первое свободное место карты — чтобы тесты не зависели от посева */
function freeSeat(map: SeatMap): string {
  for (let row = 1; row <= map.layout.rows; row++) {
    for (let num = 1; num <= map.layout.seatsPerRow; num++) {
      const code = `${row}-${num}`;
      if (!map.occupied.includes(code)) return code;
    }
  }
  throw new Error('зал заполнен');
}

function firstFreeSeats(map: SeatMap, count: number): string[] {
  const seats: string[] = [];
  outer: for (let row = 1; row <= map.layout.rows; row++) {
    for (let num = 1; num <= map.layout.seatsPerRow; num++) {
      const code = `${row}-${num}`;
      if (!map.occupied.includes(code)) {
        seats.push(code);
        if (seats.length === count) break outer;
      }
    }
  }
  return seats;
}

/** первый фильм афиши и его первый сеанс — рабочая пара для большинства тестов */
function firstSession() {
  const movie = demoEngine.movies().data[0];
  const session = movie.sessions[0];
  if (!session) throw new Error('в демо-фикстуре нет сеансов');
  return { movie, session };
}

describe('demoEngine', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    demoEngine.reset();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('первая выдача фильмов «из БД», повторная — «из кэша»', () => {
    const first = demoEngine.movies();
    const second = demoEngine.movies();

    expect(first.source).toBe('db');
    expect(second.source).toBe('cache');
    expect(first.data.length).toBeGreaterThan(0);
    expect(first.data[0]).toMatchObject({
      id: expect.any(String),
      title: expect.any(String),
      priceRub: expect.any(Number),
      sessions: expect.any(Array),
    });
    // у каждого фильма — расписание, отсортированное по времени
    for (const movie of first.data) {
      expect(movie.sessions.length).toBeGreaterThanOrEqual(2);
      const times = movie.sessions.map((s) => Date.parse(s.startsAt));
      expect([...times].sort((a, b) => a - b)).toEqual(times);
    }
  });

  it('seatMap: геометрия зала, часть мест посеяна, счётчик сходится', () => {
    const { session } = firstSession();
    const map = demoEngine.seatMap(session.id);

    expect(map.sessionId).toBe(session.id);
    expect(map.layout).toEqual({ rows: 8, seatsPerRow: 10 });
    expect(map.occupied.length).toBeGreaterThan(0); // зал не пустой
    expect(map.occupied.length).toBeLessThan(HALL_CAPACITY);
    expect(map.free).toBe(HALL_CAPACITY - map.occupied.length);
    // посев детерминирован: та же карта при повторном запросе
    expect(demoEngine.seatMap(session.id).occupied).toEqual(map.occupied);
  });

  it('seatMap: неизвестный сеанс — ошибка', () => {
    expect(() => demoEngine.seatMap('нет-такого')).toThrow();
  });

  it('create: PENDING_PAYMENT с местами и дедлайном; pay → вердикт «воркера»', async () => {
    const { movie, session } = firstSession();
    const seats = firstFreeSeats(demoEngine.seatMap(session.id), 3);
    // 0.1 < SUCCESS_RATE → «воркер» подтверждает оплату (и тайминг 1,36 с)
    const randomSpy = vi.spyOn(Math, 'random').mockReturnValue(0.1);
    const booking = demoEngine.create({
      sessionId: session.id,
      customerName: 'Тест',
      seats,
    });

    expect(booking.status).toBe('PENDING_PAYMENT');
    expect(booking.seats).toEqual(seats);
    expect(booking.totalRub).toBe(movie.priceRub * 3);
    expect(booking.sessionId).toBe(session.id);
    expect(booking.sessionAt).toBe(session.startsAt);
    expect(booking.hall).toBe(session.hall);
    expect(booking.message).toBeNull();
    expect(booking.expiresAt).toBeTruthy(); // дедлайн = окно оплаты демо

    const inList = demoEngine.list()[0];
    expect(inList.id).toBe(booking.id);

    // до оплаты вердикта нет — резервируем место, «воркер» молчит
    await vi.advanceTimersByTimeAsync(3000);
    expect(demoEngine.list()[0].status).toBe('PENDING_PAYMENT');

    // pay запускает «воркера»: срабатывает в окне 1,2–2,8 c
    const paid = demoEngine.pay(booking.id);
    expect(paid.status).toBe('PENDING');
    await vi.advanceTimersByTimeAsync(3000);
    randomSpy.mockRestore();
    const done = demoEngine.list()[0];
    expect(done.status).toBe('CONFIRMED');
    expect(done.message).toContain(seats.join(', ')); // в чеке — реальные места
    expect(done.processedBy).toBe('go-worker (демо)');
    expect(done.processedAt).toBeTruthy();
  });

  it('изоляция: одно место независимо в разных сеансах одного фильма', () => {
    const { movie } = firstSession();
    const [first, second] = movie.sessions;
    if (!second) throw new Error('в фикстуре должно быть ≥2 сеанса');

    const seat = freeSeat(demoEngine.seatMap(first.id));
    demoEngine.create({ sessionId: first.id, customerName: 'Первый', seats: [seat] });

    // то же место во втором сеансе — свободно
    expect(() =>
      demoEngine.create({ sessionId: second.id, customerName: 'Второй', seats: [seat] }),
    ).not.toThrow();

    // но в первом сеансе оно уже занято
    expect(() =>
      demoEngine.create({ sessionId: first.id, customerName: 'Дубль', seats: [seat] }),
    ).toThrow(ApiError);
  });

  it('create: занятое место — ApiError 409 со списком мест', () => {
    const { session } = firstSession();
    const map = demoEngine.seatMap(session.id);
    const taken = map.occupied[0];
    const fresh = freeSeat(map);

    const conflict = () =>
      demoEngine.create({
        sessionId: session.id,
        customerName: 'Конфликт',
        seats: [fresh, taken],
      });

    expect(conflict).toThrow(ApiError);
    try {
      conflict();
    } catch (err) {
      const apiErr = err as ApiError;
      expect(apiErr.status).toBe(409);
      expect(JSON.parse(apiErr.body).seatsTaken).toEqual([taken]);
    }
    // свободное место из отклонённой брони не занялось
    expect(demoEngine.seatMap(session.id).occupied).not.toContain(fresh);
  });

  it('create: дубли мест в запросе схлопываются, неверный код — 400', () => {
    const { session } = firstSession();
    const seat = freeSeat(demoEngine.seatMap(session.id));

    const booking = demoEngine.create({
      sessionId: session.id,
      customerName: 'Дубли',
      seats: [seat, seat],
    });
    expect(booking.seats).toEqual([seat]);

    expect(() =>
      demoEngine.create({ sessionId: session.id, customerName: 'Бред', seats: ['99-1'] }),
    ).toThrow(ApiError);
  });

  it('FAILED освобождает место — его снова можно забронировать', async () => {
    const { session } = firstSession();
    const seat = freeSeat(demoEngine.seatMap(session.id));

    // вердикт «воркера» зависит от Math.random: 0.95 > SUCCESS_RATE → отказ
    const randomSpy = vi.spyOn(Math, 'random').mockReturnValue(0.95);
    const created = demoEngine.create({ sessionId: session.id, customerName: 'Отказ', seats: [seat] });
    demoEngine.pay(created.id);
    await vi.advanceTimersByTimeAsync(3000);
    randomSpy.mockRestore();

    expect(demoEngine.list()[0].status).toBe('FAILED');
    expect(demoEngine.seatMap(session.id).occupied).not.toContain(seat);

    // место снова в продаже — повторная бронь проходит без конфликта
    expect(() =>
      demoEngine.create({ sessionId: session.id, customerName: 'Повтор', seats: [seat] }),
    ).not.toThrow();
  });

  it('неоплаченная за окно брони истекает: EXPIRED, места свободны', async () => {
    const { session } = firstSession();
    const seat = freeSeat(demoEngine.seatMap(session.id));
    demoEngine.create({ sessionId: session.id, customerName: 'Забыл заплатить', seats: [seat] });

    // ждём дедлайн (wait-очередь демо) — вердикт экспирации
    await vi.advanceTimersByTimeAsync(DEMO_PAYMENT_TIMEOUT_MS + 1000);

    const expired = demoEngine.list()[0];
    expect(expired.status).toBe('EXPIRED');
    expect(expired.message).toContain('истекло');
    expect(expired.processedBy).toBe('go-worker (демо)');
    expect(demoEngine.seatMap(session.id).occupied).not.toContain(seat);

    // оплачивать больше нечего — 409 с текущим статусом
    expect(() => demoEngine.pay(expired.id)).toThrow(ApiError);
  });

  it('pay снимает таймер экспирации: оплаченная бронь не истекает', async () => {
    const { session } = firstSession();
    const seat = freeSeat(demoEngine.seatMap(session.id));
    const randomSpy = vi.spyOn(Math, 'random').mockReturnValue(0.1); // оплата проходит
    const created = demoEngine.create({ sessionId: session.id, customerName: 'Успел', seats: [seat] });
    demoEngine.pay(created.id);
    await vi.advanceTimersByTimeAsync(3000);

    // дедлайн давно прошёл — но бронь уже CONFIRMED, не EXPIRED
    await vi.advanceTimersByTimeAsync(DEMO_PAYMENT_TIMEOUT_MS);
    randomSpy.mockRestore();
    expect(demoEngine.list()[0].status).toBe('CONFIRMED');
    expect(demoEngine.seatMap(session.id).occupied).toContain(seat);
  });

  it('статистика сходится со списком', async () => {
    const { session } = firstSession();
    const seats = firstFreeSeats(demoEngine.seatMap(session.id), 2);
    demoEngine.create({ sessionId: session.id, customerName: 'Стат', seats: [seats[0]] });
    demoEngine.create({ sessionId: session.id, customerName: 'Стат', seats: [seats[1]] });

    let stats = demoEngine.stats();
    expect(stats.PENDING_PAYMENT).toBeGreaterThanOrEqual(2);
    // сиды «других зрителей» уже терминальные — их вердикты в базовой линии
    const doneBefore = stats.CONFIRMED + stats.FAILED;

    // платим только свои PENDING_PAYMENT: pay по сиду кидает 409
    const mine = demoEngine.list().filter((b) => b.status === 'PENDING_PAYMENT');
    for (const b of mine) demoEngine.pay(b.id);
    await vi.advanceTimersByTimeAsync(3000);

    stats = demoEngine.stats();
    expect(stats.PENDING_PAYMENT).toBe(0);
    expect(stats.CONFIRMED + stats.FAILED).toBe(doneBefore + mine.length);
  });

  it('уведомляет подписчиков при изменениях', async () => {
    const cb = vi.fn();
    const off = demoEngine.onChange(cb);

    const { session } = firstSession();
    const seat = freeSeat(demoEngine.seatMap(session.id));
    const created = demoEngine.create({ sessionId: session.id, customerName: 'Подписка', seats: [seat] });

    expect(cb).toHaveBeenCalledTimes(1); // создание PENDING_PAYMENT

    demoEngine.pay(created.id);
    expect(cb).toHaveBeenCalledTimes(2); // переход в PENDING

    await vi.advanceTimersByTimeAsync(3000);
    expect(cb).toHaveBeenCalledTimes(3); // вердикт «воркера»

    off();
    demoEngine.create({
      sessionId: session.id,
      customerName: 'После отписки',
      seats: [freeSeat(demoEngine.seatMap(session.id))],
    });
    expect(cb).toHaveBeenCalledTimes(3);
  });

  it('неизвестный сеанс — ошибка', () => {
    expect(() =>
      demoEngine.create({ sessionId: 'нет-такого', customerName: 'X', seats: ['1-1'] }),
    ).toThrow();
  });

  it('cancel: CONFIRMED → CANCELLING → возврат освобождает место', async () => {
    const { session } = firstSession();
    const seat = freeSeat(demoEngine.seatMap(session.id));
    // 0.1 < SUCCESS_RATE и < REFUND_SUCCESS_RATE: и оплата, и возврат проходят
    const randomSpy = vi.spyOn(Math, 'random').mockReturnValue(0.1);
    const created = demoEngine.create({ sessionId: session.id, customerName: 'Отмена', seats: [seat] });
    demoEngine.pay(created.id);
    await vi.advanceTimersByTimeAsync(3000);
    expect(demoEngine.list()[0].status).toBe('CONFIRMED');

    const cancelling = demoEngine.cancel(demoEngine.list()[0].id);
    expect(cancelling.status).toBe('CANCELLING');
    // до вердикта возврата место держится занятым
    expect(demoEngine.seatMap(session.id).occupied).toContain(seat);

    // возврат срабатывает в окне 0,8–1,6 c
    await vi.advanceTimersByTimeAsync(2000);
    randomSpy.mockRestore();
    const done = demoEngine.list()[0];
    expect(done.status).toBe('CANCELLED');
    expect(done.message).toContain('Возврат');
    expect(done.processedBy).toBe('go-worker (демо)');
    expect(demoEngine.seatMap(session.id).occupied).not.toContain(seat);

    // место снова можно купить
    expect(() =>
      demoEngine.create({ sessionId: session.id, customerName: 'Повтор', seats: [seat] }),
    ).not.toThrow();
  });

  it('cancel: неоплаченная (PENDING_PAYMENT) закрывается сразу, место свободно', () => {
    const { session } = firstSession();
    const seat = freeSeat(demoEngine.seatMap(session.id));
    const booking = demoEngine.create({
      sessionId: session.id,
      customerName: 'Передумал',
      seats: [seat],
    });

    const cancelled = demoEngine.cancel(booking.id);

    expect(cancelled.status).toBe('CANCELLED');
    expect(cancelled.message).toContain('до оплаты');
    expect(demoEngine.seatMap(session.id).occupied).not.toContain(seat);
  });

  it('cancel: PENDING (платёж в полёте) — ApiError 409', () => {
    const { session } = firstSession();
    const seat = freeSeat(demoEngine.seatMap(session.id));
    const booking = demoEngine.create({
      sessionId: session.id,
      customerName: 'Нетерпеливый',
      seats: [seat],
    });
    demoEngine.pay(booking.id); // PENDING — воркер ещё думает

    expect(() => demoEngine.cancel(booking.id)).toThrow(ApiError);
    try {
      demoEngine.cancel(booking.id);
    } catch (err) {
      expect((err as ApiError).status).toBe(409);
      expect(JSON.parse((err as ApiError).body).status).toBe('PENDING');
    }
  });

  it('pay: не-PENDING_PAYMENT бронь — ApiError 409 (двойной клик)', () => {
    const { session } = firstSession();
    const seat = freeSeat(demoEngine.seatMap(session.id));
    const booking = demoEngine.create({
      sessionId: session.id,
      customerName: 'Двойной клик',
      seats: [seat],
    });
    demoEngine.pay(booking.id);

    expect(() => demoEngine.pay(booking.id)).toThrow(ApiError);
    try {
      demoEngine.pay(booking.id);
    } catch (err) {
      expect((err as ApiError).status).toBe(409);
      expect(JSON.parse((err as ApiError).body).status).toBe('PENDING');
    }
  });

  it('cancel: REFUND_FAILED откатывает в CONFIRMED, место держится', async () => {
    const { session } = firstSession();
    const seat = freeSeat(demoEngine.seatMap(session.id));
    const randomSpy = vi.spyOn(Math, 'random').mockReturnValue(0.1); // оплата проходит
    const created = demoEngine.create({ sessionId: session.id, customerName: 'Банк не смог', seats: [seat] });
    demoEngine.pay(created.id);
    await vi.advanceTimersByTimeAsync(3000);

    randomSpy.mockReturnValue(0.95); // 0.95 > REFUND_SUCCESS_RATE → отказ возврата
    demoEngine.cancel(demoEngine.list()[0].id);
    await vi.advanceTimersByTimeAsync(2000);
    randomSpy.mockRestore();

    const restored = demoEngine.list()[0];
    expect(restored.status).toBe('CONFIRMED');
    expect(restored.message).toContain('возврат');
    expect(demoEngine.seatMap(session.id).occupied).toContain(seat);
  });

  it('cancel: несуществующая бронь — ошибка', () => {
    expect(() => demoEngine.cancel('нет-такого')).toThrow();
  });

  // ── Отзывы и рейтинги ────────────────────────────────────────────────

  /** подтверждённая демо-бронь на фильм (pay + вердикт «воркера») */
  async function confirmBooking(movieId: string): Promise<void> {
    const movie = demoEngine.movies().data.find((m) => m.id === movieId);
    if (!movie) throw new Error('нет фильма');
    const session = movie.sessions[0];
    if (!session) throw new Error('нет сеансов');
    const seat = freeSeat(demoEngine.seatMap(session.id));
    const randomSpy = vi.spyOn(Math, 'random').mockReturnValue(0.1);
    const created = demoEngine.create({
      sessionId: session.id,
      customerName: 'Тест',
      seats: [seat],
    });
    demoEngine.pay(created.id);
    await vi.advanceTimersByTimeAsync(3000);
    randomSpy.mockRestore();
    expect(demoEngine.canReview(movieId)).toBe(true);
  }

  /** фильм без сид-отзывов — чистая база для тестов отзыва гостя */
  const CLEAN_MOVIE = 'demo-cache-lady';

  it('отзывы: сиды на месте, агрегаты фильмов совпадают с ними', () => {
    const seeded = demoEngine.reviewsOf('demo-milky-way');
    expect(seeded).toHaveLength(2);
    // свежие сверху: у Игоря daysAgo 1, у Ольги 3
    expect(seeded[0].authorName).toBe('Игорь');
    expect(seeded.every((r) => r.userId.startsWith('demo-seed-'))).toBe(true);

    const movies = demoEngine.movies().data;
    const milky = movies.find((m) => m.id === 'demo-milky-way');
    expect(milky).toMatchObject({ ratingAvg: 4.5, ratingCount: 2 });
    const clean = movies.find((m) => m.id === CLEAN_MOVIE);
    expect(clean).toMatchObject({ ratingAvg: 0, ratingCount: 0 });
    // у фильма без отзывов список пуст
    expect(demoEngine.reviewsOf(CLEAN_MOVIE)).toEqual([]);
  });

  it('movies() отдаёт копии: старая выдача не видит новый рейтинг', async () => {
    const before = demoEngine.movies().data;
    await confirmBooking(CLEAN_MOVIE);
    demoEngine.createReview(CLEAN_MOVIE, {
      rating: 5,
      text: 'Драма держит в напряжении до титров!',
    });

    // старые объекты — прежний рейтинг (как JSON, ушедший по проводу)
    expect(before.find((m) => m.id === CLEAN_MOVIE)?.ratingCount).toBe(0);
    // новая выдача — свежий агрегат
    const after = demoEngine.movies().data;
    expect(after.find((m) => m.id === CLEAN_MOVIE)).toMatchObject({
      ratingAvg: 5,
      ratingCount: 1,
    });
  });

  it('createReview: без подтверждённой брони — 403 с пояснением', () => {
    expect(() =>
      demoEngine.createReview(CLEAN_MOVIE, { rating: 5, text: 'Хочу отзыв без брони!' }),
    ).toThrow(ApiError);
    try {
      demoEngine.createReview(CLEAN_MOVIE, { rating: 5, text: 'Хочу отзыв без брони!' });
    } catch (e) {
      expect((e as ApiError).status).toBe(403);
      expect(JSON.parse((e as ApiError).body).message).toContain('бронь');
    }
  });

  it('createReview: после брони — создаётся, агрегат растёт, подписчик оповещён', async () => {
    await confirmBooking(CLEAN_MOVIE);
    const cb = vi.fn();
    demoEngine.onChange(cb);

    const review = demoEngine.createReview(CLEAN_MOVIE, {
      rating: 4,
      text: '  Игра актрисы выше всяких похвал.  ',
    });

    expect(review).toMatchObject({
      movieId: CLEAN_MOVIE,
      authorName: 'Гость',
      rating: 4,
      text: 'Игра актрисы выше всяких похвал.',
    });
    expect(demoEngine.reviewsOf(CLEAN_MOVIE)[0].id).toBe(review.id);
    expect(cb).toHaveBeenCalledTimes(1);
    expect(demoEngine.movies().data.find((m) => m.id === CLEAN_MOVIE)).toMatchObject(
      { ratingAvg: 4, ratingCount: 1 },
    );
  });

  it('createReview: дубль гостя — 409 reviewExists', async () => {
    await confirmBooking(CLEAN_MOVIE);
    demoEngine.createReview(CLEAN_MOVIE, {
      rating: 5,
      text: 'Первый отзыв уже написан.',
    });

    try {
      demoEngine.createReview(CLEAN_MOVIE, {
        rating: 3,
        text: 'Передумал, теперь три звезды.',
      });
      expect.unreachable('дубль должен был упасть 409');
    } catch (e) {
      expect(e).toBeInstanceOf(ApiError);
      expect((e as ApiError).status).toBe(409);
      expect(JSON.parse((e as ApiError).body).code).toBe('reviewExists');
    }
    // агрегат не задвоился
    expect(
      demoEngine.movies().data.find((m) => m.id === CLEAN_MOVIE)?.ratingCount,
    ).toBe(1);
  });

  it('createReview: валидация — 400 на оценку и короткий текст', async () => {
    await confirmBooking(CLEAN_MOVIE);
    expect(() =>
      demoEngine.createReview(CLEAN_MOVIE, { rating: 6, text: 'Валидный текст отзыва.' }),
    ).toThrow(ApiError);
    try {
      demoEngine.createReview(CLEAN_MOVIE, { rating: 6, text: 'Валидный текст отзыва.' });
    } catch (e) {
      expect((e as ApiError).status).toBe(400);
    }
    expect(() =>
      demoEngine.createReview(CLEAN_MOVIE, { rating: 5, text: 'коротко' }),
    ).toThrow(ApiError);
  });

  it('deleteReview: пересчитывает агрегат и оповещает', async () => {
    await confirmBooking(CLEAN_MOVIE);
    const review = demoEngine.createReview(CLEAN_MOVIE, {
      rating: 2,
      text: 'Не зашло, но это дело вкуса.',
    });
    const cb = vi.fn();
    demoEngine.onChange(cb);

    demoEngine.deleteReview(CLEAN_MOVIE, review.id);

    expect(demoEngine.reviewsOf(CLEAN_MOVIE)).toEqual([]);
    expect(
      demoEngine.movies().data.find((m) => m.id === CLEAN_MOVIE),
    ).toMatchObject({ ratingAvg: 0, ratingCount: 0 });
    expect(cb).toHaveBeenCalledTimes(1);
    expect(() => demoEngine.deleteReview(CLEAN_MOVIE, review.id)).toThrow();
  });

  it('reset восстанавливает сид-отзывы и агрегаты', async () => {
    await confirmBooking(CLEAN_MOVIE);
    demoEngine.createReview(CLEAN_MOVIE, {
      rating: 5,
      text: 'След исчезает после сброса.',
    });
    expect(demoEngine.reviewsOf(CLEAN_MOVIE)).toHaveLength(1);

    demoEngine.reset();

    expect(demoEngine.reviewsOf(CLEAN_MOVIE)).toEqual([]);
    expect(demoEngine.canReview(CLEAN_MOVIE)).toBe(false);
    expect(
      demoEngine.movies().data.find((m) => m.id === CLEAN_MOVIE)?.ratingCount,
    ).toBe(0);
    expect(demoEngine.reviewsOf('demo-milky-way')).toHaveLength(2);
  });

  // ── Админ-аналитика ─────────────────────────────────────────────────

  it('сид-брони: табло непустое, статусы терминальные, владельцы чужие', () => {
    const list = demoEngine.list();
    expect(list.length).toBeGreaterThanOrEqual(10);
    // сиды — «другие зрители»: гость не владеет ими (право отзыва не даётся)
    for (const b of list) {
      expect(b.userId).not.toBeNull();
      expect(b.processedBy).toBe('go-worker (демо)');
    }

    const stats = demoEngine.stats();
    const sum = Object.values(stats).reduce((acc, n) => acc + n, 0);
    expect(sum).toBe(list.length);
    expect(stats.CONFIRMED).toBeGreaterThan(0); // выручке есть из чего браться
  });

  it('canReview: CONFIRMED-сиды чужих зрителей права не дают', () => {
    // у cache-lady есть CONFIRMED-сид, но гость на фильм не ходил
    expect(demoEngine.canReview(CLEAN_MOVIE)).toBe(false);
  });

  it('adminStats: сводка и топ сходятся с сидами; конверт source=db', () => {
    const { source, data } = demoEngine.adminStats();

    expect(source).toBe('db');
    const list = demoEngine.list();
    const confirmed = list.filter((b) => b.status === 'CONFIRMED');
    expect(data.totals.bookingsTotal).toBe(list.length);
    expect(data.totals.confirmed).toBe(confirmed.length);
    expect(data.totals.revenueRub).toBe(
      confirmed.reduce((acc, b) => acc + b.totalRub, 0),
    );
    expect(data.totals.moviesCount).toBe(6);
    expect(data.totals.reviewsCount).toBe(4); // сид-отзывы

    // все 7 статусов, сумма счётчиков — всей истории
    expect(Object.keys(data.byStatus)).toHaveLength(7);
    const sum = Object.values(data.byStatus).reduce((acc, n) => acc + n, 0);
    expect(sum).toBe(list.length);

    // топ возглавляет «Млечный Путь»: 4 брони, 9 мест, 4050 ₽
    expect(data.topMovies).toHaveLength(5);
    expect(data.topMovies[0]).toMatchObject({
      movieId: 'demo-milky-way',
      title: 'Млечный Путь: Операция «Туманность»',
      bookings: 4,
      seats: 9,
      revenueRub: 4050,
    });
  });

  it('adminStats: предстоящие сеансы по времени, занятость не ниже сид-мест', () => {
    const { data } = demoEngine.adminStats();

    const times = data.upcomingSessions.map((s) => Date.parse(s.startsAt));
    expect([...times].sort((a, b) => a - b)).toEqual(times);
    expect(data.upcomingSessions.length).toBeLessThanOrEqual(8);

    // CONFIRMED-сиды держат места своих сеансов (как seat_occupancy)
    const seedSeats = new Map<string, number>();
    for (const b of demoEngine.list()) {
      if (b.status === 'CONFIRMED') {
        seedSeats.set(
          b.sessionId,
          (seedSeats.get(b.sessionId) ?? 0) + b.seats.length,
        );
      }
    }
    expect(data.upcomingSessions.length).toBeGreaterThan(0);
    for (const s of data.upcomingSessions) {
      expect(s.capacity).toBe(HALL_CAPACITY);
      expect(s.occupied).toBeGreaterThanOrEqual(seedSeats.get(s.sessionId) ?? 0);
      expect(s.occupancyPct).toBe(Math.round((s.occupied / s.capacity) * 100));
    }
  });

  it('adminStats: график — 14 дней подряд, сумма столбцов равна выручке', () => {
    const { data } = demoEngine.adminStats();

    expect(data.revenueByDay).toHaveLength(14);
    for (let i = 1; i < data.revenueByDay.length; i++) {
      expect(
        Date.parse(data.revenueByDay[i].day) - Date.parse(data.revenueByDay[i - 1].day),
      ).toBe(24 * 3600_000);
    }
    const sum = data.revenueByDay.reduce((acc, d) => acc + d.revenueRub, 0);
    expect(sum).toBe(data.totals.revenueRub); // все сиды попадают в окно
  });

  it('adminStats: кэш 30 c — повторный из кэша, по TTL и reset — пересчёт', () => {
    const first = demoEngine.adminStats();
    expect(first.source).toBe('db');

    const second = demoEngine.adminStats();
    expect(second.source).toBe('cache');
    expect(second.data.totals).toEqual(first.data.totals);

    // копии: выдачи не делят объекты (движок вне реактивности Vue)
    expect(second.data).not.toBe(first.data);

    // окно кэша истекло — пересчёт
    vi.advanceTimersByTime(31_000);
    expect(demoEngine.adminStats().source).toBe('db');

    // сброс состояния обнуляет кэш аналитики
    demoEngine.reset();
    expect(demoEngine.adminStats().source).toBe('db');
  });
});
