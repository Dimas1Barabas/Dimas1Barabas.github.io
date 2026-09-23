import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DEMO_PAYMENT_TIMEOUT_MS, demoEngine } from '@/shared/api/demo-engine';
import { ApiError } from '@/shared/api/client';
import { HALL_CAPACITY } from '@/shared/lib/hall';
import { signTicket, ticketCanonical, ticketQrOf } from '@/shared/lib/ticket';
import type { SeatMap } from '@/shared/api/types';

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

  describe('аккаунт: симуляция auth-модуля', () => {
    it('вход с любыми данными до регистрации; сессия — «свежая пара»', () => {
      const result = demoEngine.login('Anna@Example.com', 'secret123');

      expect(result.accessToken).toBe('demo-session');
      expect(result.user).toMatchObject({
        email: 'anna@example.com',
        name: 'Гость',
        role: 'user',
      });
    });

    it('после входа неверный пароль — 401 тем же текстом, что у API', () => {
      demoEngine.login('anna@example.com', 'secret123');

      expect(() => demoEngine.login('anna@example.com', 'wrong')).toThrowError(
        expect.objectContaining({ status: 401 }),
      );
      try {
        demoEngine.login('anna@example.com', 'wrong');
      } catch (err) {
        expect((err as ApiError).body).toContain('Неверный email или пароль');
      }
    });

    it('регистрация: имя сохраняется, занятый email — 409 emailTaken', () => {
      const user = demoEngine.register({
        email: 'bob@example.com',
        password: 'secret123',
        name: 'Боб',
      });
      expect(user).toMatchObject({ email: 'bob@example.com', name: 'Боб' });

      // свой email занят...
      expect(() =>
        demoEngine.register({ email: 'BOB@example.com', password: 'x'.repeat(8), name: 'Дубль' }),
      ).toThrowError(expect.objectContaining({ status: 409 }));
      // ...и демо-админ тоже
      expect(() =>
        demoEngine.register({ email: 'admin@cine.local', password: 'x'.repeat(8), name: 'Админ' }),
      ).toThrowError(expect.objectContaining({ status: 409 }));
    });

    it('профиль: имя/email меняются, ответ — новая пара с копией юзера', () => {
      demoEngine.login('anna@example.com', 'secret123');

      const result = demoEngine.updateProfile({ name: 'Анна Новая', email: 'anna@new.com' });

      expect(result.user).toMatchObject({ name: 'Анна Новая', email: 'anna@new.com' });
      expect(result.user).not.toBe(demoEngine.updateProfile({}).user); // копии, не одна ссылка

      // email демо-админа занят — 409 (паритет PATCH /users/me)
      expect(() => demoEngine.updateProfile({ email: 'admin@cine.local' })).toThrowError(
        expect.objectContaining({ status: 409 }),
      );
    });

    it('смена пароля: неверный текущий — 403, верный — принимает новый', () => {
      demoEngine.login('anna@example.com', 'secret123');

      expect(() =>
        demoEngine.changePassword('wrong-old', 'new-secret-9'),
      ).toThrowError(expect.objectContaining({ status: 403 }));

      demoEngine.changePassword('secret123', 'new-secret-9');
      // вход работает только с новым паролем
      expect(() => demoEngine.login('anna@example.com', 'secret123')).toThrow();
      expect(demoEngine.login('anna@example.com', 'new-secret-9').user.email).toBe(
        'anna@example.com',
      );
    });

    it('восстановление: forgot отдаёт токен, reset меняет пароль и логинит', () => {
      demoEngine.login('anna@example.com', 'secret123');
      const token = demoEngine.forgotPassword('anna@example.com');
      expect(token).toBe('demo-reset-token');

      const result = demoEngine.resetPassword(token, 'reset-new-9');
      expect(result.user.email).toBe('anna@example.com');

      expect(() => demoEngine.login('anna@example.com', 'secret123')).toThrow();
      expect(demoEngine.login('anna@example.com', 'reset-new-9').accessToken).toBe(
        'demo-session',
      );
    });

    it('мусорный токен сброса — 400 тем же текстом, что у API', () => {
      demoEngine.login('anna@example.com', 'secret123');
      try {
        demoEngine.resetPassword('нет-такой-ссылки-123456', 'whatever-9');
        throw new Error('ожидали 400');
      } catch (err) {
        expect((err as ApiError).status).toBe(400);
        expect((err as ApiError).body).toContain('Ссылка недействительна');
      }
    });

    it('logout гасит сессию: смена пароля после — 401', () => {
      demoEngine.login('anna@example.com', 'secret123');
      demoEngine.logout();

      expect(() => demoEngine.changePassword('secret123', 'next-9')).toThrowError(
        expect.objectContaining({ status: 401 }),
      );
    });
  });

  describe('промокоды', () => {
    /** неоплаченная бронь на 2 места первого фильма */
    function unpaidBooking() {
      const { movie, session } = firstSession();
      const seats = firstFreeSeats(demoEngine.seatMap(session.id), 2);
      return {
        total: movie.priceRub * 2,
        booking: demoEngine.create({
          sessionId: session.id,
          customerName: 'Промо',
          seats,
        }),
      };
    }

    it('validatePromo: превью процента и фикс-скидки, без списания', () => {
      const { total, booking } = unpaidBooking();

      const percent = demoEngine.validatePromo({
        code: 'cine10',
        bookingId: booking.id,
      });
      expect(percent).toEqual({
        code: 'CINE10',
        kind: 'percent',
        value: 10,
        discountRub: Math.round(total * 0.1),
        totalRub: total - Math.round(total * 0.1),
      });

      const fixed = demoEngine.validatePromo({
        code: 'SUMMER300',
        bookingId: booking.id,
      });
      expect(fixed.discountRub).toBe(300);
      expect(fixed.totalRub).toBe(total - 300);

      // превью ничего не списало
      const summer = demoEngine.listPromos().find((p) => p.code === 'SUMMER300');
      expect(summer?.usedCount).toBe(2);
    });

    it('validatePromo: 404 promoNotFound, 410 promoExpired, 409 promoExhausted', () => {
      const { booking } = unpaidBooking();
      const call = (code: string) =>
        demoEngine.validatePromo({ code, bookingId: booking.id });

      try {
        call('NOPE');
        throw new Error('ожидали 404');
      } catch (err) {
        expect((err as ApiError).status).toBe(404);
        expect(JSON.parse((err as ApiError).body).code).toBe('promoNotFound');
      }

      try {
        call('EXPIRED5');
        throw new Error('ожидали 410');
      } catch (err) {
        expect((err as ApiError).status).toBe(410);
        expect(JSON.parse((err as ApiError).body).code).toBe('promoExpired');
      }

      // SUMMER300: 2 из 3 — последнюю забираем, дальше исчерпан
      demoEngine.pay(booking.id, 'SUMMER300');
      const { booking: next } = unpaidBooking();
      try {
        demoEngine.validatePromo({ code: 'SUMMER300', bookingId: next.id });
        throw new Error('ожидали 409');
      } catch (err) {
        expect((err as ApiError).status).toBe(409);
        expect(JSON.parse((err as ApiError).body).code).toBe('promoExhausted');
      }
    });

    it('pay с промокодом: скидка на брони, счётчик растёт, вердикт со скидочной суммой', async () => {
      const { total, booking } = unpaidBooking();

      const paid = demoEngine.pay(booking.id, 'CINE10');
      expect(paid.status).toBe('PENDING');
      expect(paid.promoCode).toBe('CINE10');
      expect(paid.discountRub).toBe(Math.round(total * 0.1));
      expect(paid.totalRub).toBe(total - Math.round(total * 0.1));

      const cine = demoEngine.listPromos().find((p) => p.code === 'CINE10');
      expect(cine?.usedCount).toBe(1);

      // «воркер» подтверждает со скидочной суммой
      vi.spyOn(Math, 'random').mockReturnValue(0.1);
      await vi.advanceTimersByTimeAsync(3000);
      expect(paid.status).toBe('CONFIRMED');
      expect(paid.message).toContain(String(paid.totalRub));
      vi.restoreAllMocks();
    });

    it('pay: код исчерпан — 409, бронь осталась payable', () => {
      const { booking: warm } = unpaidBooking();
      demoEngine.pay(warm.id, 'SUMMER300'); // 3 из 3 — лимит кончился

      const { booking } = unpaidBooking();
      try {
        demoEngine.pay(booking.id, 'SUMMER300');
        throw new Error('ожидали 409');
      } catch (err) {
        expect((err as ApiError).status).toBe(409);
        expect(JSON.parse((err as ApiError).body).code).toBe('promoExhausted');
      }
      // «транзакция откатилась»: статус не переключён, место всё ещё её
      expect(booking.status).toBe('PENDING_PAYMENT');
      const stillPayable = demoEngine.pay(booking.id);
      expect(stillPayable.promoCode).toBeNull();
      expect(stillPayable.totalRub).toBe(booking.totalRub);
    });

    it('createPromo: дубль — 409 promoExists, процент >99 — 400; reset восстанавливает сиды', () => {
      const expiresAt = new Date(Date.now() + 86_400_000).toISOString();
      demoEngine.createPromo({
        code: 'newcode',
        kind: 'fixed',
        value: 150,
        maxActivations: 5,
        expiresAt,
      });
      expect(demoEngine.listPromos().some((p) => p.code === 'NEWCODE')).toBe(true);

      try {
        demoEngine.createPromo({
          code: 'NewCode',
          kind: 'fixed',
          value: 150,
          maxActivations: 5,
          expiresAt,
        });
        throw new Error('ожидали 409');
      } catch (err) {
        expect((err as ApiError).status).toBe(409);
        expect(JSON.parse((err as ApiError).body).code).toBe('promoExists');
      }

      try {
        demoEngine.createPromo({
          code: 'TOOBIG',
          kind: 'percent',
          value: 150,
          maxActivations: 5,
          expiresAt,
        });
        throw new Error('ожидали 400');
      } catch (err) {
        expect((err as ApiError).status).toBe(400);
      }

      demoEngine.reset();
      const codes = demoEngine.listPromos().map((p) => p.code);
      expect(codes).toEqual(
        expect.arrayContaining(['CINE10', 'SUMMER300', 'EXPIRED5']),
      );
      expect(codes).not.toContain('NEWCODE');
    });
  });

  describe('бонусы: ledger в миниатюре', () => {
    /** 0.1 < SUCCESS_RATE/REFUND_SUCCESS_RATE — вердикты и возвраты успешны */
    function happyRandom() {
      return vi.spyOn(Math, 'random').mockReturnValue(0.1);
    }

    it('сид счёта: баланс 350, история тремя движениями свежими сверху', () => {
      const account = demoEngine.myBonuses();

      expect(account.balance).toBe(350);
      expect(account.transactions).toHaveLength(3);
      expect(account.transactions[0].reason).toBe('cashback'); // 2 дня назад
      expect(account.transactions[2].reason).toBe('cashback'); // 10 дней назад
    });

    it('pay с бонусами: списание до вердикта, кэшбэк 5% от финальной суммы', async () => {
      const spy = happyRandom();
      const { movie, session } = firstSession();
      expect(movie.priceRub).toBeGreaterThanOrEqual(200);
      const booking = demoEngine.create({
        sessionId: session.id,
        customerName: 'Тест',
        seats: [freeSeat(demoEngine.seatMap(session.id))],
      });
      const spend = 100; // ≤ половины чека и ≤ баланса 350

      const paid = demoEngine.pay(booking.id, undefined, spend);
      expect(paid.totalRub).toBe(movie.priceRub - spend);
      expect(paid.bonusSpent).toBe(spend);
      expect(demoEngine.myBonuses().balance).toBe(250);

      await vi.advanceTimersByTimeAsync(3000);
      spy.mockRestore();
      const done = demoEngine.list()[0];
      expect(done.status).toBe('CONFIRMED');
      // кэшбэк 5% от финальной суммы, floor
      const cashback = Math.floor((movie.priceRub - spend) * 0.05);
      expect(demoEngine.myBonuses().balance).toBe(250 + cashback);
      expect(demoEngine.myBonuses().transactions[0]).toMatchObject({
        kind: 'accrual',
        reason: 'cashback',
        amount: cashback,
        bookingId: booking.id,
      });
    });

    it('больше половины чека — 409 bonusOverLimit, бронь осталась payable', () => {
      const { movie, session } = firstSession();
      const booking = demoEngine.create({
        sessionId: session.id,
        customerName: 'Тест',
        seats: [freeSeat(demoEngine.seatMap(session.id))],
      });
      const tooMuch = Math.floor(movie.priceRub / 2) + 1;

      try {
        demoEngine.pay(booking.id, undefined, tooMuch);
        expect.unreachable('должен был бросить 409');
      } catch (err) {
        expect((err as ApiError).status).toBe(409);
        expect(JSON.parse((err as ApiError).body).code).toBe('bonusOverLimit');
      }
      expect(demoEngine.list()[0].status).toBe('PENDING_PAYMENT');
      expect(demoEngine.myBonuses().balance).toBe(350);
    });

    it('не хватает баланса — 409 bonusInsufficient', () => {
      const { session } = firstSession();
      const booking = demoEngine.create({
        sessionId: session.id,
        customerName: 'Тест',
        seats: firstFreeSeats(demoEngine.seatMap(session.id), 2),
      });
      const total = booking.totalRub;
      const spend = Math.min(Math.floor(total / 2), 400); // лимит ок

      try {
        demoEngine.pay(booking.id, undefined, spend);
        expect.unreachable('должен был бросить 409');
      } catch (err) {
        expect((err as ApiError).status).toBe(409);
        expect(JSON.parse((err as ApiError).body).code).toBe(
          'bonusInsufficient',
        );
      }
    });

    it('FAILED-вердикт возвращает списанное', async () => {
      // 0.95 > SUCCESS_RATE — воркер отклоняет платёж
      const spy = vi.spyOn(Math, 'random').mockReturnValue(0.95);
      const { session } = firstSession();
      const booking = demoEngine.create({
        sessionId: session.id,
        customerName: 'Тест',
        seats: [freeSeat(demoEngine.seatMap(session.id))],
      });

      demoEngine.pay(booking.id, undefined, 100);
      expect(demoEngine.myBonuses().balance).toBe(250);

      await vi.advanceTimersByTimeAsync(3000);
      spy.mockRestore();
      expect(demoEngine.list()[0].status).toBe('FAILED');
      expect(demoEngine.myBonuses().balance).toBe(350);
      expect(demoEngine.myBonuses().transactions[0]).toMatchObject({
        kind: 'accrual',
        reason: 'payment_failed',
        amount: 100,
      });
    });

    it('отмена CONFIRMED-брони: разворот — списанное вернулось, кэшбэк погасился', async () => {
      const spy = happyRandom();
      const { movie, session } = firstSession();
      const booking = demoEngine.create({
        sessionId: session.id,
        customerName: 'Тест',
        seats: [freeSeat(demoEngine.seatMap(session.id))],
      });

      demoEngine.pay(booking.id, undefined, 100);
      await vi.advanceTimersByTimeAsync(3000); // CONFIRMED + кэшбэк 12 (250×5%)
      demoEngine.cancel(booking.id);
      await vi.advanceTimersByTimeAsync(2000); // возврат прошёл
      spy.mockRestore();

      const account = demoEngine.myBonuses();
      const cashback = Math.floor((movie.priceRub - 100) * 0.05);
      // 350 − 100 + кэшбэк + 100 (refund) − кэшбэк (clawback) = 350
      expect(account.balance).toBe(350);
      const reasons = account.transactions
        .filter((t) => t.bookingId === booking.id)
        .map((t) => `${t.kind}/${t.reason}`);
      expect(reasons).toContain('spend/payment');
      expect(reasons).toContain(`accrual/cashback`);
      expect(reasons).toContain('accrual/refund');
      expect(reasons).toContain('spend/clawback');
    });
  });

  describe('QR-билеты', () => {
    /** сеанс в будущем — сканер честно отвергает прошедшие сеансы */
    function futureSession() {
      for (const movie of demoEngine.movies().data) {
        const session = movie.sessions.find(
          (s) => Date.parse(s.startsAt) > Date.now(),
        );
        if (session) return { movie, session };
      }
      throw new Error('в демо-фикстуре нет будущих сеансов');
    }

    /** оплаченная бронь, доведённая «воркером» до CONFIRMED */
    async function confirmedBooking(seatCount: number) {
      const { session } = futureSession();
      const seats = firstFreeSeats(demoEngine.seatMap(session.id), seatCount);
      const randomSpy = vi.spyOn(Math, 'random').mockReturnValue(0.1);
      const booking = demoEngine.create({
        sessionId: session.id,
        customerName: 'Билетник',
        seats,
      });
      demoEngine.pay(booking.id);
      await vi.advanceTimersByTimeAsync(3000);
      randomSpy.mockRestore();
      expect(booking.status).toBe('CONFIRMED');
      return booking;
    }

    it('CONFIRMED: по билету на место, подпись hex-128, номер TK-XXXXXX', async () => {
      const booking = await confirmedBooking(2);

      const tickets = demoEngine.tickets(booking.id);
      expect(tickets).toHaveLength(2);
      expect(tickets.map((t) => t.seat)).toEqual(booking.seats);
      for (const ticket of tickets) {
        expect(ticket.signature).toMatch(/^[0-9a-f]{32}$/);
        expect(ticket.ticketNo).toMatch(/^TK-[0-9A-Z]{6}$/);
        expect(ticket.movieTitle).toBe(booking.movieTitle);
        expect(ticket.hall).toBe(booking.hall);
        expect(ticket.sessionAt).toBe(booking.sessionAt);
      }
      // производная без состояния: повторная выдача — те же подписи
      expect(demoEngine.tickets(booking.id)).toEqual(tickets);
    });

    it('409 bookingNotConfirmed до подтверждения; 404 неизвестная бронь', async () => {
      const { session } = futureSession();
      const seats = firstFreeSeats(demoEngine.seatMap(session.id), 1);
      const pending = demoEngine.create({
        sessionId: session.id,
        customerName: 'Рано',
        seats,
      });

      try {
        demoEngine.tickets(pending.id);
        throw new Error('ожидали 409');
      } catch (err) {
        expect((err as ApiError).status).toBe(409);
        expect(JSON.parse((err as ApiError).body).code).toBe('bookingNotConfirmed');
      }

      try {
        demoEngine.tickets('нет-такой');
        throw new Error('ожидали 404');
      } catch (err) {
        expect((err as ApiError).status).toBe(404);
      }
    });

    it('сканер: честный QR — valid, подделка — badSignature, мусор — malformedPayload', async () => {
      const booking = await confirmedBooking(1);
      const [ticket] = demoEngine.tickets(booking.id);

      const honest = ticketQrOf(ticket);
      expect(demoEngine.verifyTicket(honest)).toMatchObject({
        valid: true,
        reason: null,
        bookingId: booking.id,
        seat: ticket.seat,
        movieTitle: booking.movieTitle,
        customerName: 'Билетник',
      });

      const forged = honest.slice(0, -32) + '0'.repeat(32);
      expect(demoEngine.verifyTicket(forged)).toMatchObject({
        valid: false,
        reason: 'badSignature',
      });

      expect(demoEngine.verifyTicket('мусор')).toMatchObject({
        valid: false,
        reason: 'malformedPayload',
      });
    });

    it('сканер: чужое место — seatMismatch (подпись честная)', async () => {
      const booking = await confirmedBooking(1);
      const seat = booking.seats.includes('8-10') ? '8-9' : '8-10';
      const canonical = ticketCanonical(booking.id, seat, booking.sessionAt);

      const verdict = demoEngine.verifyTicket(`${canonical}|${signTicket(canonical)}`);

      expect(verdict).toMatchObject({ valid: false, reason: 'seatMismatch', seat });
    });

    it('сага возврата: CANCELLED гасит билеты, откат в CONFIRMED оживляет', async () => {
      const booking = await confirmedBooking(1);
      expect(demoEngine.tickets(booking.id)).toHaveLength(1);

      // «банк» отклоняет возврат — бронь откатывается в CONFIRMED
      const failSpy = vi.spyOn(Math, 'random').mockReturnValue(0.95);
      demoEngine.cancel(booking.id);
      await vi.advanceTimersByTimeAsync(2000);
      failSpy.mockRestore();
      expect(booking.status).toBe('CONFIRMED');
      expect(demoEngine.tickets(booking.id)).toHaveLength(1); // оживили

      // успешный возврат закрывает бронь — билеты гаснут
      const okSpy = vi.spyOn(Math, 'random').mockReturnValue(0.1);
      demoEngine.cancel(booking.id);
      await vi.advanceTimersByTimeAsync(2000);
      okSpy.mockRestore();
      expect(booking.status).toBe('CANCELLED');
      try {
        demoEngine.tickets(booking.id);
        throw new Error('ожидали 409');
      } catch (err) {
        expect((err as ApiError).status).toBe(409);
        expect(JSON.parse((err as ApiError).body).code).toBe('bookingNotConfirmed');
      }
    });
  });
});

