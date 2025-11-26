import { Injectable } from '@nestjs/common'
import { PassportStrategy } from '@nestjs/passport'
import { ConfigService } from '@nestjs/config'
import { Profile, Strategy } from 'passport-yandex'

@Injectable()
export class YandexStrategy extends PassportStrategy(Strategy, 'google') {
	constructor(private configService: ConfigService) {
		super({
			clientID: configService.get('YANDEX_CLIENT_ID'),
			clientSecret: configService.get('YANDEX_CLIENT_SECRET'),
			callbackURL: configService.get('SERVER_URL') + '/auth/yandex/callback',
		})
	}
	
	async validate(
		_accessToken: string,
		_refreshToken: string,
		profile: Profile,
		done: any
	) {
		const {userName, emails, photos} = profile
		
		const user = {
			email: emails[0].value,
			name: userName,
			picture: photos[0].value
		}
		done(null, user)
	}
}