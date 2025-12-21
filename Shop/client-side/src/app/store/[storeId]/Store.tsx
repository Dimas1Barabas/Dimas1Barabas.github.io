import styles from './Store.module.scss'
import { Heading } from '@/components/ui/Heading';

const Store = () => {
  return (
    <div className={styles.wrapper}>
      <Heading title='Статистика'/>
    </div>
  );
};

export default Store;