import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
  OnModuleInit,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
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
export class UsersService implements OnModuleInit {
  private readonly logger = new Logger(UsersService.name);

  constructor(
    @InjectRepository(User) private readonly users: Repository<User>,
    private readonly config: ConfigService,
  ) {}

  /**
   * При первом старте сеем администратора — как фильмы в MoviesService.
   * Данные по умолчанию демонстрационные; в проде задаются через env.
   */
  async onModuleInit(): Promise<void> {
    const email = this.config
      .get<string>('ADMIN_EMAIL', 'admin@cine.local')
      .toLowerCase();
    if (await this.users.findOneBy({ email })) return;

    const password = this.config.get<string>('ADMIN_PASSWORD', 'admin-secret-1');
    await this.users.save(
      this.users.create({
        email,
        name: 'Админ',
        role: 'admin',
        passwordHash: await bcrypt.hash(password, BCRYPT_ROUNDS),
      }),
    );
    this.logger.log(`Посеял администратора ${email}`);
  }

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

  /**
   * Профиль: имя и/или email. Занятый email ловим предпроверкой (читаемое
   * сообщение), гонку с параллельной регистрацией добивает констрейнт
   * uq_users_email (23505 → 409 emailTaken) — как в register.
   */
  async updateProfile(
    userId: string,
    dto: { email?: string; name?: string },
  ): Promise<User> {
    if (!dto.email && !dto.name) {
      throw new BadRequestException('Нечего обновлять: укажите имя или email');
    }
    const user = await this.findById(userId);
    if (dto.email) {
      const email = dto.email.toLowerCase();
      if (email !== user.email && (await this.users.findOneBy({ email }))) {
        throw this.emailTaken();
      }
      user.email = email;
    }
    if (dto.name) user.name = dto.name;
    try {
      return await this.users.save(user);
    } catch (err) {
      if (isUniqueViolation(err)) throw this.emailTaken();
      throw err;
    }
  }

  /** смена пароля: старый обязателен; хэш нового — bcrypt, как при регистрации */
  async changePassword(
    userId: string,
    currentPassword: string,
    newPassword: string,
  ): Promise<User> {
    const user = await this.findById(userId);
    // 403, а не 401: юзер аутентифицирован, ошибся именно в старом пароле
    if (!(await bcrypt.compare(currentPassword, user.passwordHash))) {
      throw new ForbiddenException('Неверный текущий пароль');
    }
    return this.setPassword(user, newPassword);
  }

  /** установка пароля без проверки старого — для восстановления по токену */
  async setPassword(user: User, newPassword: string): Promise<User> {
    user.passwordHash = await bcrypt.hash(newPassword, BCRYPT_ROUNDS);
    return this.users.save(user);
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
