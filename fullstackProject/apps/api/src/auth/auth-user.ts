import { UserRole } from '../users/user.entity';

/** req.user после JwtAuthGuard: пользователь из клеймов токена */
export interface AuthUser {
  id: string;
  email: string;
  name: string;
  role: UserRole;
}
