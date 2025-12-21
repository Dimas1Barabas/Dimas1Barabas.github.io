import type {PropsWithChildren} from 'react';

import styles from './StoreLayout.module.scss'
import Header from '@/components/layouts/store-layout/header/Header';
import Sidebar from '@/components/layouts/store-layout/sidebar/Sidebar';

export default function StoreLayout({ children }: PropsWithChildren<unknown>) {
  return (
    <div className={styles.wrapper}>
      <div className={styles.layout}>
        <div className={styles.sidebar}>
          <Sidebar />
        </div>
        <div className={styles.header}>
          <Header />
        </div>
        <main>{children}</main>
      </div>
    </div>
  );
}