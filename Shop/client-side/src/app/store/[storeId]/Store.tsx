'use client'

import styles from './Store.module.scss'
import { Heading } from '@/components/ui/Heading';
import {MainStatistics} from '@/app/store/[storeId]/statistics/main-statistics/MainStatistics';
import {MiddleStatistics} from '@/app/store/[storeId]/statistics/middle-statistics/MiddleStatistics';

const Store = () => {
  return (
    <div className={styles.wrapper}>
      <Heading title='Статистика'/>
      <MainStatistics />
      <MiddleStatistics />
    </div>
  );
};

export default Store;