import {baseApi} from '../../shared/api.ts';
import type {User, UserId} from './users.slice.ts';
import {z} from 'zod';

const UserDtoShema = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string(),
})

export const usersApi = baseApi.injectEndpoints({
  endpoints: (create) => ({
    getUsers: create.query<User[], void>({
      query: () => '/users',
      providesTags: ['Users'],
      transformResponse: (res: unknown) => UserDtoShema.array().parse(res)
    }),
    getUser: create.query<User, UserId>({
      query: (UserId) => `/users/${UserId}`,
      providesTags: ['Users'],
      transformResponse: (res: unknown) => UserDtoShema.parse(res)
    }),
    deleteUser: create.mutation<void, UserId>({
      query: (UserId) => ({method: "DELETE", url: `/users/${UserId}`}),
    }),
  }),
  overrideExisting: true
})