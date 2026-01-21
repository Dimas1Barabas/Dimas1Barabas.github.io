import {Redirect, Route, Routes} from 'react-router-dom';
import {privateRoutes, publicRoutes, RouteName} from '../router';
import {useTypedSelector} from '../hooks/useTypedSelector.ts';

const AppRouter = () => {
  const {isAuth} = useTypedSelector(state => state.auth)
  
  return (
    auth
    ?
    <Routes >
      {privateRoutes.map(route =>
        <Route
          index
          key={route.path}
          path={route.path}
          element={route.component}
        />
      )}
      <Redirect to={RouteName.EVENT} />
    </Routes>
    :
    <Routes>
      {publicRoutes.map(route =>
        <Route
          key={route.path}
          path={route.path}
          element={route.component}
        />
      )}
      <Redirect to={RouteName.LOGIN} />
    </Routes>
  );
};

export default AppRouter;