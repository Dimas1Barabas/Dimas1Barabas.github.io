import Logo from '../Logo/Logo.jsx';
import SearchBar from '../SearchBar/SearchBar.jsx';
import UserMenu from '../UserMenu/UserMenu.jsx';
import Categories from '../Categories/Categories.jsx';
import './style.scss';

function Header() {
  return (
    <div className="header-wrapper">
      <header className='header'>
        <div className="container">
          <div className="header__row">
            <div className="header__logo">
              <Logo />
            </div>
            <div className="header__search">
              <SearchBar />
            </div>
            <div className="header__user">
              <UserMenu />
            </div>
          </div>
        </div>
      </header>
      <Categories />
    </div>
  )
}

export default Header;