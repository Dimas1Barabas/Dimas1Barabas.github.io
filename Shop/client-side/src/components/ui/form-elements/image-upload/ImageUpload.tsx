import {useUpload} from '@/components/ui/form-elements/image-upload/useUpload';
import styles from './ImageUpload.module.scss'
import Image from 'next/image';
import {Button} from '@/components/ui/Button';
import {ImagePlus} from 'lucide-react';
import {hidden} from 'next/dist/lib/picocolors';

interface ImageUploadProps {
  isDisabled: boolean;
  onChange: (value: string[]) => void;
  value: string[]
}

export function ImageUpload({isDisabled, onChange, value}: ImageUploadProps) {
  const {handleButtonClick, isUploading, fileInputRef, handleFileChange} = useUpload(onChange)
  
  return (
    <div>
      <div className={styles.image_container}>
        {value.map(url => (
          <div key={url} className={styles.image_wrapper}>
            <Image src={url} alt='Картинка' fill />
          </div>
        ))}
      </div>
      <Button type='button' disabled={isDisabled || isUploading} variant='secondary' onClick={handleButtonClick} >
        <ImagePlus />
        Загрузить картинки
      </Button>
      <input type="file" multiple className='hidden' ref={fileInputRef} onChange={handleFileChange} disabled={isDisabled}/>
    </div>
  )
}