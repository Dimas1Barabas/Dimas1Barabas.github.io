import {IProduct} from '@/shared/types/product.interface';
import Link from 'next/link';
import {PUBLIC_URL} from '@/config/url.config';
import Image from 'next/image';
import {formatPrice} from '@/utils/string/format-price';

interface ProductCardProps {
  product: IProduct
}

export function ProductCard({ product }: ProductCardProps) {
  return (
    <div>
      <Link href={PUBLIC_URL.product(product.id)}>
        <Image
          src={product.images[0]}
          alt={product.title}
          width={300}
          height={300}
        />
      </Link>
      <h3>{product.title}</h3>
      <Link href={PUBLIC_URL.category(product.category.id)}>
        {product.category.title}
      </Link>
      <p>{formatPrice(product.price)}</p>
    </div>
  )
}