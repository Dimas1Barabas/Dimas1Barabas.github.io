import {useGetStatistics} from '@/hooks/statistics/useGetStatistics';
import styles from './MainStatistics.module.scss'
import {MainStatisticsItem} from '@/app/store/[storeId]/statistics/main-statistics/MainStatisticsItem';

export function MainStatistics() {
  const { main } = useGetStatistics()
  
  return (
    <div className={styles.main}>
      {main?.length ? (
        main?.map(item => (
          <MainStatisticsItem key={item.id} item={item} />
        ))
      ) : (
        <div>Нету данных для статистики</div>
      )}
    </div>
  )
}