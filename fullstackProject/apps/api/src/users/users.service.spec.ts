import { ConflictException } from '@nestjs/common';
import { getRepositoryToken } from '@nestjs/typeorm';
import { randomUUID } from 'node:crypto';
import * as bcrypt from 'bcryptjs';
import { Repository } from 'typeorm';
import { User } from './user.entity';
import { UsersService } from './users.service';

/** Map-фейк репозитория: уникальность email эмулируем руками */
class FakeUserRepo {
  rows: User[] = [];

  create(x: Partial<User>): User {
    return x as User;
  }

  async save(user: User): Promise<User> {
    if (!user.id) user.id = randomUUID();
    if (!user.createdAt) user.createdAt = new Date();
    if (!this.rows.includes(user)) this.rows.push(user);
    return user;
  }

  async findOneBy(where: { email?: string; id?: string }): Promise<User | null> {
    return (
      this.rows.find(
        (r) =>
          (!where.email || r.email === where.email) &&
          (!where.id || r.id === where.id),
      ) ?? null
    );
  }
}

describe('UsersService', () => {
  let service: UsersService;
  let repo: FakeUserRepo;

  beforeEach(() => {
    repo = new FakeUserRepo();
    service = new UsersService(repo as unknown as Repository<User>);
  });

  describe('register', () => {
    it("хэширует пароль bcrypt'ом и не хранит открытый", async () => {
      const user = await service.register({
        email: 'Alice@Example.com',
        password: 'secret123',
        name: 'Алиса',
      });

      expect(user.passwordHash).toBeDefined();
      expect(user.passwordHash).not.toBe('secret123');
      expect(await bcrypt.compare('secret123', user.passwordHash)).toBe(true);
    });

    it('приводит email к нижнему регистру', async () => {
      const user = await service.register({
        email: 'Alice@Example.com',
        password: 'secret123',
        name: 'Алиса',
      });

      expect(user.email).toBe('alice@example.com');
    });

    it('роль по умолчанию — user', async () => {
      const user = await service.register({
        email: 'bob@example.com',
        password: 'secret123',
        name: 'Боб',
      });

      expect(user.role).toBe('user');
    });

    it('занятый email → 409 emailTaken', async () => {
      await service.register({
        email: 'dup@example.com',
        password: 'secret123',
        name: 'Первый',
      });

      let caught: unknown;
      try {
        await service.register({
          email: 'DUP@example.com',
          password: 'secret456',
          name: 'Второй',
        });
      } catch (err) {
        caught = err;
      }

      expect(caught).toBeInstanceOf(ConflictException);
      expect((caught as ConflictException).getStatus()).toBe(409);
      expect((caught as ConflictException).getResponse()).toMatchObject({
        code: 'emailTaken',
      });
    });
  });

  describe('findByEmail', () => {
    it('находит по email без регистра', async () => {
      await service.register({
        email: 'carol@example.com',
        password: 'secret123',
        name: 'Кэрол',
      });

      const found = await service.findByEmail('CAROL@example.com');
      expect(found?.email).toBe('carol@example.com');
    });

    it('несуществующий → null', async () => {
      expect(await service.findByEmail('no@body.dev')).toBeNull();
    });
  });
});
