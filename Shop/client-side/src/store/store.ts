import {cardSlice} from '@/store/card/card.slice';
import {combineReducers, configureStore} from '@reduxjs/toolkit';

const persistConfig = {
  key: 'tea-shop',
  localStorage,
  whiteList: ['card']
}

const isClient = typeof window !== 'undefined'

const combinedReducers = combineReducers({
  card: cardSlice.reducer,
})

let mainReducer = combinedReducers

if(isClient) {
  const {persistReducer} = require('redux-persist')
  const storage = require('redux-persist/lib/storage')
  
  mainReducer = persistReducer(persistConfig, combinedReducers)
}

export const store = configureStore({
  reducer: mainReducer,
  middleware: getDefaultMiddleware => getDefaultMiddleware({
    serializableCheck: {
      ignoredActions: [
        FLUSH,
        REHYDRATE,
        PAUSE,
        PERSIST,
        PURGE,
        REGISTER
      ]
    }
  })
})

export const persistor = persistStore(store)

export type TypeRootState = ReturnType<typeof mainReducer>