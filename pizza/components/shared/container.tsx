import {PropsWithChildren} from 'react';
import { cn } from '@/lib/utils';
import {FC} from 'react';

interface Props {
  className?: string;
}

export const Container: FC<PropsWithChildren<Props>> = ({ className, children }) => {
  return <div className={cn('mx-auto max-w-[1280px]', className)}>{children}</div>;
};