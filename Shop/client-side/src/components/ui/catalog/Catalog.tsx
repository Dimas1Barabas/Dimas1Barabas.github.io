import {ICatalog} from '@/components/ui/catalog/catalog.interface';
import Link from 'next/link';
import { ProductCard } from './product-card/ProductCard';

export function Catalog({title, description, linkTitle,link,products}: ICatalog) {
  return (
    <div>
      <div>
        <div>
          <h1>{title}</h1>
          {description ?? <p>{description}</p>}
        </div>
        {link ?? linkTitle ?? <Link href={link}>{linkTitle}</Link>}
      </div>
      
      <div>
        <div>
          {products.length ? (
            products.map(product => (
              <ProductCard key={product.id} product={product} />
            ))
          ) : (
            <div>Ничего не найдено</div>
          )}
        </div>
      </div>
    </div>
  )
}