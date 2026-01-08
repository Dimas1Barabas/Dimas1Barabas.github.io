import {createBrowserRouter, Link, Outlet, redirect} from 'react-router-dom';
import {UserList} from './modules/users/UserList.tsx';
import {Counter} from './modules/counters/counters.tsx';
import {UserInfo} from './modules/users/user-info.tsx';

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
      },
      {
        path: 'users/:id',
        element: (
          <UserInfo />
        ),
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