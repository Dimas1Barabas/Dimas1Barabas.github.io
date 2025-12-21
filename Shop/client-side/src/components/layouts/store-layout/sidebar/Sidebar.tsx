import Navigation from './navigation/Navigation';
import styles from './Sidebar.module.scss'
import Logo from '@/components/layouts/main-layout/header/logo/Logo';

export default function Sidebar() {
  return (
    <div className={styles.sidebar}>
      <Logo />
      <Navigation />
    </div>
  );
}