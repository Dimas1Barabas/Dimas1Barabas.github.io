import starIcon from './star.svg';
import styles from './style.module.scss';

const Card = ({data}) => {

  const {
    title,
    desc,
    rating,
    price_per_night,
    dates_available,
    img,
    img2x,
  } = data;
  
  return (
    <article className={styles.card}>
      <a href="#" className={styles.link}></a>
      <img
        src={img}
        srcSet={`${img2x} 2x`}
        alt={title}
        className={styles.img}
      />
      
      <div className={styles.descWrapper}>
        <div className={styles.titleWrapper}>
          <h3 className={styles.title}>{title}</h3>
          <div className={styles.rating}>
            <img src={starIcon} alt="star"/>
            {rating}
          </div>
        </div>
        
        <p className={styles.desc}>{desc}</p>
        <p className={styles.date}>{dates_available}</p>
        
        <p className={styles.price}><strong>${price_per_night}</strong>night</p>
      </div>
    </article>
  )
}

export default Card;