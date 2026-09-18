import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
  Unique,
} from 'typeorm';

/**
 * Одноразовая ссылка сброса пароля: в БД — sha256-хэш токена.
 * TTL 30 минут, использованные помечаются used_at (не удаляются).
 */
@Entity('password_resets')
@Unique('uq_password_resets_token_hash', ['tokenHash'])
export class PasswordReset {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Index()
  @Column({ name: 'user_id' })
  userId: string;

  @Column({ name: 'token_hash', length: 64 })
  tokenHash: string;

  @CreateDateColumn({ name: 'created_at' })
  createdAt: Date;

  @Column({ name: 'expires_at', type: 'timestamp' })
  expiresAt: Date;

  @Column({ name: 'used_at', type: 'timestamp', nullable: true })
  usedAt: Date | null;
}
