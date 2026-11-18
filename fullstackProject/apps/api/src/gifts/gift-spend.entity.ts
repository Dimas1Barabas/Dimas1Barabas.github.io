import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
  Unique,
} from 'typeorm';
import { Booking } from '../bookings/booking.entity';
import { GiftCertificate } from './gift-certificate.entity';
import { User } from '../users/user.entity';

/**
 * Журнал трат сертификата: строка — одно применение карты к брони
 * (сколько сняли в этой оплате). uq (certificate_id, booking_id) не даёт
 * применить одну карту к одной брони дважды. reversed_at помечает
 * возврат: отменённая бронь или провал оплаты возвращают деньги на
 * карту ровно один раз — возврат «забирает» незаполненные строки
 * атомарным UPDATE … WHERE reversed_at IS NULL, повторный вердикт
 * ничего не находит (идемпотентность, как метка referral_rewarded_at).
 */
@Entity('gift_spends')
@Unique('uq_gift_spends_certificate_booking', ['certificateId', 'bookingId'])
export class GiftSpend {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ name: 'certificate_id', type: 'uuid' })
  certificateId: string;

  @ManyToOne(() => GiftCertificate, { nullable: false })
  @JoinColumn({ name: 'certificate_id' })
  certificate: GiftCertificate;

  @Index('idx_gift_spends_booking')
  @Column({ name: 'booking_id', type: 'uuid' })
  bookingId: string;

  @ManyToOne(() => Booking, { nullable: false })
  @JoinColumn({ name: 'booking_id' })
  booking: Booking;

  /** кто тратил — всегда владелец активированной карты */
  @Column({ name: 'user_id', type: 'uuid' })
  userId: string;

  @ManyToOne(() => User, { nullable: false })
  @JoinColumn({ name: 'user_id' })
  user: User;

  /** сколько рублей сняли с карты (положительное целое) */
  @Column({ type: 'int' })
  amount: number;

  /** метка возврата (отмена брони / провал оплаты); null — трата живёт */
  @Column({ name: 'reversed_at', type: 'timestamptz', nullable: true })
  reversedAt: Date | null;

  /** журнал append-only — записи только добавляются, updated_at не нужен */
  @CreateDateColumn({ name: 'created_at' })
  createdAt: Date;
}
