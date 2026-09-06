import { SetMetadata } from '@nestjs/common';
import { UserRole } from '../users/user.entity';

export const ROLES_KEY = 'roles';

/** минимальная роль для эндпоинта; проверяет RolesGuard после JwtAuthGuard */
export const Roles = (...roles: UserRole[]) => SetMetadata(ROLES_KEY, roles);
