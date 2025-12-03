import { Module } from '@nestjs/common';
import { StoreService } from './store.service';
import { StoreController } from './store.controller';
import { PrismaService } from '../prisma.service'

@Module({
  controllers: [StoreController],
  providers: [StoreService, PrismaService],
})
export class StoreModule {}
