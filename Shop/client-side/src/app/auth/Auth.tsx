'use client'

import {useState} from 'react';
import {useAuthForm} from '@/app/auth/useAuthForm';

import styles from './Auth.module.scss'
import Image from 'next/image';
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle
} from '@/components/ui/form-elements/Card';
import {Form} from '@/components/ui/form-elements/Form';
import {Button} from '@/components/ui/Button';
import {AuthFields} from '@/app/auth/AuthFields';
import {Social} from '@/app/auth/Social';

const Auth = () => {
  const [isReg, setIsReg] = useState(false)
  
  const {onSubmit, form, isPending} = useAuthForm(isReg)
  
  return (
    <div className={styles.wrapper}>
      <div className={styles.left}>
        <Image
          src="/images/auth.svg"
          alt="TeaShop"
          width={100}
          height={100}
        />
      </div>
      <div className={styles.right}>
        <Card className={styles.card}>
          <CardHeader className={styles.header}>
            <CardTitle>
              {isReg ? 'Создать акк' : 'Войти в акк'}
            </CardTitle>
            <CardDescription >
              Войдите или создайте учетную запись, что бы тратить деньги
            </CardDescription>
          </CardHeader>
          <CardContent className={styles.content}>
            <Form {...form}>
              <form onSubmit={form.handleSubmit(onSubmit)}>
                <AuthFields
                  form={form}
                  isPending={isPending}
                  isReg={isReg}
                />
                <Button disabled={isPending}>
                  {isReg ? 'Продолжить' : 'Авторизоваться'}
                </Button>
              </form>
            </Form>
            <Social />
          </CardContent>
          <CardFooter className={styles.footer}>
            {isReg ? 'Уже есть акк' : 'Еще нет акк'}
            <button onClick={() => setIsReg(!isReg)}>
              {isReg ? 'Войти' : 'Создать'}
            </button>
          </CardFooter>
        </Card>
      </div>
    </div>
  )
};

export default Auth;