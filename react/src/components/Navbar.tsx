import type {FC} from 'react';
import {Layout, Menu, Row} from 'antd';
import {useTypedSelector} from '../hooks/useTypedSelector.ts';

const Navbar: FC = () => {
  const {isAuth} = useTypedSelector(state => state.auth)
  
  
  return (
    <Layout.Header>
      <Row justify='end' >
        <Menu theme='dark' mode='horizontal' >
          <Menu.Item>Логин</Menu.Item>
        </Menu>
      </Row>
    </Layout.Header>
  );
};

export default Navbar;