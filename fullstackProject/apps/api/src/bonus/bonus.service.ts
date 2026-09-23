import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { ApiProperty } from '@nestjs/swagger';
import { Repository } from 'typeorm';
import { AuthUser } from '../auth/auth-user';
import { BONUS_BALANCE_SQL } from './bonus.logic';
import {
  BonusTransaction,
  BonusTransactionDto,
  toBonusTransactionDto,
} from './bonus-transaction.entity';

/** ответ GET /bonuses/my: счёт и история движений */
export class BonusAccountDto {
  @ApiProperty({
    example: 350,
    description: 'баланс: SUM(accrual) − SUM(spend) от источника, 1 бонус = 1 ₽',
  })
  balance!: number;

  @ApiProperty({
    type: [BonusTransactionDto],
    description: 'движения счёта, свежие сверху (кэшбэк, оплаты, возвраты)',
  })
  transactions!: BonusTransactionDto[];
}

@Injectable()
export class BonusService {
  constructor(
    @InjectRepository(BonusTransaction)
    private readonly ledger: Repository<BonusTransaction>,
  ) {}

  /** личный кабинет: баланс считается от источника, история — сверху свежие */
  async my(user: AuthUser, limit = 20): Promise<BonusAccountDto> {
    const [rows, balanceRows] = await Promise.all([
      this.ledger.find({
        where: { userId: user.id },
        order: { createdAt: 'DESC' },
        take: limit,
      }),
      this.ledger.manager.query<{ balance: string | null }[]>(
        BONUS_BALANCE_SQL,
        [user.id],
      ),
    ]);
    // SUM(int) → bigint, pg-драйвер отдаёт строкой
    return {
      balance: Number(balanceRows[0]?.balance ?? 0),
      transactions: rows.map(toBonusTransactionDto),
    };
  }
}
