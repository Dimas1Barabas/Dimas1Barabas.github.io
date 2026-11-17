import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { BAR_CATALOG, categoryRank } from './bar-catalog';
import { BarItem, BarItemDto, toBarItemDto } from './bar-item.entity';

/**
 * Кинобар: каталог с остатками и заказы. Посев каталога — как у фильмов,
 * в пустую таблицу при старте. Списание остатка — атомарный условный
 * UPDATE в транзакции заказа (create), отмена возвращает порции.
 */
@Injectable()
export class BarService implements OnModuleInit {
  private readonly logger = new Logger(BarService.name);

  constructor(
    @InjectRepository(BarItem) private readonly items: Repository<BarItem>,
  ) {}

  /** посев каталога в пустую таблицу (миграции создают схему раньше) */
  async onModuleInit(): Promise<void> {
    const count = await this.items.count();
    if (count > 0) return;
    await this.items.save(
      BAR_CATALOG.map((s) => this.items.create(s)),
    );
    this.logger.log(
      `Посеял каталог кинобара: ${BAR_CATALOG.length} позиций ` +
        `(${BAR_CATALOG.reduce((s, i) => s + i.stock, 0)} порций на складе)`,
    );
  }

  /** витрина каталога: только active, категории по порядку витрины */
  async menu(): Promise<BarItemDto[]> {
    const rows = await this.items.find({ where: { active: true } });
    return rows
      .sort(
        (a, b) =>
          categoryRank(a.category) - categoryRank(b.category) ||
          a.name.localeCompare(b.name, 'ru'),
      )
      .map(toBarItemDto);
  }
}
