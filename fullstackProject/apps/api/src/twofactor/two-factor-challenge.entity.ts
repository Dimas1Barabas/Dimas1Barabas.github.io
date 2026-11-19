import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
  Unique,
} from 'typeorm';

/**
 * Билет второго шага входа: пароль верен, но 2FA включена — вместо
 * пары выдаётся билет (5 минут, максимум 5 попыток). Хэш билета в БД,
 * сам билет — строка base64url в теле ответа логина. Каждое неверное
 * значение кода списывает попытку; исчерпавший билет гасится — вход
 * начинается заново с паролем.
 */
@Entity('two_factor_challenges')
@Unique('uq_two_factor_challenges_ticket_hash', ['ticketHash'])
@Index('ix_two_factor_challenges_user_id', ['userId'])
export class TwoFactorChallenge {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ name: 'user_id' })
  userId: string;

  @Column({ name: 'ticket_hash', length: 64 })
  ticketHash: string;

  @Column({ default: 0 })
  attempts: number;

  @Column({ name: 'expires_at', type: 'timestamp' })
  expiresAt: Date;

  @Column({ name: 'used_at', type: 'timestamp', nullable: true })
  usedAt: Date | null;

  @CreateDateColumn({ name: 'created_at' })
  createdAt: Date;
}
