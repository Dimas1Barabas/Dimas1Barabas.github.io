import { Module } from '@nestjs/common';
import { ColorService } from './color.service';
import { ColorController } from './color.controller';

@Module({
  controllers: [ColorController],
  providers: [ColorService],
})
export class ColorModule {}
