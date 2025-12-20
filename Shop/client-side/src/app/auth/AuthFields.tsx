import {UseFormReturn} from 'react-hook-form';
import {IAuthForm} from '@/shared/types/auth.interface';
import {FormControl, FormField, FormItem, FormMessage} from '@/components/ui/form-elements/Form';
import { Input } from '@/components/ui/form-elements/Input';
import {validEmail} from '@/shared/regex';

interface AuthFieldsProps {
  form: UseFormReturn<IAuthForm, any, IAuthForm>
  isPending: boolean
  isReg?: boolean
}

export function AuthFields({
  form,
  isPending,
  isReg = false
}: AuthFieldsProps) {
  return(
  <>
    {isReg && (
      <FormField
        control={form.control}
        name='name'
        rules={{
          required: 'Имя обязательно',
        }}
        render={(field) => (
          <FormItem>
            <FormControl>
              <Input placeholder="Иван" disabled={isPending} {...field}/>
            </FormControl>
            <FormMessage />
          </FormItem>
        )}
      />
    )}
    <FormField
      control={form.control}
      name='email'
      rules={{
        required: 'Почта обязательна',
        pattern: {
          value: validEmail,
          message: 'Введите валидную почту'
        }
      }}
      render={(field) => (
        <FormItem>
          <FormControl>
            <Input placeholder="ivan@example.com" type='email' disabled={isPending} {...field}/>
          </FormControl>
          <FormMessage />
        </FormItem>
      )}
    />
    <FormField
      control={form.control}
      name='password'
      rules={{
        required: 'Пароль обязателен',
        minLength: {
          value: 6,
          message: 'Минимум 6 символов',
        }
      }}
      render={(field) => (
        <FormItem>
          <FormControl>
            <Input placeholder="******" type='password' disabled={isPending} {...field}/>
          </FormControl>
          <FormMessage />
        </FormItem>
      )}
    />
  </>
  )
}