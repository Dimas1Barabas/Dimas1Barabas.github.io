import {SITE_DESCRIPTION} from '@/constants/seo.constants';
import Link from 'next/link';
import {PUBLIC_URL} from '@/config/url.config';
import {Button} from '@/components/ui/Button';
import {ArrowRight} from 'lucide-react';

export function Hero() {
  return (
    <div>
      <h1>Ваш шопинг - ваше удовольствие</h1>
      <p>{SITE_DESCRIPTION}</p>
      <Link href={PUBLIC_URL.explorer()}>
        <Button variant='outline'>
          За покупками
          <ArrowRight />
        </Button>
      </Link>
    </div>
  )
}