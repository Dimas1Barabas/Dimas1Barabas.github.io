import Link from 'next/link';
import {PUBLIC_URL} from '@/config/url.config';
import styles from './Logo.module.scss'
import Image from 'next/image';
import {SITE_NAME} from '@/constants/seo.constants';

export default function Logo() {
  return (
    <Link href={PUBLIC_URL.home()} className={styles.logo}>
      <Image
        src='/images/Logo.svg'
        alt={SITE_NAME}
        width={35}
        height={35}
      />
      <div>{SITE_NAME}</div>
    </Link>
  );
}