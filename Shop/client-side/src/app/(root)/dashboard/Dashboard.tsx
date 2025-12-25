'use client'

import {useSearchParams} from 'next/navigation';
import {useEffect} from 'react';
import {saveTokenStorage} from '@/services/auth/auth-token.service';
import {useMutation} from '@tanstack/react-query';
import {authService} from '@/services/auth/auth.service';
import {IOrderColumn, OrderColumns} from '@/app/(root)/dashboard/OrderColumns';
import {formatDate} from '@/utils/date/format-date';
import {EnumOrderStatus} from '@/shared/types/order.interface';
import {formatPrice} from '@/utils/string/format-price';
import {useRouter} from 'next/router';
import {useProfile} from '@/hooks/useProfile';
import {Button} from '@/components/ui/Button';
import {LogOut} from 'lucide-react';
import {DataTable} from '@/components/ui/data-table/DataTable';

export function Dashboard() {
  const searchParams = useSearchParams()
  const router = useRouter()
  const {user} = useProfile()
  
  useEffect(() => {
    const accessToken = searchParams.get('accessToken')
    
    if (accessToken) {
      saveTokenStorage(accessToken)
    }
  }, [searchParams]);
  
  const { mutate: logout} = useMutation({
    mutationKey: ['logout'],
    mutationFn: () => authService.logout(),
    onSuccess: () => router.push('/auth'),
  })
  
  if(!user) return null
  
  const formattedOrders: IOrderColumn[] = user.orders.map(order => ({
    createdAt: formatDate(order.createdAt),
    status: order.status === EnumOrderStatus.PENDING ? 'В ожидании' : 'Оплачен',
    total: formatPrice(order.total),
  }))
  
  return (
    <div>
      <div>
        <h1>Ваши заказы</h1>
        <Button variant='ghost' onClick={() => logout()}>
          <LogOut />
          Выйти
        </Button>
      </div>
      <DataTable columns={OrderColumns} data={formattedOrders} />
    </div>
  );
}