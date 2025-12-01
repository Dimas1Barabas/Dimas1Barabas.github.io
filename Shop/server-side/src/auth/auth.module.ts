import { Module } from '@nestjs/common'
import { AuthService } from './auth.service'
import { AuthController } from './auth.controller'
import { ConfigModule, ConfigService } from '@nestjs/config'
import { JwtModule } from '@nestjs/jwt'
import { UserModule } from '../user/user.module'
import { getJwtConfig } from '../config/jwt.config'
import { PrismaService } from '../prisma.service'
import { UserService } from '../user/user.service'
import { GoogleStrategy } from './strategies/google.strategy'
import { JwtStrategy } from './strategies/jwt.strategy'
import { YandexStrategy } from './strategies/yandex.strategy'

@Module({
	imports: [
		UserModule,
		ConfigModule,
		JwtModule.registerAsync({
			imports: [ConfigModule],
			inject: [ConfigService],
			useFactory: getJwtConfig
		})
	],
  controllers: [AuthController],
  providers: [
		AuthService,
	  PrismaService,
	  UserService,
	  JwtStrategy,
	  GoogleStrategy,
    YandexStrategy
  ]
})
export class AuthModule {}
