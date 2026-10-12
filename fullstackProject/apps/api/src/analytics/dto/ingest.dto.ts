import { ApiProperty } from '@nestjs/swagger';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  MaxLength,
  Min,
  Max,
  ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';

import { ANALYTICS_EVENT_TYPES } from '../analytics-events';

/** одно событие поведения: тип + разреженные поля по смыслу */
export class AnalyticsEventDto {
  @ApiProperty({ enum: ANALYTICS_EVENT_TYPES })
  @IsIn(ANALYTICS_EVENT_TYPES as unknown as string[])
  type!: string;

  @ApiProperty({ example: '2026-10-12T10:00:00.000Z' })
  @IsString()
  ts!: string;

  @ApiProperty({ required: false, example: 'home' })
  @IsOptional()
  @IsString()
  @Matches(/^[\w/:-]{1,60}$/, { message: 'route — имя маршрута, например home или pay' })
  route?: string;

  @ApiProperty({ required: false, example: 4200, minimum: 0 })
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(24 * 60 * 60 * 1000)
  ms?: number;

  @ApiProperty({
    required: false,
    enum: ['session', 'seats', 'created'],
    description: 'modal_dwell: глубина пройденного пути',
  })
  @IsOptional()
  @IsIn(['session', 'seats', 'created'])
  deepest?: 'session' | 'seats' | 'created';

  @ApiProperty({ required: false, format: 'uuid' })
  @IsOptional()
  @IsUUID()
  movieId?: string;

  @ApiProperty({ required: false, format: 'uuid' })
  @IsOptional()
  @IsUUID()
  sessionId?: string;

  @ApiProperty({ required: false, example: '5-7', description: 'код «ряд-место»' })
  @IsOptional()
  @Matches(/^\d+-\d+$/, { message: 'Код места — «ряд-место», например 5-7' })
  seat?: string;

  @ApiProperty({ required: false, example: 'Красный' })
  @IsOptional()
  @IsString()
  @MaxLength(30)
  hall?: string;

  @ApiProperty({ required: false, minimum: 1, maximum: 8 })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(8)
  count?: number;

  @ApiProperty({ required: false, format: 'uuid' })
  @IsOptional()
  @IsUUID()
  bookingId?: string;
}

/**
 * Конверт батча: aid на уровне батча — и ключ корзины Привратника
 * (лимит на посетителя, не на IP прокси), и штамп во все события.
 */
export class IngestAnalyticsDto {
  @ApiProperty({ format: 'uuid', description: 'anon id посетителя с веба' })
  @IsUUID()
  aid!: string;

  @ApiProperty({
    required: false,
    format: 'uuid',
    description: 'если посетитель под аккаунтом — id пользователя',
  })
  @IsOptional()
  @IsUUID()
  userId?: string;

  @ApiProperty({
    type: [AnalyticsEventDto],
    minItems: 1,
    maxItems: 50,
    description: 'накопленные с прошлого батча события',
  })
  @IsArray()
  @ArrayMinSize(1, { message: 'Батч пуст — незачем его присылать' })
  @ArrayMaxSize(50, { message: 'Максимум 50 событий за батч' })
  @ValidateNested({ each: true })
  @Type(() => AnalyticsEventDto)
  events!: AnalyticsEventDto[];
}
