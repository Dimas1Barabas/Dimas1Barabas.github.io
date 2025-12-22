import {ILastUsers, IMonthlySales} from '@/shared/types/statistics.inerface';
import {Card, CardContent, CardHeader, CardTitle} from '@/components/ui/card';
import styles from '@/app/store/[storeId]/statistics/middle-statistics/MiddleStatistics.module.scss';
import Image from 'next/image';
import { formatPrice } from '@/utils/string/format-price';

interface LastUsersProps {
  data: ILastUsers[]
}

export function LastUsers({ data }: LastUsersProps) {
  return (
    <Card>
      <CardHeader className={styles.header}>
        <CardTitle>Прибыль</CardTitle>
      </CardHeader>
      <CardContent>
        {data.length ? (
          data.map(user => (
            <div className={styles.user}>
              <Image src={user.picture} alt={user.name} width={40} height={40} />
              <div className={styles.info}>
                <p className={styles.name}>{user.name}</p>
                <p>{user.email}</p>
              </div>
              <div className={styles.total}>
                +{formatPrice(user.total)}
              </div>
            </div>
          ))
        ) : (
          <div>У этого магазина нету покупателей</div>
        )}
      </CardContent>
    </Card>
  )
}