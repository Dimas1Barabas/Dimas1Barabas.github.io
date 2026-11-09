import { ApiProperty } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsInt,
  IsOptional,
  IsString,
  Length,
  Matches,
  Max,
  Min,
  ValidateNested,
} from 'class-validator';

/** Вариант A/B-эксперимента: имя в алфавите домена и доля трафика. */
export class FlagVariantDto {
  @ApiProperty({ example: 'a', description: '[a-z0-9_-], 1..30, без повторов' })
  @IsString()
  @Matches(/^[a-z0-9_-]{1,30}$/, {
    message: 'имя варианта: строчные буквы/цифры/_-, 1..30 символов',
  })
  name!: string;

  @ApiProperty({ example: 50, minimum: 0, maximum: 100 })
  @IsInt()
  @Min(0)
  @Max(100)
  percentage!: number;
}

/**
 * Тело PATCH /api/admin/flags/:key — полное новое состояние тумблера
 * (UpsertFlag в сервисе перезаписывает, а не мерджит: админка шлёт форму
 * с текущими значениями). Валидация повторяет алфавит ключа домена.
 * Непустой variants превращает флаг в A/B-эксперимент (сумму долей ≤ 100
 * и уникальность имён досчитает сервис — InvalidArgument уйдёт 400).
 */
export class FlagUpsertDto {
  @ApiProperty({ example: 'Новый пошаговый чекаут брони' })
  @IsString()
  @Length(0, 200)
  description!: string;

  @ApiProperty({ example: true, description: 'мастер-тумблер (пауза раскатки)' })
  @IsBoolean()
  enabled!: boolean;

  @ApiProperty({ example: 25, minimum: 0, maximum: 100 })
  @IsInt()
  @Min(0)
  @Max(100)
  percentage!: number;

  @ApiProperty({ example: false, description: 'kill-switch: мгновенный оф всем' })
  @IsBoolean()
  killed!: boolean;

  /** варианты A/B-эксперимента; отсутствие/[] — обычный флаг-тумблер */
  @ApiProperty({
    required: false,
    type: [FlagVariantDto],
    example: [
      { name: 'a', percentage: 10 },
      { name: 'b', percentage: 30 },
    ],
    description: 'кумулятивные доли трафика, сумма ≤ 100; остаток — база',
  })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(10)
  @ValidateNested({ each: true })
  @Type(() => FlagVariantDto)
  variants?: FlagVariantDto[];

  /** ключ флага из каталога; создаёт флаг, если его ещё нет */
  @ApiProperty({ required: false, example: 'booking.qr_v2' })
  @IsOptional()
  @IsString()
  @Matches(/^[a-z0-9._-]{1,100}$/, {
    message: 'ключ: строчные буквы/цифры/._-, 1..100 символов',
  })
  key?: string;
}
