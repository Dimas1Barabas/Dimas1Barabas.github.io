import {combineReducers, configureStore, createSelector} from '@reduxjs/toolkit';
import {useDispatch, useSelector, useStore} from 'react-redux';

export type UserSelectedAction = {
  type: 'userSelected';
  payload: {
    userId: UserId;
  };
}

export type UserRemoveSelectedAction = {
  type: 'userRemoveSelected';
}

export type UsersStoredAction = {
  type: 'usersStored';
  payload: {
    users: User[];
  };
}

export type UserId = string;

export type User = {
  id: UserId;
  name: string;
  description: string;
}

const users: User[] = Array.from({length: 3000}, (_, index) => ({
  id: `user${index + 11}`,
  name: `User ${index + 11}`,
  description: `Description for User ${index + 11}`,
}));

type UserState = {
  entities: Record<UserId, User | undefined>;
  ids: UserId[];
  selectedUserId: UserId | undefined;
}

export type IncrementAction = {
  type: 'increment';
  payload: {
    counterId: CounterId
  };
}

export type DecrementAction = {
  type: 'decrement';
  payload: {
    counterId: CounterId
  };
}

type Action =
  IncrementAction
  | DecrementAction
  | UserSelectedAction
  | UserRemoveSelectedAction
  | UsersStoredAction;
  

type CounterState = {
  counter: number;
}

type CountersState = Record<CounterId, CounterState | undefined>

export type CounterId = string


const initialCounterState: CounterState = {
  counter: 0
}

const initialCountersState: CountersState = {}

const initialUsersState: UserState = {
  entities: {},
  ids: [],
  selectedUserId: undefined,
}

const usersReducer = (state = initialUsersState, action: Action): UserState => {
  switch (action.type) {
    case 'usersStored': {
      const {users} = action.payload
      return {
        ...state,
        entities: users.reduce((acc, user) => {
          acc[user.id] = user;
          return acc
        }, {} as Record<UserId, User>),
        ids: users.map((user) => user.id),
      }
    }
    case 'userSelected': {
      const {userId} = action.payload
      return {
        ...state,
        selectedUserId: userId,
      }
    }
    case 'userRemoveSelected': {
      return {
        ...state,
        selectedUserId: undefined,
      }
    }
    default: {
      return state;
    }
  }
}

const countersReducer = (state = initialCountersState, action: Action): CountersState => {
  switch (action.type) {
    case 'decrement':
    case 'increment': {
      const { counterId } = action.payload
      const currentCounter = state[counterId] ?? initialCounterState
      return {
        ...state,
        [counterId]: {
          ...currentCounter,
          counter: action.type === 'increment'
            ? currentCounter.counter + 1
            : currentCounter.counter - 1
        }
      };
    }
    default:
      return state;
  }
}

const reducer = combineReducers({
  users: usersReducer,
  counters: countersReducer
})

export const store = configureStore({
  reducer: reducer,
})

store.dispatch({type: 'usersStored', payload: {users}} satisfies UsersStoredAction)

export const selectCounter =
  (state: AppSate, counterId: CounterId) => state.counters[counterId]

export type AppSate = ReturnType<typeof store.getState>
export type AppDispatch = typeof store.dispatch

export const useAppSelector = useSelector.withTypes<AppSate>()
export const useAppDispatch = useDispatch.withTypes<AppDispatch>()
export const useAppStore = useStore.withTypes<typeof store>()
export const createAppSelector = createSelector.withTypes<AppSate>()
