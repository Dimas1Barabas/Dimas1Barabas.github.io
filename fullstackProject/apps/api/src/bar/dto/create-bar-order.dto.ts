import { ApiProperty } from '@nestjs/swagger';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsInt,
  IsOptional,
  IsUUID,
  Min,
  Max,
  ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';

/** строка заказа: позиция каталога и количество порций */
export class BarOrderLineDto {
  @ApiProperty({ format: 'uuid' })
  @IsUUID()
  itemId!: string;

  @ApiProperty({ example: 2, minimum: 1, maximum: 10 })
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(10)
  qty!: number;
}

/** POST /bar/orders — оформить предзаказ (оплата на кассе при получении) */
export class CreateBarOrderDto {
  @ApiProperty({
    type: [BarOrderLineDto],
    minItems: 1,
    maxItems: 10,
    description: 'Позиции заказа; одна позиция — не более 10 порций',
  })
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(10)
  @ValidateNested({ each: true })
  @Type(() => BarOrderLineDto)
  items!: BarOrderLineDto[];

  @ApiProperty({
    format: 'uuid',
    required: false,
    description:
      'Сеанс, к которому приготовить заказ (подсказка Бармену на экране ' +
      'бара); без поля — забрать на стойке в любое время',
  })
  @IsOptional()
  @IsUUID()
  sessionId?: string;
}
