import {fetchUsers} from './model/fetch-users.ts';
import {createSlice, type ExtraArgument} from '../../shared/redux.ts';
import type {PayloadAction} from '@reduxjs/toolkit';

export type UserId = string;

export type User = {
  id: UserId;
  name: string;
  description: string;
}

type UserState = {
  entities: Record<UserId, User | undefined>;
  ids: UserId[];
  fetchingUsersStatus: 'idle' | "pending" | "success" | "failed";
  fetchUserStatus: 'idle' | "pending" | "success" | "failed";
  deleteUserStatus: 'idle' | "pending" | "success" | "failed";
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
  fetchingUsersStatus: 'idle',
  fetchUserStatus: 'idle',
  deleteUserStatus: 'idle',
}

export const usersSlice = createSlice({
  name: "users",
  initialState: initialUsersState,
  selectors: {
    selectUserById: () => (state: any, userid: UserId) => state.entities[userid],
    
    selectSortedUsers: createSelector(
      (state: UserState) => state.ids,
      (state: UserState) => state.entities,
      (_: UserState, sort: 'asc' | 'desc') => sort,
      (ids, entities, sort) =>
        ids
          .map(id => entities[id])
          .filter((user): user is User => !!user)
          .sort( (a, b) => {
            if(sort === 'asc') {
              return a.name.localeCompare(b.name);
            } else {
              return b.name.localeCompare(a.name);
            }
          })
    ),
    
    selectIsFetchingUsersPending: (state) => state.fetchingUsersStatus === 'pending',
    
    selectIsFetchingUsersIdle: (state) => state.fetchingUsersStatus === 'idle',
    
    selectIsFetchUserPending: (state) => state.fetchUserStatus === 'pending',
    
    selectIsDeleteUserPending: (state) => state.fetchUserStatus === 'pending',
  },
  reducers: (creator) => {{
  
    fetchUsers: creator.asyncThunk<User, {userId: UserId}, {extra: ExtraArgument}>(
      (params, thunkAPI) => {
        return thunkAPI.extra.api.getUser(params.userId)
      }, {
        pending: (state) => {
          state.fetchUserStatus = 'pending';
        },
        fulfilled: (state, action) => {
          const user = action.payload
          
          state.fetchUserStatus = 'success';
          state.entities[user.id] = user
        },
        rejected: (state) => {
          state.fetchUserStatus = 'failed';
        },
      }
    )
/*


fetchUserPending: (state) => {
state.fetchUserStatus = 'pending';
},

fetchUserSuccess: (state, action: PayloadAction<{user: User}>) => {
const { user } = action.payload;

state.fetchUserStatus = 'success';
state.entities[user.id] = user;
},

fetchUserFailed: (state) => {
state.fetchUserStatus = 'failed';
},

deleteUserPending: (state) => {
state.fetchUserStatus = 'pending';
},

deleteUserSuccess: (state, action: PayloadAction<{ userId: UserId }>) => {
state.fetchUserStatus = 'success';

delete state.entities[action.payload.userId];
state.ids = state.ids.filter(id => id !== action.payload.userId);
},

deleteUserFailed: (state) => {
state.fetchUserStatus = 'failed';
}
*/
}},
extraReducers: builder => {
builder.addCase(fetchUsers.pending, (state) => {
state.fetchUserStatus = 'pending';
}),
builder.addCase(fetchUsers.fulfilled, (state, action) => {
state.fetchUserStatus = 'success';
const users = action.payload

state.entities = users.reduce((acc, user) => {
  acc[user.id] = user
  return acc
}, {} as Record<UserId, User>);
state.ids = users.map((user) => user.id)
}),
builder.addCase(fetchUsers.rejected, (state, action) => {})
}
})