const header = '[data-js-header]';

class Header {
  constructor(header) {
    this.headerElement = header;
    this.init();
  }
  
  init() {
    window.addEventListener('scroll', () => {
      let scroll = window.scrollY > 450;
      if (scroll) {
        this.headerElement.classList.replace('absolute', 'fixed');
      } else {
        this.headerElement.classList.replace('fixed', 'absolute');
      }
    });
  }
}

class HeaderCollection {
  constructor() {
    this.init()
  }
  
  init() {
    document.querySelectorAll(header).forEach((element) => {
      new Header(element)
    })
  }
}

export default HeaderCollection;