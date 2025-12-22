import {useGetStatistics} from '@/hooks/statistics/useGetStatistics';
import styles from './MiddleStatistics.module.scss'
import { LastUsers } from './LastUsers';
import {Overview} from '@/app/store/[storeId]/statistics/middle-statistics/Overview';

export function MiddleStatistics() {
  const { middle } = useGetStatistics()
  
  return (
    <div className={styles.middle}>
      {middle?.monthlySales.length || middle?.lastUsers.length ? (
        <>
          <div className={styles.overview}>
            <Overview data={middle.monthlySales} />
          </div>
          <div className={styles.last_users}>
            <LastUsers data={middle.lastUsers} />
          </div>
        </>
      ) : (
        <div>Нету данных для статистики</div>
      )}
    </div>
  )
}