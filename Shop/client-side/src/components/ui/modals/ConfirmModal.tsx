import {PropsWithChildren} from 'react';
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel,
  AlertDialogContent, AlertDialogDescription, AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger
} from '@/components/ui/AlertDialog';
import {Button} from '@/components/ui/Button';

interface ConfirmModalProps {
  handleClick: () => void;
}

export function ConfirmModal({children, handleClick}: PropsWithChildren<ConfirmModalProps>) {
  return (
    <AlertDialog>
      <AlertDialogTrigger asChild>
        {children}
      </AlertDialogTrigger>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Вы уверены?</AlertDialogTitle>
          <AlertDialogDescription>Это действие нельзя будет отменить</AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>Закрыть</AlertDialogCancel>
          <AlertDialogAction onClick={() => handleClick()}>Продолжить</AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}