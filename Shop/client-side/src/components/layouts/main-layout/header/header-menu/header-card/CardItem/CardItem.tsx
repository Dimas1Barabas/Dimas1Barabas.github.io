import {ICardItem} from '@/shared/types/card.interface';
import Link from 'next/link';
import {PUBLIC_URL} from '@/config/url.config';
import Image from 'next/image';
import {formatDate} from '@/utils/date/format-date';
import {CardAction} from '@/components/layouts/main-layout/header/header-menu/header-card/CardItem/CardActions';

interface CardItemProps {
  item: ICardItem
}

export function  CardItem({item}: CardItemProps) {
  return (
    <div>
      <Link href={PUBLIC_URL.product(item.product.id)} >
        <Image
          src={item.product.images[0]}
          alt={item.product.title}
          fill
        />
      </Link>
      <div>
        <h2>{item.product.title}</h2>
        <p>{formatDate(item.product.price)}</p>
        <CardAction item={item} />
      </div>
    </div>
  )
}