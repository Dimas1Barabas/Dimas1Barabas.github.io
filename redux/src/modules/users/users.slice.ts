import {createSelector, createSlice, type PayloadAction} from '@reduxjs/toolkit';

export type UserId = string;

export type User = {
  id: UserId;
  name: string;
  description: string;
}

type UserState = {
  entities: Record<UserId, User | undefined>;
  ids: UserId[];
  selectedUserId: UserId | undefined;
  fetchingUsersStatus: 'idle' | "pending" | "success" | "failed";
}

export const initialUsersList: User[] = Array.from(
  {length: 3000},
  (_, index) => ({
    id: `user${index + 11}`,
    name: `User ${index + 11}`,
    description: `Description for User ${index + 11}`,
  })
);

const initialUsersState: UserState = {
  entities: {},
  ids: [],
  selectedUserId: undefined,
  fetchingUsersStatus: 'idle',
}

export const usersSlice = createSlice({
  name: "users",
  initialState: initialUsersState,
  selectors: {
    selectSelectedUserId: (state) => state.selectedUserId,
    
    selectSortedUsers: createSelector(
      (state: UserState) => state.ids,
      (state: UserState) => state.entities,
      (_: UserState, sort: 'asc' | 'desc') => sort,
      (ids, entities, sort) =>
        ids
          .map(id => entities[id])
          .sort( (a: any, b: any) => {
            if(sort === 'asc') {
              return a.name.localeCompare(b.name);
            } else {
              return b.name.localeCompare(a.name);
            }
          })
    ),
    
    selectIsFetchingUsersPending: (state) => state.fetchingUsersStatus === 'pending',
    
    selectIsFetchingUsersIdle: (state) => state.fetchingUsersStatus === 'idle',
  },
  reducers: {
    selected: (state, action: PayloadAction<{userId: UserId}>) => {
      state.selectedUserId = action.payload.userId;
    },
    
    selectRemove: (state) => {
      state.selectedUserId = undefined;
    },
    
    fetchUsersPending: (state) => {
      state.fetchingUsersStatus = 'pending';
    },
    
    fetchUsersSuccess: (state, action: PayloadAction<{users: User[]}>) => {
      const {users} = action.payload
      
      state.fetchingUsersStatus = 'success';
      state.entities = users.reduce((acc, user) => {
        acc[user.id] = user;
        return acc
      }, {} as Record<UserId, User>)
      state.ids = users.map((user) => user.id)
    },
    
    fetchUsersFailed: (state) => {
      state.fetchingUsersStatus = 'failed';
    },
  }
})