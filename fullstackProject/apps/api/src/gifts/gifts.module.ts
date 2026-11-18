import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { GiftCertificate } from './gift-certificate.entity';
import { GiftSpend } from './gift-spend.entity';
import { GiftsController } from './gifts.controller';
import { GiftsService } from './gifts.service';

/**
 * Гифт-сертификаты: витрина покупки/активации/остатков. Списание и
 * возврат — транзакционные методы GiftsService, их вызывает
 * BookingsService внутри pay и вердиктов (модуль экспортирует сервис).
 */
@Module({
  imports: [TypeOrmModule.forFeature([GiftCertificate, GiftSpend])],
  controllers: [GiftsController],
  providers: [GiftsService],
  exports: [GiftsService],
})
export class GiftsModule {}
