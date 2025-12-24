import {Metadata} from 'next';
import {NO_INDEX_PAGE} from '@/constants/seo.constants';
import Link from 'next/link';
import {Button} from '@/components/ui/Button';
import { ArrowRight } from 'lucide-react';
import {PUBLIC_URL} from '@/config/url.config';

export const metadata: Metadata = {
  title: 'Спасибо за покупку',
  ...NO_INDEX_PAGE
}

export default function ThanksPage() {
  return (
    <div>
      <h1>Спасибо за покупку</h1>
      <p>Спасибо вам друзья Lorem ipsum dolor sit amet, consectetur adipisicing elit. Ea itaque laborum quidem.</p>
      <Link href={PUBLIC_URL.home()}  >
        <Button>
          На главную
          <ArrowRight />
        </Button>
      </Link>
    </div>
  )
}