import {IProduct} from '@/shared/types/product.interface';
import {useState} from 'react';
import Image from 'next/image';

interface ProductGalleryProps {
  product: IProduct;
}

export function ProductGallary({product}: ProductGalleryProps) {
  const [currentIndex, setCurrentIndex] = useState(0)
  
  return (
    <div>
      <Image
        src={product.images[currentIndex]}
        alt={product.title}
        width={500}
        height={500}
      />
      <div>
        {product.images.map((image, index) => (
          <button
            key={index}
            onClick={() => setCurrentIndex(index)}
          >
            <Image
              src={image}
              alt={product.title}
              width={100}
              height={100}
            />
          </button>
        ))}
      </div>
    </div>
  )
}