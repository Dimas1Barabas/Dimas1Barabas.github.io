'use client'

import styles from './Store.module.scss'
import { Heading } from '@/components/ui/Heading';
import {MainStatistics} from '@/app/store/[storeId]/statistics/main-statistics/MainStatistics';

const Store = () => {
  return (
    <div className={styles.wrapper}>
      <Heading title='Статистика'/>
      <MainStatistics />
    </div>
  );
};

export default Store;