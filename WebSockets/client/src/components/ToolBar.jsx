import styles from '../styles/toolbar.module.scss';
import toolState from "../store/toolState";
import Brush from "../tools/Brush";
import canvasState from "../store/canvasState";
import Rect from "../tools/Rect";
import Line from "../tools/Line";
import Circle from "../tools/Circle";
import Eraser from "../tools/Eraser";



const ToolBar = () => {
  const changeColor = e => {
    toolState.setStrokeColor(e.target.value)
    toolState.setFillColor(e.target.value)
  }

  const download = () => {
    const dataUrl = canvasState.canvas.toDataURL()
    console.log(dataUrl)
    const a = document.createElement('a')
    a.href = dataUrl
    a.download = canvasState.sessionid + ".jpg"
    document.body.appendChild(a)
    a.click()
    document.body.removeChild(a)
  }
  
  return (
    <div className={styles.toolbar}>
      <button className={styles.brush} onClick={() => toolState.setTool(new Brush(canvasState.canvas, canvasState.socket, canvasState.sessionid))}/>
      <button className={styles.rect} onClick={() => toolState.setTool(new Rect(canvasState.canvas, canvasState.socket, canvasState.sessionid))}/>
      <button className={styles.circle} onClick={() => toolState.setTool(new Circle(canvasState.canvas))}/>
      <button className={styles.eraser} onClick={() => toolState.setTool(new Eraser(canvasState.canvas))}/>
      <button className={styles.line} onClick={() => toolState.setTool(new Line(canvasState.canvas))}/>
      <input onChange={e => changeColor(e)} style={{marginLeft:10}} type="color"/>
      <button className={styles.undo} onClick={() => canvasState.undo()}/>
      <button className={styles.redo} onClick={() => canvasState.redo()}/>
      <button className={styles.save} onClick={() => download()}/>
    </div>
  );
};

export default ToolBar;