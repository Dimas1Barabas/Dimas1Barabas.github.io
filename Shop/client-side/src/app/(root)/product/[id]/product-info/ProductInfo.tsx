import {IProduct} from '@/shared/types/product.interface';
import {formatPrice} from '@/utils/string/format-price';
import Link from 'next/link';
import {PUBLIC_URL} from '@/config/url.config';
import {AddToCardButton} from '@/app/(root)/product/[id]/product-info/AddToCardButton';
import {FavoriteButton} from '@/app/(root)/product/[id]/product-info/FavoriteButton';
import {getReviewWordWithEnding} from '@/utils/string/get-review-word-with-ending';

interface ProductInfoProps {
  product: IProduct;
}

export function ProductInfo({product}: ProductInfoProps) {
  const rating = Math.round(product.reviews.reverse((acc, review) => acc + review.rating , 0) / product.reviews.length) || 0
  
  return (
    <div>
      <h1>{product.title}</h1>
      <div>{formatPrice(product.price)}</div>
      <hr />
      <p>{product.description}</p>
      <hr />
      <div>
        <h3>Цвет: </h3>
        <div style={{
          backgroundColor: product.color.value,
        }} />
      </div>
      <div>
        <h3>Категория: </h3>
        <Link href={PUBLIC_URL.category(product.category.id)} >
          {product.category.title}
        </Link>
      </div>
      <div>
        <h3>Средний рейтинг: </h3>
        <div>
          {rating.toFixed(1) || ''}
          {getReviewWordWithEnding(product.reviews.length)}
        </div>
      </div>
      <hr />
      <div>
        <AddToCardButton product={product} />
        <FavoriteButton product={product} />
      </div>
    </div>
  )
}