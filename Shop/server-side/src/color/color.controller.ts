import { Controller } from '@nestjs/common';
import { ColorService } from './color.service';

@Controller('color')
export class ColorController {
  constructor(private readonly colorService: ColorService) {}
}
