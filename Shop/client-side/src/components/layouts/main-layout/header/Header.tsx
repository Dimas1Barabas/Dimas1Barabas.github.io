import { HeaderMenu } from "./header-menu/HeaderMenu";
import Logo from "./logo/Logo";
import {SearchInput} from '@/components/layouts/main-layout/header/search-input/SearchInput';

export function Header() {
  return (
    <div>
      <Logo />
      <div>
        <SearchInput />
      </div>
      <HeaderMenu />
    </div>
  )
}