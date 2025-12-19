import {Metadata} from 'next';
import React from 'react';
import Home from '@/app/(root)/Home';

export const metadata: Metadata = {
  title: 'Ваш шопинг ваше удовольствие',
}

export default function HomePage() {
  return <Home />
}