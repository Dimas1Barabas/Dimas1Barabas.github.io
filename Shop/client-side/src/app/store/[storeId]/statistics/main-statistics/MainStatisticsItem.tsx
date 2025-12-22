import {IMainStatistics} from '@/shared/types/statistics.inerface';
import {getIcon} from '@/app/store/[storeId]/statistics/main-statistics/statistics.utis';
import {Card, CardContent, CardHeader, CardTitle} from '@/components/ui/form-elements/Card';
import styles from './MainStatistics.module.scss'
import CountUp from 'react-countup';
import {formatPrice} from '@/utils/string/format-price';

interface MainStatisticsItemProps {
  item: IMainStatistics
}

export function MainStatisticsItem({ item }: MainStatisticsItemProps) {
  const Icon = getIcon(item.id)
  
  return (
    <Card className={styles.card}>
      <CardHeader className={styles.header}>
        <CardTitle>{item.name}</CardTitle>
        <Icon />
      </CardHeader>
      <CardContent className={styles.content}>
        <h2>
          {item.id !== 1 ? (
            <CountUp end={item.value} />
          ) : (
            <CountUp end={item.value} formattingFn={formatPrice} />
          )}
        </h2>
      </CardContent>
    </Card>
  )
}