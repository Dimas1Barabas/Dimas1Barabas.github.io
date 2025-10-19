"use client"

import "./style.css"
import slidesData from "./slides.js";
import IconPlus from "./icons/IconPlus.jsx";
import {useState} from 'react';
import ChevronUp from '@components/Slider/icons/ChevronUp.jsx';
import ChevronDown from '@components/Slider/icons/ChevronDown.jsx';
import SliderContent from '@components/Slider/SliderContent';

const SlideItem = ({data, handler, index}) => {
  return (
    <li className="slide-list__item">
      <button
        onClick={() => handler(data.id, index)}
        className={`button ${data.isActive ? 'button--open' : ''}`}
      >
        {data.isActive ?
          <span>
            <strong>{data.title}.</strong>
            {data.description}
          </span> :
          <>
            <IconPlus />
            <strong>{data.title}</strong>
          </>}
      </button>
    </li>
  )
}

const Slider = ()  => {
  const [slides, setSlides] = useState(slidesData);
  const [activeSlide, setActiveSlide] = useState(null);
  
  const clickHandler = (id, index) => {
    setActiveSlide(index);
    
    setSlides((prev) => {
      return prev.map((slide) => {
        let isActive = false;
        
        if (slide.id === id) {
          isActive = true;
        }
        
        return {
          ...slide,
          isActive: isActive,
        };
      });
    })
  };
  
  const sliderMoveNext = () => {
    setSlides((prevSlides) => {
      return prevSlides.map((slide, index) => {
        let isActive = false;
        if (activeSlide + 1 === index) {
          isActive = true;
        }
        
        return {
          ...slide,
          isActive: isActive,
        }
      })
    });
    setActiveSlide((prev) => ++prev);
  }
  
  const sliderMovePrev = () => {
    setSlides((prevSlides) => {
      return prevSlides.map((slide, index) => {
        let isActive = false;
        if (activeSlide - 1 === index) {
          isActive = true;
        }
        
        return {
          ...slide,
          isActive: isActive,
        }
      })
    });
    setActiveSlide((prev) => --prev);
  }
  
  return (
    <div className="slider">
      <div className="controls">
        <div className={`controls__arrows ${(activeSlide == null) && 'controls__arrows--hidden'}`}>
          <button
            className="control-order control-order--active"
            disabled={activeSlide === 0 ? true : false}
            onClick={sliderMovePrev}
          >
            <ChevronUp />
          </button>
          <button
            className="control-order"
            disabled={activeSlide === (slides.length - 1) ? true : false}
            onClick={sliderMoveNext}
          >
            <ChevronDown />
          </button>
        </div>
        <ul className="slide-list">
          {slides.map((slide,index) =>
            <SlideItem
              data={slide}
              handler={clickHandler}
              key={index}
              index={index}
            />
          )}
        </ul>
      </div>
      
      <div className="content">
        {
          (activeSlide !== null) &&
          <SliderContent slides={slides} activeSlide={activeSlide} />
        }
      </div>
    </div>
  )
}

export default Slider;