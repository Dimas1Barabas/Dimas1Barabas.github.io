'use client'

import {useParams} from 'next/navigation';
import {useGetProducts} from '@/hooks/queries/products/useGetProducts';
import {IProductColumn, productColumns} from '@/app/store/[storeId]/products/ProductColumns';
import {formatPrice} from '@/utils/string/format-price';
import styles from '../Store.module.scss'
import DataTableLoading from '@/components/ui/data-table/DataTableLoading';
import {Heading} from '@/components/ui/Heading';
import Link from 'next/link';
import {STORE_URL} from '@/config/url.config';
import {Button} from '@/components/ui/Button';
import {Plus} from 'lucide-react';
import {DataTable} from '@/components/ui/data-table/DataTable';

export function Products() {
  const params = useParams<{ storeId: string }>()
  const {products, isLoading} = useGetProducts()
  
  const formattedProducts: IProductColumn[] = products ? products.map(product => ({
    id: product.id,
    title: product.title,
    price: formatPrice(product.price),
    category: product.category.title,
    color: product.color.value,
    storeId: product.storeId,
  })) : [];
  
  return (
    <div className={styles.wrapper}>
      {isLoading ? (
        <DataTableLoading />
      ) : (
        <>
          <div className={styles.header}>
            <Heading
              title={`Товары (${products?.length})`}
              description='Все для вашего магазина'
            />
            <div className={styles.buttons}>
              <Link href={STORE_URL.productCreate(params.storeId)} >
                <Button variant='primary'>
                  <Plus />
                  Создать
                </Button>
              </Link>
            </div>
          </div>
          <div className={styles.table}>
            <DataTable columns={productColumns} data={formattedProducts} filterKey='title'/>
          </div>
        </>
      )}
    </div>
  )
}