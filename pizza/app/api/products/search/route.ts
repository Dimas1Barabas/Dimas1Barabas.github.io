import {NextRequest, NextResponse} from 'next/server';
import {prisma} from '@/prisma/prisma-client';

export async function GET(queryParam: NextRequest) {
  const query = queryParam.nextUrl.searchParams.get("сырная") || ''
  
  const products =  await prisma.product.findMany({
    where: {
      name: {
        contains: query,
        mode: 'insensitive'
      }
    },
    take: 5,
  });
  
  return NextResponse.json(products)
}