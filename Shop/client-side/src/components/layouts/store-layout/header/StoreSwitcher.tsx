'use client'

import {IStore} from '@/shared/types/store.interface';
import {useState} from 'react';
import {useRouter} from 'next/router';
import {STORE_URL} from '@/config/url.config';
import {Popover, PopoverContent, PopoverTrigger} from '@/components/ui/Popover';
import {Button} from '@/components/ui/Button';
import {ChevronsUpDown, Plus, StoreIcon} from 'lucide-react';
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandSeparator
} from '@/components/ui/Command';
import {CreateStoreModal} from '@/components/ui/modals/CreateStoreModal';

interface StoreSwitcher {
  items: IStore[]
}

export default function StoreSwitcher({items}: StoreSwitcher) {
  const router = useRouter()
  
  const [isOpen, setIsOpen] = useState(false)
  
  const onStoreSelect = (storeId: string) => {
    setIsOpen(false)
    router.push(STORE_URL.home(storeId))
  }
  
  return (
    <Popover open={isOpen} onOpenChange={setIsOpen}>
      <PopoverTrigger asChild>
        <Button variant='outline' size='sm' role='combobox' aria-expanded={isOpen} aria-label="Выберите магазин" className='w-52'>
          <StoreIcon className='mt-2' />
          Текущий магазин
          <ChevronsUpDown className='ml-auto' />
        </Button>
      </PopoverTrigger>
      <PopoverContent className='w-52 p-0'>
        <Command>
          <CommandList>
            <CommandInput placeholder='Найти магазин...' />
            <CommandEmpty>Ничего не найдено.</CommandEmpty>
            <CommandGroup heading='Магазины'>
              {items.map(store => (
                <CommandItem key={store.id} onSelect={() => store.id} className='text-sm'>
                  <StoreIcon className='mr-2 size-4' />
                  <div className="line-clamp-1">{store.title}</div>
                </CommandItem>
              ))}
            </CommandGroup>
          </CommandList>
          <CommandSeparator />
          <CommandList >
            <CommandGroup>
              <CreateStoreModal>
                <CommandItem>
                  <Plus className='mr-2 size-4' />
                  Создать магазин
                </CommandItem>
              </CreateStoreModal>
            </CommandGroup>
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  )
}