import { configureStore } from '@reduxjs/toolkit';

import { currentQuerySlice as currentQueryReducer} from '../features/currentQuerySlice.js';

export const store = configureStore({
  reducer: {
    currentSlice: currentQueryReducer,
  },
});
