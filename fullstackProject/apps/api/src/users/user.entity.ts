import {
  Column,
  CreateDateColumn,
  Entity,
  PrimaryGeneratedColumn,
  Unique,
} from 'typeorm';

export type UserRole = 'user' | 'admin';

export interface UserDto {
  id: string;
  email: string;
  name: string;
  role: UserRole;
  createdAt: string;
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

  @CreateDateColumn({ name: 'created_at' })
  createdAt: Date;
}
