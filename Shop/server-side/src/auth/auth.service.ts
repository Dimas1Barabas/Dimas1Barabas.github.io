import { Injectable } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt'
import { UserService } from '../user/user.service'
import { PrismaService } from '../prisma.service'
import { AuthDto } from './dto/auth.dto'

@Injectable()
export class AuthService {
	constructor(
		private jwt: JwtService,
    private userService: UserService,
    private prisma: PrismaService
	) {}
	
	async login(dto: AuthDto) {}
	
	async register(dto: AuthDto) {}
	
	issueToken(userId: string) {
		const data = { id: userId }
		
		const accessToken = this.jwt.sign(data, {
			expiresIn: '1h'
		})
		
		const refreshToken = this.jwt.sign(data, {
			expiresIn: '1d'
		})
		
		return { accessToken, refreshToken }
	}
	
	private async validateUser(dto: AuthDto) {
		const user = await this.userService.getByEmail(dto.email)
		
		if (!user) throw new NotFoundException('Пользователь не найден')
	}
}
