'use client'

import {ColumnDef} from '@tanstack/table-core';
import {Button} from '@/components/ui/Button';
import {ArrowUpDown} from 'lucide-react';

export interface IOrderColumn {
  createdAt: string
  status: string
  total: string
}

export const OrderColumns: ColumnDef<IOrderColumn>[] = [
  {
    accessorKey: 'createdAt',
    header: ({column}) => {
      return (
        <Button
          variant='ghost'
          onClick={() =>
            column.toggleSorting(column.getIsSorted() === 'asc')
          }
        >
          Дата оплаты
          <ArrowUpDown className='ml-2 h-4 w-4' />
        </Button>
      )
    }
  },
  {
    accessorKey: 'status',
    header: ({column}) => {
      return (
        <Button
          variant='ghost'
          onClick={() =>
            column.toggleSorting(column.getIsSorted() === 'asc')
          }
        >
          Статус
          <ArrowUpDown className='ml-2 h-4 w-4' />
        </Button>
      )
    }
  },
  {
    accessorKey: 'total',
    header: ({column}) => {
      return (
        <Button
          variant='ghost'
          onClick={() =>
            column.toggleSorting(column.getIsSorted() === 'asc')
          }
        >
          Сумма
          <ArrowUpDown className='ml-2 h-4 w-4' />
        </Button>
      )
    }
  },
]