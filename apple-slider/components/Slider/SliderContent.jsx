"use client"

import Image from 'next/image';
import FadeIn from '@components/FideIn';
import { AnimatePresence, motion } from 'framer-motion';

const SliderContent = ({activeSlide, slides}) => {
  
  return (
    <AnimatePresence mode="wait" initial={true}>
      <FadeIn
        key = {activeSlide}
        style={{
          width: '100%',
          height: '100%',
          position: 'relative',
        }}
      >
        <div className="slide-content">
          {slides[activeSlide]['content'] && (
            <video muted autoPlay className="video-cover">
              <source
                src={`/img/slides/${slides[activeSlide]['content']['url']}`}
                type={'video/mp4'}
              />
            </video>
          )}
          {!slides[activeSlide]['content'] && (
            <Image
              src={`/img/slides/${slides[activeSlide]['img']}`}
              fill
              alt="Title"
              className="object-cover"
              priority
            />
          )}
        </div>
      </FadeIn>
    </AnimatePresence>
  )
}

export default SliderContent;
