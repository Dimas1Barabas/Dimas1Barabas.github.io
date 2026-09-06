import {
  CanActivate,
  ExecutionContext,
  Injectable,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { AuthUser } from './auth-user';
import { ROLES_KEY } from './roles.decorator';
import { UserRole } from '../users/user.entity';

/**
 * Проверяет роль req.user против @Roles(...): не хватает роли → 403.
 * Без @Roles пропускает — «просто авторизован» достаточно.
 * Срабатывает после JwtAuthGuard (порядок APP_GUARD в AppModule).
 */
@Injectable()
export class RolesGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const required = this.reflector.getAllAndOverride<UserRole[] | undefined>(
      ROLES_KEY,
      [context.getHandler(), context.getClass()],
    );
    if (!required || required.length === 0) return true;

    const { user } = context.switchToHttp().getRequest<{ user?: AuthUser }>();
    return !!user && required.includes(user.role);
  }
}
