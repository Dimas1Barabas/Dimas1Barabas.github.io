import { NestFactory } from '@nestjs/core'
import { AppModule } from './app.module'

import * as cookieParser from 'cookie-parser'
import * as process from 'node:process'

async function bootstrap() {
  const app = await NestFactory.create(AppModule)
	
	app.use(cookieParser())
	app.enableCors({
		origin: [process.env.CLIENT_URL],
		credentials: true,
		exposeHeaders: 'set-cookie'
	})
	
  await app.listen( 5000)
}
bootstrap();
