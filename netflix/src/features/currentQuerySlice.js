import { createSlice } from '@reduxjs/toolkit';

const initialState = {
  countries: '',
  genresId: '',
  order: 'NUM_VOTE',
  type: '',
  year: '',
  page: 1,
};

export const currentQuerySlice = createSlice({
  name: 'currentQuerySlice',
  initialState,
  reducers: {},
});

export default currentQuerySlice.reducer;
