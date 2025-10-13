const header = '[data-js-header]';

class Header {
  constructor(header) {
    this.headerElement = header;
    this.init();
  }
  
  init() {
    window.addEventListener('scroll', () => {
      if (window.scrollY > 450 && !this.headerElement.classList.contains('fixed')) {
        this.headerElement.classList.add('fixed');
      } else if (window.scrollY < 450 && this.headerElement.classList.contains('fixed')) {
        this.headerElement.classList.remove('fixed');
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