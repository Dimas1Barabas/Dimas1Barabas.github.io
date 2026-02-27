'use client'

import { Search } from 'lucide-react';
import {FC, useEffect, useRef, useState} from 'react';
import {cn} from '@/lib/utils';
import {useClickAway} from 'react-use';
import Link from 'next/link';
import {Api} from '@/services/api-client';

interface Props {
  className?: string;
}

export const SearchInput: FC<Props> = ({className}) => {
  const [searchQuery, setSearchQuery] = useState('')
  const [focused, setFocused] = useState(false)
  const ref = useRef(null)
  
  useClickAway(ref, () => {
    setFocused(false)
  })
  
  // TODO 5 45
  useEffect(() => {
    Api.products.search(searchQuery)
  }, [searchQuery]);
  
  return (
    <>
      {focused && <div className="fixed top-0 left-0 right-0 bottom-0 bg-black/50 z-30"></div>}
      
      <div
        ref={ref}
        className={cn('flex rounded-2xl flex-1 justify-between relative h-11 z-30', className)}
      >
        <Search className='absolute top-1/2 translate-y-[-50%] left-3 h-5 text-gray-400'/>
        <input
          type="text"
          placeholder='Найти пиццу...'
          className='rounded-2xl outline-none w-full bg-gray-100 pl-11'
          onFocus={() => setFocused(true)}
          value={searchQuery}
          onChange={setSearchQuery}
        />
        <div className={cn(
          'absolute w-full bg-white rounded-2xl py-2 top-14 shadow-md transition-all duration-200 invisible opacity-0 z-30',
          focused && 'visible opacity-100 top-12'
        )}>
          <Link
            className='flex items-center gap-3 w-full px-3 py-2 hover:bg-primary/15 rounded-2xl'
            href='./product/1'
          >
            <img
              className='rounded-sm h-8 w-8'
              src="https://media.dodostatic.net/image/r:292x292/11EE7970321044479C1D1085457A36EB.webp"
              alt="Пицца"
            />
            <span>Супер бутер</span>
          </Link>
        </div>
      </div>
    </>
  );
};