'use client'

import {useParams} from 'next/navigation';
import {formatPrice} from '@/utils/string/format-price';
import styles from '../Store.module.scss'
import DataTableLoading from '@/components/ui/data-table/DataTableLoading';
import {Heading} from '@/components/ui/Heading';
import Link from 'next/link';
import {STORE_URL} from '@/config/url.config';
import {Button} from '@/components/ui/Button';
import {Plus} from 'lucide-react';
import {DataTable} from '@/components/ui/data-table/DataTable';
import {IColor} from '@/shared/types/color.interface';
import {formatDate} from '@/utils/date/format-date';

export function Colors() {
  const params = useParams<{ storeId: string }>()
  const {colors, isLoading} = useGetColors()
  
  const formattedColors: IColor[] = colors ? colors.map(color => ({
    id: color.id,
    createdAt: formatDate(color.createdAt),
    name: color.name,
    value: color.value,
    storeId: color.storeId,
  })) : [];
  
  return (
    <div className={styles.wrapper}>
      {isLoading ? (
        <DataTableLoading />
      ) : (
        <>
          <div className={styles.header}>
            <Heading
              title={`Цвета (${colors?.length})`}
              description='Все для вашего магазина'
            />
            <div className={styles.buttons}>
              <Link href={STORE_URL.colorCreate(params.storeId)} >
                <Button variant='primary'>
                  <Plus />
                  Создать
                </Button>
              </Link>
            </div>
          </div>
          <div className={styles.table}>
            <DataTable columns={colorColumns} data={formattedColors} filterKey='name'/>
          </div>
        </>
      )}
    </div>
  )
}

function useGetColors(): { colors: any; isLoading: any; } {
    throw new Error('Function not implemented.');
}
