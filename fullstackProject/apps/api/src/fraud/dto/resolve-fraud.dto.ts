import { ApiProperty } from '@nestjs/swagger';
import { IsIn } from 'class-validator';

/** Решение человека по брони из очереди ревью антифрода */
export class ResolveFraudDto {
  @ApiProperty({
    enum: ['approve', 'reject'],
    description:
      'approve — запустить оплату брони (системный вызов, холд снимается ' +
      'самим действием); reject — отменить бронь и вернуть места в продажу',
  })
  @IsIn(['approve', 'reject'], {
    message: 'action: approve или reject',
  })
  action!: 'approve' | 'reject';
}
