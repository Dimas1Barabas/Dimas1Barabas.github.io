import {createBrowserRouter, Link, Outlet, redirect} from 'react-router-dom';
import {UserList} from '../modules/users/UserList.tsx';
import {Counter} from '../modules/counters/counters.tsx';
import {UserInfo} from '../modules/users/user-info.tsx';
import {store} from './store.ts';
import {usersApi} from '../modules/users/api.ts';

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
          loadStore().then(async () => {
            store.dispatch(usersApi.util.prefetch("getUsers", undefined, {}))
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
            store.dispatch(usersApi.util.prefetch('getUser', params.id ?? '', {}))
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