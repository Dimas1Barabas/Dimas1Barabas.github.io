import styles from './DataTable.module.scss'
import {FC} from 'react';
import {Skeleton} from '@/components/ui/skeleton';
import {Card, CardContent} from '@/components/ui/card';
import Loader from '@/components/ui/Loader';

const DataTableLoading: FC = () => {
  return (
    <div className={styles.loading}>
      <Skeleton className={styles.heading}/>
      <Skeleton className={styles.search}/>
      <Card className={styles.table}>
        <CardContent>
          <div className={styles.loader_wrapper}>
            <Loader />
          </div>
        </CardContent>
      </Card>
    </div>
  )
}

export default DataTableLoading;