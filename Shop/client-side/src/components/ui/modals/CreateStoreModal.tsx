import {PropsWithChildren, useState} from 'react';
import {useCreateStore} from '@/hooks/queries/stores/useCreateStore';
import {SubmitHandler, useForm} from 'react-hook-form';
import {IStoreCreate} from '@/shared/types/store.interface';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger
} from '@/components/ui/Dialog';
import {Form, FormControl, FormField, FormItem, FormLabel, FormMessage} from '@/components/ui/form-elements/Form';
import {Input} from '@/components/ui/form-elements/Input';
import {Button} from '@/components/ui/Button';
import {createStore} from 'redux';

export function CreateStoreModal({ children }: PropsWithChildren<unknown>) {
  const [isOpen, setIsOpen] = useState(false)
  
  const { CreateStore, isLoadingCreate } = useCreateStore()
  
  const form = useForm<IStoreCreate>({
    mode: 'onChange'
  })
  
  const onSubmit: SubmitHandler<IStoreCreate> = data => {
    createStore(data)
    setIsOpen(false)
  }
  
  return (
    <Dialog open={isOpen} onOpenChange={setIsOpen}>
      <DialogTrigger asChild>{children}</DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Создание магазина</DialogTitle>
          <DialogDescription>Для создания магазина необходимо указать название</DialogDescription>
        </DialogHeader>
        <Form {...form}>
          <form onSubmit={form.handleSubmit(onSubmit)}>
            <FormField
              control={form.control}
              name='title'
              rules={{
                required: 'Название обязательно',
              }}
              render={(field) => (
                <FormItem>
                  <FormLabel>Название</FormLabel>
                  <FormControl>
                    <Input placeholder="Название магазина" disabled={isLoadingCreate} {...field}/>
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
            <div className='flex justify-end'>
              <Button  variant='link' disabled={isLoadingCreate}>
                Создать
              </Button>
            </div>
          </form>
        </Form>
      </DialogContent>
     </Dialog>
  )
}