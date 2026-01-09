import {createBrowserRouter, Link, Outlet, redirect} from 'react-router-dom';
import {UserList} from '../modules/users/UserList.tsx';
import {Counter} from '../modules/counters/counters.tsx';
import {UserInfo} from '../modules/users/user-info.tsx';
import {store} from './store.ts';
import {fetchUsers} from '../modules/users/model/fetch-users.ts';
import {fetchUser} from '../modules/users/model/fetch-user.ts';

const loadStore = () => new Promise(resolve => {
  setTimeout(() => resolve(store), 0)
});

export const router = createBrowserRouter([
  {
    path: '/',
    element: (
      <div className="card">
        <header>
          <Link to="users" >Users</Link>
          <Link to="counters" >Counters</Link>
v        </header>
        <Outlet />
      </div>
    ),
    children: [
      {
        index: true,
        loader: () => redirect('/users')
      },
      {
        path: 'users',
        element: (
         <UserList />
        ),
        loader: () => {
          loadStore().then(() => {
            store.dispatch(fetchUsers())
          })
          return null
        }
      },
      {
        path: 'users/:id',
        element: (
          <UserInfo />
        ),
        loader: ({params}) => {
          loadStore().then(() => {
            store.dispatch(fetchUser(params.id ?? ""))
          })
          
          return null
        }
      },
      {
        path: 'counters',
        element: (
          <Counter counterId={"3"}></Counter>
        ),
      },
    ]
  },
])