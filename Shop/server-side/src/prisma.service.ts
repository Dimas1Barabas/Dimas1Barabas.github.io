import { PrismaClient } from '@prisma/client/extension'
import { Injectable, onModuleInit } from '@nestjs/common'


@Injectable()
export class PrismaService extends PrismaClient implements OnModuleInit {
	async onModuleInit() {
		await this.$connect();
	}
}