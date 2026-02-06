import styles from '../styles/settingsbar.module.scss';
import '../styles/variables.scss';
import toolState from "../store/toolState";

const SettingBar = () => {
  return (
    <div className={styles.setbar}>
      <label htmlFor="line-width">
        Толщина линии
      </label>
      <input
        onChange={e => toolState.setLineWidth(e.target.value)}
        style={{margin: '0 10px'}}
        id="line-width"
        type="number"
        defaultValue={1} min={1} max={50}
      />
      
      <label htmlFor="stroke-color">
        Цвет обводки
      </label>
      <input
        onChange={e => toolState.setStrokeColor(e.target.value)}
        id="stroke-color"
        type="color"
      />
    </div>
  );
};

export default SettingBar;