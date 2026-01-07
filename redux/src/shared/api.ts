import {z} from 'zod';

const baseUrl = "http://localhost:3000";

const UserDtoShema = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string(),
})

export const api = {
  getUsers: () => {
    return fetch(`${baseUrl}/users`)
      .then(res => res.json())
      .then(res => {
        return UserDtoShema.array().parse(res)
      })
  },
  
  getUser: (userId: string) => {
    return fetch(`${baseUrl}/users/${userId}`)
      .then(res => res.json())
      .then(res => {
        return UserDtoShema.parse(res)
      })
  },
  deleteUser: (userId: string) => {
    return fetch(`${baseUrl}/users/${userId}`, {
      method: "DELETE",
    }).then(res => res.json());
  }
}