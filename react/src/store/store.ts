import {applyMiddleware, combineReducers, createStore} from '@reduxjs/toolkit';
import {thunk} from 'redux-thunk';
import reducers from './reducers';

const rootReducer = combineReducers(reducers);

export const store = createStore(rootReducer, applyMiddleware(thunk));

export type rootState = ReturnType<typeof store.getState>
export type AppDispatch = typeof store.dispatch