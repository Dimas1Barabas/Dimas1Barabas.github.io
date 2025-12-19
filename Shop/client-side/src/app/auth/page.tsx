import {Metadata} from 'next';
import React from 'react';
import Auth from '@/app/auth/Auth';

export const metadata: Metadata = {
  title: 'Авторизация',
}

export default function AuthPage() {
  return <Auth />
}