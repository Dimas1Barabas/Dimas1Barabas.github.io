import './style.scss';

const Link = ({text, style, icon}) => {
  return (
    <a
      href='#'
      className={`link ${style === "light" ? " link--light" : ""}`}
    >
      {icon && <img src={icon} alt=""/>}
      {text}
    </a>
  )
}

export default Link;