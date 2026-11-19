import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
} from 'typeorm';

/**
 * Одноразовый backup-код 2FA: на случай утери телефона. Наружу
 * показывается один раз при включении 2FA, в БД — только sha256-хэш
 * нормализованного кода. Расход атомарный: UPDATE … SET used_at
 * WHERE id AND used_at IS NULL — повторно тот же код не сработает.
 */
@Entity('backup_codes')
@Index('ix_backup_codes_user_id', ['userId'])
export class BackupCode {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ name: 'user_id' })
  userId: string;

  @Column({ name: 'code_hash', length: 64 })
  codeHash: string;

  @CreateDateColumn({ name: 'created_at' })
  createdAt: Date;

  @Column({ name: 'used_at', type: 'timestamp', nullable: true })
  usedAt: Date | null;
}
