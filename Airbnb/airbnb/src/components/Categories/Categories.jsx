import FilterBtn from '../FilterBtn/FilterBtn.jsx';
import CategoryItem from '../CategoryItem/CategoryItem.jsx';
import categoriesData from './../../data/categories.json';
import './style.scss';

const Categories = () => {
  return (
    <div className="categories">
      <div className="container">
        <div className="categories__row">
          <div className="categories__list">
            {categoriesData.map((cat, index) => {
              return (
                <CategoryItem
                  title={cat.title}
                  img={cat.img}
                  key={index}
                />
              )
            })}
          </div>
          <div className="categories__filter">
            <FilterBtn />
          </div>
        </div>
      </div>
    </div>
  )
}

export default Categories;