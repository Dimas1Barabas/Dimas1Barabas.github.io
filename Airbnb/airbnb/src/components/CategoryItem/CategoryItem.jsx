import style from './style.module.scss';

const CategoryItem = ({title, img}) => {
  return (
    <div className={style.wrapper}>
      <div className={style.img}>
        <img src={img} alt=""/>
      </div>
      <div className={style.title}>
        {title}
      </div>
    </div>
  )
}

export default CategoryItem;