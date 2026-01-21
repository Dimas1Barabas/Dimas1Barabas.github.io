import './App.css'
import AppRouter from './components/AppRouter.tsx';
import Navbar from './components/Navbar.tsx';
import {Layout} from 'antd';

function App() {
  return (
    <Layout>
      <Navbar />
      <Layout.Content>
        <AppRouter />
      </Layout.Content>
    </Layout>
  )
}

export default App
