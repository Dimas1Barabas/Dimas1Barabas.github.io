import { ApiProperty } from '@nestjs/swagger';
import {
  IsBoolean,
  IsInt,
  IsOptional,
  IsString,
  Length,
  Matches,
  Max,
  Min,
} from 'class-validator';

/**
 * Тело PATCH /api/admin/flags/:key — полное новое состояние тумблера
 * (UpsertFlag в сервисе перезаписывает, а не мерджит: админка шлёт форму
 * с текущими значениями). Валидация повторяет алфавит ключа домена.
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

  /** ключ флага из каталога; создаёт флаг, если его ещё нет */
  @ApiProperty({ required: false, example: 'booking.qr_v2' })
  @IsOptional()
  @IsString()
  @Matches(/^[a-z0-9._-]{1,100}$/, {
    message: 'ключ: строчные буквы/цифры/._-, 1..100 символов',
  })
  key?: string;
}
