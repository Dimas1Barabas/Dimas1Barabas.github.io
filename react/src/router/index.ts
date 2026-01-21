import Login from '../pages/Login.tsx';
import Event from '../pages/Event.tsx';

export interface IRoute {
  path: string;
  component: React.ComponentType;
  exact?: boolean;
}

export const RouteName = {
  LOGIN: '/login',
  EVENT: '/',
} as const;

export const publicRoutes: IRoute[] = [
  {
    path: RouteName.LOGIN,
    component: Login,
    exact: true,
  },
]

export const privateRoutes: IRoute[] = [
  {
    path: RouteName.EVENT,
    component: Event,
    exact: true,
  },
]