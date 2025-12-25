import {IProduct} from '@/shared/types/product.interface';
import {useProfile} from '@/hooks/useProfile';
import {useDeleteReviews} from '@/hooks/queries/reviews/useDeleteReviews';
import {ReviewModal} from '@/components/ui/modals/ReviewModal';
import {Button} from '@/components/ui/Button';
import {Plus, Trash} from 'lucide-react';
import Image from 'next/image';
import {ConfirmModal} from '@/components/ui/modals/ConfirmModal';
import {Rating} from 'react-simple-star-rating';

interface ProductReviewsProps {
  product: IProduct;
}

export function ProductReviews({product}: ProductReviewsProps) {
  const {user} = useProfile()
  
  const {deleteReviews} = useDeleteReviews()
  
  return (
    <>
      <div>
        <h1>Отзовы</h1>
        {user && (
          <ReviewModal storeId={product.storeId} >
            <Button variant='ghost' >
              <Plus />
              Добавить отзыв
            </Button>
          </ReviewModal>
        )}
      </div>
      <div>
        {product.reviews.length ? (
          product.reviews.map(review => (
            <div>
              <div>
                <div>
                  <Image
                    src={review.user.picture}
                    alt={review.user.name}
                    width={40}
                    height={40}
                  />
                  {review.user.name}
                </div>
                {review.user.id === user?.id && (
                  <ConfirmModal handleClick={() => deleteReviews(review.id)} >
                    <button>
                      <Trash />
                    </button>
                  </ConfirmModal>
                )}
              </div>
              <Rating
                readonly
                initialValue={review.rating}
                SVGstyle={{
                  display: 'inline-block',
                }}
                size={18}
                allowFraction
                transition
              />
              <div>{review.text}</div>
            </div>
          ))
        ) : (
          <div>
            У этого товара нету отзывов
          </div>
        )}
      </div>
    </>
  )
}