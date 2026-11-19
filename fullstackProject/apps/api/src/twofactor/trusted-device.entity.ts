import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
  Unique,
} from 'typeorm';

/**
 * Доверенное устройство: создается входом с галочкой «доверять»,
 * токен живёт в httpOnly-cookie cine.device, в БД — только хэш.
 * Живое устройство (не отозвано, не истекло) пропускает второй шаг
 * входа. last_used_at продлевается каждым входом — витрина профиля
 * показывает «когда входили».
 */
@Entity('trusted_devices')
@Unique('uq_trusted_devices_token_hash', ['tokenHash'])
@Index('ix_trusted_devices_user_id', ['userId'])
export class TrustedDevice {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ name: 'user_id' })
  userId: string;

  @Column({ name: 'token_hash', length: 64 })
  tokenHash: string;

  /** имя из формы входа («Браузер на работе») — узнаётся в профиле */
  @Column({ length: 60 })
  name: string;

  @CreateDateColumn({ name: 'created_at' })
  createdAt: Date;

  @Column({ name: 'last_used_at', type: 'timestamp' })
  lastUsedAt: Date;

  @Column({ name: 'expires_at', type: 'timestamp' })
  expiresAt: Date;

  @Column({ name: 'revoked_at', type: 'timestamp', nullable: true })
  revokedAt: Date | null;
}
