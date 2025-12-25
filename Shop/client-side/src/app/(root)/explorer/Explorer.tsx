'use client'

import {IProduct} from '@/shared/types/product.interface';
import {useSearchParams} from 'next/navigation';
import {useQuery} from '@tanstack/react-query';
import {productService} from '@/services/product.service';
import {Catalog} from '@/components/ui/catalog/Catalog';

interface ExplorerProps {
  products: IProduct[]
}

export function Explorer({ products }: ExplorerProps) {
  const searchParams = useSearchParams()
  const searchTerm = searchParams.get('searchTerm')
  
  const {data} = useQuery({
    queryKey: ['product explorer', searchTerm],
    queryFn: () => productService.getAll(searchTerm)
    initialData: products
  })
  
  return (
    <div>
      <Catalog title={searchTerm ? `Поиск по запросу "${searchTerm}"` : 'Каталог товаров'} products={data} />
    </div>
  )
}