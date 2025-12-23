import {ColumnDef} from '@tanstack/table-core';
import {Button} from '@/components/ui/Button';
import {ArrowUpDown, ExternalLink, MoreHorizontal, Pencil} from 'lucide-react';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger
} from '@/components/ui/DropdownMenu';
import {PUBLIC_URL, STORE_URL} from '@/config/url.config';

export  interface IProductColumn {
  id: string
  title: string
  price: string
  category: string
  color: string
  storeID: string
}

export const columns: ColumnDef<IProductColumn>[] = [
  {
    accessorKey: 'title',
    header: ({column}) => {
      return (
        <Button variant='ghost' onClick={() => column.toggleSorting(column.getIsSorted() === 'asc')} >
          Название
          <ArrowUpDown />
        </Button>
      )
    }
  },
  {
    accessorKey: 'price',
    header: ({column}) => {
      return (
        <Button variant='ghost' onClick={() => column.toggleSorting(column.getIsSorted() === 'asc')} >
          Цена
          <ArrowUpDown />
        </Button>
      )
    }
  },
  {
    accessorKey: 'category',
    header: ({column}) => {
      return (
        <Button variant='ghost' onClick={() => column.toggleSorting(column.getIsSorted() === 'asc')} >
          Категория
          <ArrowUpDown />
        </Button>
      )
    }
  },
  {
    accessorKey: 'color',
    header: ({column}) => {
      return (
        <Button variant='ghost' onClick={() => column.toggleSorting(column.getIsSorted() === 'asc')} >
          Цвет
          <ArrowUpDown />
        </Button>
      )
    },
    cell: ({row}) => (
      <div className='flex items-center gap-x-3'>
        {row.original.color}
        <div className='size' style={{backgroundColor: row.original.color}}></div>
      </div>
    )
  },
  {
    accessorKey: 'actions',
    header: 'Действия',
    cell: ({row}) => (
      <DropdownMenu>
        <DropdownMenuTrigger asChild >
          <Button variant='ghost'>
            <MoreHorizontal />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align='end'>
          <DropdownMenuLabel>Действия</DropdownMenuLabel>
          <Link
            href={PUBLIC_URL.product(row.original.id)}
            target='_blank'
          >
            <DropdownMenuItem>
              <ExternalLink />
              Страница с продуктом
            </DropdownMenuItem>
          </Link>
          <Link
            href={STORE_URL.productEdit(row.original.storeID, row.original.id)}
          >
            <DropdownMenuItem>
              <Pencil />
              Изменить
            </DropdownMenuItem>
          </Link>
        </DropdownMenuContent>
      </DropdownMenu>
    )
  },
]