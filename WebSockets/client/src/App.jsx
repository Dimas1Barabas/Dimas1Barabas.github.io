import styles from './styles/app.module.scss'
import './styles/variables.scss';
import ToolBar from './components/ToolBar.jsx';
import SettingBar from './components/SettingBar.jsx';
import Canvas from './components/Canvas.jsx';
import {BrowserRouter, Switch, Route, Redirect} from 'react-router-dom'

function App() {
  return (
    <BrowserRouter>
      <div className={styles.app}>
        <Switch>
          <Route path='/:id'>
            <ToolBar/>
            <SettingBar/>
            <Canvas/>
          </Route>
          <Redirect to={`f${(+new Date).toString(16)}`}/>
        </Switch>
      </div>
    </BrowserRouter>
  )
}

export default App;



  


