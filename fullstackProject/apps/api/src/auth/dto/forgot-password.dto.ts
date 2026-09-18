import { ApiProperty } from '@nestjs/swagger';
import { IsEmail } from 'class-validator';

export class ForgotPasswordDto {
  @ApiProperty({
    example: 'alice@example.com',
    description: 'ответ одинаков и для несуществующего email — не оракул',
  })
  @IsEmail()
  email!: string;
}
