'use client'

import {useProfile} from '@/hooks/useProfile';
import Link from 'next/link';
import {DASHBOARD_URL, PUBLIC_URL, STORE_URL} from '@/config/url.config';
import {Button} from '@/components/ui/Button';
import Loader from '@/components/ui/Loader';
import {LogOut} from 'lucide-react';
import {CreateStoreModal} from '@/components/ui/modals/CreateStoreModal';
import Image from 'next/image';

function HeaderCard() {
  return null;
}

export function HeaderMenu() {
  const {user, isLoading} = useProfile()
  
  return (
    <div>
      <HeaderCard/>
      <Link href={PUBLIC_URL.explorer()} >
        <Button variant='ghost'>Каталог</Button>
      </Link>
      {isLoading ? (
        <Loader />
      ) : user ? (
        <>
          <Link href={DASHBOARD_URL.favorites()} >
            <Button variant='ghost'>Избранное</Button>
          </Link>
          {user.stores.length ? (
            <Link href={STORE_URL.home(user.stores[0].id)}>
              <Button variant='ghost'>Мои магазины</Button>
            </Link>
          ) : (
            <CreateStoreModal>
              <Button variant='ghost'>Создать магазин</Button>
            </CreateStoreModal>
          )}
          <Link href={DASHBOARD_URL.home()} >
            <Image
              src={user.picture}
              alt={user.name}
              width={42}
              height={42}
            />
          </Link>
        </>
      ) : (
        <Link href={PUBLIC_URL.auth()} >
          <Button >
            <LogOut />
            Войти
          </Button>
        </Link>
      )}
    </div>
  )
}