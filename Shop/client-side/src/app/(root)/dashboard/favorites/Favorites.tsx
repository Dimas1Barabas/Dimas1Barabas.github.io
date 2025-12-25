'use client'

import {useProfile} from '@/hooks/useProfile';
import {Catalog} from '@/components/ui/catalog/Catalog';

export function Favorites() {
  const {user} = useProfile()
  
  if(!user){
    return null
  }
  
  return (
    <div>
      <Catalog title='Избранное' products={user.favorites} />
    </div>
  )
}