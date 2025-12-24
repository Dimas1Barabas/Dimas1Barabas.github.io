import styles from './Footer.module.scss'
import {SITE_NAME} from '@/constants/seo.constants';

export function Footer() {
  return (
    <div className={styles.wpapper}>
      <div className={styles.footer}>
        {SITE_NAME} &copy; 2025
      </div>
    </div>
  )
}