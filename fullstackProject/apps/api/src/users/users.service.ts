import {
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import * as bcrypt from 'bcryptjs';
import { Repository } from 'typeorm';
import { User } from './user.entity';

/** стоимость bcrypt: демо-компромисс скорость/надёжность */
const BCRYPT_ROUNDS = 10;

/** unique_violation в Postgres */
function isUniqueViolation(err: unknown): boolean {
  return (err as { code?: string }).code === '23505';
}

@Injectable()
export class UsersService {
  private readonly logger = new Logger(UsersService.name);

  constructor(
    @InjectRepository(User) private readonly users: Repository<User>,
  ) {}

  async register(input: {
    email: string;
    password: string;
    name: string;
  }): Promise<User> {
    const email = input.email.toLowerCase();
    const existing = await this.users.findOneBy({ email });
    if (existing) throw this.emailTaken();

    const user = this.users.create({
      email,
      name: input.name,
      passwordHash: await bcrypt.hash(input.password, BCRYPT_ROUNDS),
      // дефолт колонки в БД продублирован явно — не полагаемся на него в тестах
      role: 'user',
    });

    try {
      const saved = await this.users.save(user);
      this.logger.log(`Зарегистрирован пользователь ${email}`);
      return saved;
    } catch (err) {
      // гонка двух регистраций: страхует констрейнт uq_users_email
      if (isUniqueViolation(err)) throw this.emailTaken();
      throw err;
    }
  }

  /** для логина: по email или ничего */
  async findByEmail(email: string): Promise<User | null> {
    return this.users.findOneBy({ email: email.toLowerCase() });
  }

  async findById(id: string): Promise<User> {
    const user = await this.users.findOneBy({ id });
    if (!user) throw new NotFoundException('Пользователь не найден');
    return user;
  }

  private emailTaken(): ConflictException {
    return new ConflictException({
      statusCode: 409,
      error: 'Conflict',
      message: 'Этот email уже зарегистрирован',
      code: 'emailTaken',
    });
  }
}
