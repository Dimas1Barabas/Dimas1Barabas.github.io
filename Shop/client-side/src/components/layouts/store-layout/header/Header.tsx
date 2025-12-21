'use client'

import {useProfile} from '@/hooks/useProfile';
import styles from './Header.module.scss'
import MobileSidebar from '@/components/layouts/store-layout/sidebar/MobileSidebar';
import Link from 'next/link';
import {DASHBOARD_URL} from '@/config/url.config';
import Image from 'next/image';
import Loader from '@/components/ui/Loader';
import StoreSwitcher from '@/components/layouts/store-layout/header/StoreSwitcher';

function Header() {
  const { user, isLoading } = useProfile()
  
  return (
    <div className={styles.header}>
      <MobileSidebar />
      <div className={styles.header_menu}>
        {isLoading ? (
          <Loader size='sm' />
        )  : (
          user &&(
            <>
              <StoreSwitcher items={user.stores}/>
              <Link href={DASHBOARD_URL.home()}>
                <Image
                  src={user.picture}
                  alt={user.name}
                  width={42}
                  height={42}
                />
              </Link>
            </>
          )
        )}
      </div>
    </div>
  );
}

export default Header;