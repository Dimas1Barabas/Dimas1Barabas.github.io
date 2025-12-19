'use client'

import {PropsWithChildren, useState} from 'react';
import {QueryClient} from '@tanstack/query-core';
import {QueryClientProvider} from '@tanstack/react-query';
import {Toaster} from 'react-hot-toast';

export function Providers({ children }: PropsWithChildren) {
  const [client, setProviders] = useState(
    new QueryClient({
      defaultOptions: {
        queries: {
          refetchOnWindowFocus: false,
        }
      }
    })
  );
  
  return (
    <QueryClientProvider client={client}>
      <Toaster />
      {children}
    </QueryClientProvider>
  )
}