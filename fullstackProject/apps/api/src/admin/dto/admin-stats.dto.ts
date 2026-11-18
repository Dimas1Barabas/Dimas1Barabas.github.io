import { ApiProperty } from '@nestjs/swagger';

/**
 * Ответ GET /api/admin/stats — агрегаты для админ-дашборда.
 * Классы (не интерфейсы) — чтобы попадать в OpenAPI-схему ответов.
 */

/** сводка: главные числа кинотеатра одной строкой */
export class AdminTotalsDto {
  @ApiProperty({ example: 42, description: 'всего броней за всё время' })
  bookingsTotal!: number;

  @ApiProperty({ example: 12, description: 'подтверждённых броней' })
  confirmed!: number;

  @ApiProperty({ example: 24000, description: 'выручка по CONFIRMED-броням, ₽' })
  revenueRub!: number;

  @ApiProperty({ example: 2000, description: 'средний чек, ₽ (0 без продаж)' })
  avgTicketRub!: number;

  @ApiProperty({ example: 27, description: 'продано мест в CONFIRMED-бронях' })
  seatsSold!: number;

  @ApiProperty({
    example: 34,
    description: 'средняя заполняемость предстоящих сеансов, % (0, если сеансов нет)',
  })
  upcomingOccupancyPct!: number;

  @ApiProperty({ example: 6, description: 'фильмов в афише' })
  moviesCount!: number;

  @ApiProperty({ example: 15, description: 'отзывов всего' })
  reviewsCount!: number;

  @ApiProperty({ example: 4.2, description: 'средняя оценка по всем отзывам (0 без отзывов)' })
  avgRating!: number;
}

/** счётчики по статусам: все 7 ключей всегда на месте, нули включительно */
export class AdminStatusCountsDto {
  @ApiProperty({ example: 2, description: 'ждут оплаты' })
  PENDING_PAYMENT!: number;

  @ApiProperty({ example: 1, description: 'платёж в полёте' })
  PENDING!: number;

  @ApiProperty({ example: 12, description: 'подтверждено воркером' })
  CONFIRMED!: number;

  @ApiProperty({ example: 1, description: 'платёж не прошёл' })
  FAILED!: number;

  @ApiProperty({ example: 3, description: 'не оплатили вовремя' })
  EXPIRED!: number;

  @ApiProperty({ example: 0, description: 'сага возврата в полёте' })
  CANCELLING!: number;

  @ApiProperty({ example: 2, description: 'отменены (включая возвраты)' })
  CANCELLED!: number;
}

/** строка топа фильмов — по числу подтверждённых броней */
export class AdminTopMovieDto {
  @ApiProperty({ format: 'uuid' })
  movieId!: string;

  @ApiProperty({ example: 'Дюна: Часть три' })
  title!: string;

  @ApiProperty({ example: 5, description: 'подтверждённых броней' })
  bookings!: number;

  @ApiProperty({ example: 9, description: 'продано мест' })
  seats!: number;

  @ApiProperty({ example: 18000, description: 'выручка, ₽' })
  revenueRub!: number;
}

/** заполняемость одного предстоящего сеанса */
export class AdminSessionOccupancyDto {
  @ApiProperty({ format: 'uuid' })
  sessionId!: string;

  @ApiProperty({ example: 'Дюна: Часть три' })
  movieTitle!: string;

  @ApiProperty({ example: 'IMAX' })
  hall!: string;

  @ApiProperty({ format: 'date-time' })
  startsAt!: string;

  @ApiProperty({ example: 27, description: 'занятых мест (включая неоплаченные резервы)' })
  occupied!: number;

  @ApiProperty({ example: 80, description: 'вместимость зала' })
  capacity!: number;

  @ApiProperty({ example: 34, description: 'заполненность, %' })
  occupancyPct!: number;
}

/** столбец графика выручки за один день */
export class AdminDayRevenueDto {
  @ApiProperty({ example: '2026-09-16', description: 'локальный день YYYY-MM-DD' })
  day!: string;

  @ApiProperty({ example: 3, description: 'подтверждённых броней в этот день' })
  bookings!: number;

  @ApiProperty({ example: 6000, description: 'выручка дня, ₽' })
  revenueRub!: number;
}

/** реферальный срез: как программа приглашений превращается в оплаты */
export class AdminReferralsDto {
  @ApiProperty({ example: 14, description: 'юзеров, пришедших по чужому коду' })
  invited!: number;

  @ApiProperty({
    example: 6,
    description: 'из них оплатили первую бронь — бонус начислен',
  })
  paid!: number;

  @ApiProperty({
    example: 43,
    description: 'конверсия приглашений в первую оплату, % (0 без приглашённых)',
  })
  paidPct!: number;

  @ApiProperty({
    example: 2400,
    description: 'реферальных бонусов начислено (обе стороны, до гашений)',
  })
  paidBonuses!: number;
}

/** гифт-срез: как подарочные карты продаются и превращаются в оплаты */
export class AdminGiftsDto {
  @ApiProperty({ example: 12, description: 'продано сертификатов' })
  sold!: number;

  @ApiProperty({ example: 24_000, description: 'продано на сумму номиналов, ₽' })
  soldRub!: number;

  @ApiProperty({
    example: 9,
    description: 'активировано получателями (включая потраченные до нуля)',
  })
  activated!: number;

  @ApiProperty({
    example: 8_500,
    description: 'потрачено картами в оплатах броней (живые траты, без возвратов), ₽',
  })
  spentRub!: number;

  @ApiProperty({ example: 4, description: 'живые карты: активны и не просрочены' })
  activeCount!: number;

  @ApiProperty({ example: 6_200, description: 'живый остаток на картах, ₽' })
  activeRemainingRub!: number;
}

export class AdminStatsDto {
  @ApiProperty({ type: AdminTotalsDto })
  totals!: AdminTotalsDto;

  @ApiProperty({ type: AdminStatusCountsDto })
  byStatus!: AdminStatusCountsDto;

  @ApiProperty({ type: [AdminTopMovieDto], description: 'топ-5 по подтверждённым броням' })
  topMovies!: AdminTopMovieDto[];

  @ApiProperty({
    type: [AdminSessionOccupancyDto],
    description: '8 ближайших сеансов по времени',
  })
  upcomingSessions!: AdminSessionOccupancyDto[];

  @ApiProperty({
    type: [AdminDayRevenueDto],
    description: 'выручка по дням: 14 дней включая сегодня (пустые — нули)',
  })
  revenueByDay!: AdminDayRevenueDto[];

  @ApiProperty({ type: AdminReferralsDto, description: 'реферальный срез (этап 31)' })
  referrals!: AdminReferralsDto;

  @ApiProperty({ type: AdminGiftsDto, description: 'гифт-срез (этап 33)' })
  gifts!: AdminGiftsDto;
}

/** конверт как у каталога: источник ответа виден фронту бейджем «из кэша» */
export class AdminStatsResultDto {
  @ApiProperty({ enum: ['cache', 'db'], description: 'Redis-кэш или свежая выгрузка' })
  source!: 'cache' | 'db';

  @ApiProperty({ type: AdminStatsDto })
  data!: AdminStatsDto;
}
