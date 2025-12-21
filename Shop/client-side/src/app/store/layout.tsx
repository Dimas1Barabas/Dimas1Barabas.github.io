import {PropsWithChildren} from 'react';
import StoreLayout from '@/components/layouts/store-layout/StoreLayout';

export default function Layout({children}: PropsWithChildren<unknown>) {
  return (
    <StoreLayout>
      {children}
    </StoreLayout>
  );
};