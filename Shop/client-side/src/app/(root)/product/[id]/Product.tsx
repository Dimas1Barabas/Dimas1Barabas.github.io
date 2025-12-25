'use client'

import {IProduct} from '@/shared/types/product.interface';
import {useQuery} from '@tanstack/react-query';
import {productService} from '@/services/product.service';
import {Catalog} from '@/components/ui/catalog/Catalog';
import {ProductGallary} from '@/app/(root)/product/[id]/product-gallary/ProductGallary';
import {ProductInfo} from '@/app/(root)/product/[id]/product-info/ProductInfo';
import {ProductReviews} from '@/app/(root)/product/[id]/product-reviews/ProductReviews';

interface ProductProps {
 initialProduct: IProduct
 similarProducts: IProduct[]
 id?: string
}

export default function Product({initialProduct, similarProducts, id = ''}: ProductProps) {
 const { data: product } = useQuery({
  queryKey: ['product', initialProduct.id],
  queryFn: () => productService.getById(id),
  initialData: initialProduct,
  enabled: !!id,
 })
 
 return (
   <div>
     <div>
       <div>
        <ProductGallary product={product} />
        <ProductInfo product={product} />
       </div>
     </div>
    <Catalog title='Похожие товары ' products={similarProducts} />
    <ProductReviews product={product} />
   </div>
 )
}