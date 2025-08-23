import pxToRem from './utils/pxToRem.js';

const MatchMedia = {
  mobile: window.matchMedia(`(width <= ${pxToRem(769.98)}rem)`)
}

export default MatchMedia