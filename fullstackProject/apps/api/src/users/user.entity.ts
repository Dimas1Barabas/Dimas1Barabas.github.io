import { ApiProperty } from '@nestjs/swagger';
import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
  Unique,
} from 'typeorm';

export type UserRole = 'user' | 'admin';

/** класс (не interface) — чтобы попадать в OpenAPI-схему ответов */
export class UserDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty({ example: 'alice@example.com' })
  email!: string;

  @ApiProperty({ example: 'Алиса' })
  name!: string;

  /** union-тип в reflect-metadata неразличим — перечисляем явно */
  @ApiProperty({ enum: ['user', 'admin'] })
  role!: UserRole;

  @ApiProperty({ format: 'date-time' })
  createdAt!: string;
}

/** наружу отдаём только DTO — passwordHash остаётся внутри сервиса */
export function toUserDto(user: User): UserDto {
  return {
    id: user.id,
    email: user.email,
    name: user.name,
    role: user.role,
    createdAt: user.createdAt.toISOString(),
  };
}

@Entity('users')
@Unique('uq_users_email', ['email'])
@Unique('uq_users_referral_code', ['referralCode'])
export class User {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  /** приводится к нижнему регистру при регистрации */
  @Column({ length: 255 })
  email: string;

  /** bcrypt-хэш пароля */
  @Column({ name: 'password_hash', length: 100 })
  passwordHash: string;

  /** имя для брони (как customerName у броней) */
  @Column({ length: 60 })
  name: string;

  @Column({ length: 10, default: 'user' })
  role: UserRole;

  /**
   * Код приглашения: генерируется при регистрации (посевной админ и
   * юзеры до рефералки получают его лениво при первом заходе на
   * «Пригласить»). null допускается только до ленивой догенерации.
   */
  // type обязателен: union string|null в reflect-metadata неотличим, без
  // явного типа TypeORM видит «Object» и валит DataSource.initialize
  // (DataTypeNotSupportedError — все live-стенды, run 9158dd74)
  @Column({ name: 'referral_code', type: 'varchar', length: 12, nullable: true })
  referralCode: string | null;

  /** кем приглашён — фиксируется один раз при регистрации по коду */
  @Index('ix_users_referred_by')
  @Column({ name: 'referred_by', type: 'uuid', nullable: true })
  referredBy: string | null;

  /**
   * Когда первая оплаченная бронь приглашённого награждена бонусами —
   * атомарный захват «первенца» в BookingsService.handleProcessed.
   */
  @Column({ name: 'referral_rewarded_at', type: 'timestamp', nullable: true })
  referralRewardedAt: Date | null;

  @CreateDateColumn({ name: 'created_at' })
  createdAt: Date;
}