describe('demoEngine: лист ожидания (честная гонка)', () => {
  /** «Рекурсия-s1» — сид-«аншлаг»: зал выкуплен целиком */
  const FULL_SESSION = 'demo-recursion-s1';
  /** бронь «аншлага» — 15-й сид (demo-seed-b15), CONFIRMED на все 80 мест */
  const SELLOUT_BOOKING = 'demo-seed-b15';

  beforeEach(() => {
    vi.useFakeTimers();
    demoEngine.reset();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('сид-аншлаг: сеанс полного зала существует и free === 0', () => {
    const map = demoEngine.seatMap(FULL_SESSION);
    expect(map.occupied).toHaveLength(HALL_CAPACITY);
    expect(map.free).toBe(0);
  });

  it('join: 409 sessionNotFull на обычном сеансе, 201-подобный вход на полном', () => {
    const { session } = firstSession();
    try {
      demoEngine.joinWaitlist(session.id);
      throw new Error('ожидали 409');
    } catch (err) {
      expect((err as ApiError).status).toBe(409);
      expect(JSON.parse((err as ApiError).body).code).toBe('sessionNotFull');
    }

    const entry = demoEngine.joinWaitlist(FULL_SESSION);
    expect(entry.status).toBe('WAITING');
    expect(entry.position).toBe(1);
  });

  it('join дубль — 409 waitlistAlready; leave → 404 на повтор, запись скрыта из my', () => {
    demoEngine.joinWaitlist(FULL_SESSION);

    try {
      demoEngine.joinWaitlist(FULL_SESSION);
      throw new Error('ожидали 409');
    } catch (err) {
      expect(JSON.parse((err as ApiError).body).code).toBe('waitlistAlready');
    }

    demoEngine.leaveWaitlist(FULL_SESSION);
    expect(demoEngine.myWaitlist()).toEqual([]);
    try {
      demoEngine.leaveWaitlist(FULL_SESSION);
      throw new Error('ожидали 404');
    } catch (err) {
      expect((err as ApiError).status).toBe(404);
      expect(JSON.parse((err as ApiError).body).code).toBe('waitlistEntryNotFound');
    }
  });

  it('my: контекст фильма и позиция среди WAITING', () => {
    demoEngine.joinWaitlist(FULL_SESSION);
    const mine = demoEngine.myWaitlist();
    expect(mine).toHaveLength(1);
    expect(mine[0]).toMatchObject({
      sessionId: FULL_SESSION,
      movieTitle: 'Рекурсия',
      hall: 'IMAX',
      status: 'WAITING',
      position: 1,
    });
  });

  it('освобождение (возврат брони аншлага) → голова NOTIFIED, бронь гасит запись', async () => {
    demoEngine.joinWaitlist(FULL_SESSION);

    // «возврат» брони аншлага: сага отмены проходит (random зажат в «успех»)
    const okSpy = vi.spyOn(Math, 'random').mockReturnValue(0.1);
    demoEngine.cancel(SELLOUT_BOOKING);
    await vi.advanceTimersByTimeAsync(2000);
    okSpy.mockRestore();

    const mine = demoEngine.myWaitlist();
    expect(mine[0]?.status).toBe('NOTIFIED');
    expect(mine[0]?.position).toBeNull();

    // уведомлённый успел: бронь на освободившееся место гасит запись
    const map = demoEngine.seatMap(FULL_SESSION);
    const booking = demoEngine.create({
      sessionId: FULL_SESSION,
      seats: [freeSeat(map)],
    });
    expect(booking.status).toBe('PENDING_PAYMENT');
    expect(demoEngine.myWaitlist()).toEqual([]);
  });

  it('после освобождения сеанс уже не полон — повторный join честно отказан', () => {
    demoEngine.joinWaitlist(FULL_SESSION);
    const okSpy = vi.spyOn(Math, 'random').mockReturnValue(0.1);
    demoEngine.cancel(SELLOUT_BOOKING);
    return vi.advanceTimersByTimeAsync(2000).then(() => {
      okSpy.mockRestore();
      expect(demoEngine.myWaitlist()[0]?.status).toBe('NOTIFIED');

      // возврат открыл места — очередь больше не нужна, join отказан
      try {
        demoEngine.joinWaitlist(FULL_SESSION);
        throw new Error('ожидали 409');
      } catch (err) {
        expect(JSON.parse((err as ApiError).body).code).toBe('sessionNotFull');
      }
    });
  });
});

describe('demo: живая карта — другие зрители', () => {
  beforeEach(() => {
    demoEngine.reset();
  });

  it('занимает свободное место и уведомляет слушателей', () => {
    const { session } = firstSession();
    const before = demoEngine.seatMap(session.id);
    const notified = vi.fn();
    demoEngine.onChange(notified);

    // первая кость Math.random — ветвь (≥0.3 — занять), вторая — выбор места
    vi.spyOn(Math, 'random').mockReturnValueOnce(0.99).mockReturnValue(0.5);

    expect(demoEngine.simulateOtherViewer(session.id, [])).toBe('taken');
    const after = demoEngine.seatMap(session.id);
    expect(after.occupied.length).toBe(before.occupied.length + 1);
    expect(notified).toHaveBeenCalled();
  });

  it('уважает avoid: выбор локального пользователя неприкосновенен', () => {
    const { session } = firstSession();
    const map = demoEngine.seatMap(session.id);
    const allowed = freeSeat(map);
    const occupied = new Set(map.occupied);
    const avoid: string[] = [];
    for (let row = 1; row <= map.layout.rows; row++) {
      for (let num = 1; num <= map.layout.seatsPerRow; num++) {
        const code = `${row}-${num}`;
        if (!occupied.has(code) && code !== allowed) avoid.push(code);
      }
    }

    vi.spyOn(Math, 'random').mockReturnValueOnce(0.99).mockReturnValue(0.99);

    expect(demoEngine.simulateOtherViewer(session.id, avoid)).toBe('taken');
    const after = demoEngine.seatMap(session.id);
    expect(after.occupied).toContain(allowed);
    expect(after.occupied.length).toBe(map.occupied.length + 1);
  });

  it('release-ветвь освобождает только место симулянта — сиды на месте', () => {
    const { session } = firstSession();
    const before = demoEngine.seatMap(session.id).occupied;

    vi.spyOn(Math, 'random').mockReturnValueOnce(0.99).mockReturnValue(0.5);
    demoEngine.simulateOtherViewer(session.id, []);
    expect(demoEngine.seatMap(session.id).occupied.length).toBe(before.length + 1);

    vi.spyOn(Math, 'random').mockReturnValueOnce(0.1).mockReturnValue(0.5);
    expect(demoEngine.simulateOtherViewer(session.id, [])).toBe('released');
    expect(demoEngine.seatMap(session.id).occupied).toEqual(before);
  });

  it('аншлаг и пустая карта зрителей → none без мутаций', () => {
    const FULL = 'demo-recursion-s1';
    const before = demoEngine.seatMap(FULL).occupied;

    const dice = vi.spyOn(Math, 'random');
    dice.mockReturnValueOnce(0.99); // занять — но свободных мест нет
    expect(demoEngine.simulateOtherViewer(FULL, [])).toBe('none');
    dice.mockReturnValueOnce(0.1); // освобождать нечего
    expect(demoEngine.simulateOtherViewer(FULL, [])).toBe('none');
    expect(demoEngine.seatMap(FULL).occupied).toEqual(before);
  });

  it('reset вычищает места зрителей', () => {
    const { session } = firstSession();
    vi.spyOn(Math, 'random').mockReturnValueOnce(0.99).mockReturnValue(0.5);
    demoEngine.simulateOtherViewer(session.id, []);

    demoEngine.reset();
    vi.spyOn(Math, 'random').mockReturnValueOnce(0.1);
    expect(demoEngine.simulateOtherViewer(session.id, [])).toBe('none');
  });
});
