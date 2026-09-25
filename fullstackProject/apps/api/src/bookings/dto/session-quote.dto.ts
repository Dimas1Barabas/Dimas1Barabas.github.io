import { ApiProperty } from '@nestjs/swagger';

/** Фактор раскладки цены: что сработало у Тарификатора */
export class PriceFactorDto {
  /** машинное имя: evening, weekend, demand_full … */
  @ApiProperty({ example: 'evening' })
  code!: string;

  @ApiProperty({ example: 'вечерний прайм +20%' })
  label!: string;

  /** вклад фактора, %: −20 … +25 */
  @ApiProperty({ example: 20 })
  percent!: number;
}

/** Ответ GET /api/sessions/:sessionId/price — витрина цены места */
export class SessionQuoteDto {
  @ApiProperty({ format: 'uuid' })
  sessionId!: string;

  @ApiProperty({ format: 'date-time' })
  sessionAt!: string;

  /** базовая цена фильма из афиши, ₽/место */
  @ApiProperty({ example: 400 })
  basePriceRub!: number;

  /** цена после факторов, ₽/место (кратно 10) */
  @ApiProperty({ example: 480 })
  priceRub!: number;

  @ApiProperty({ type: [PriceFactorDto] })
  factors!: PriceFactorDto[];

  /**
   * true — цену посчитал Тарификатор; false — сервис недоступен,
   * показываем базовую (это деградация, а не ошибка запроса)
   */
  @ApiProperty({ example: true })
  dynamic!: boolean;
}
