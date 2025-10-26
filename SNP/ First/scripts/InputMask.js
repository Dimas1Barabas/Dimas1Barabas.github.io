const phoneNumber = '[data-js-input-mask-phone-number]';
const dateFrom = '[data-js-input-mask-date-from]';
const dateBefore = '[data-js-input-mask-date-before]';


class InputMask {
  constructor(rootElement) {
    this.rootElement = rootElement
    this.init()
  }
  
  init()  {
    const isLibReady = typeof window.IMask !== 'undefined';
    
    if (isLibReady) {
      let minDate = new Date();
      minDate.setHours(0,0,0,0);
      
      
      if (this.rootElement.dataset.jsInputMaskPhoneNumber) {
          window.IMask(this.rootElement, {
          mask: this.rootElement.dataset.jsInputMaskPhoneNumber
        })
      } else if (this.rootElement.dataset.jsInputMaskDateFrom) {
        window.IMask(this.rootElement, {
          mask: Date,
          pattern: 'd{.}`m{.}`Y',
          blocks: {
            d: {
              mask: IMask.MaskedRange,
              from: 1,
              to: 31,
              maxLength: 2,
            },
            m: {
              mask: IMask.MaskedRange,
              from: 1,
              to: 12,
              maxLength: 2,
            },
            Y: {
              mask: IMask.MaskedRange,
              from: minDate.getFullYear(),
              to: 2100,
            }
          },
          format: function (date) {
            let day = date.getDate();
            let month = date.getMonth() + 1;
            let year = date.getFullYear();
            
            if (day < 10) day = "0" + day;
            if (month < 10) month = "0" + month;
            
            return [day, month, year].join(".");
          },
          parse: function (str) {
            let yearMonthDay = str.split(".");
            return new Date(yearMonthDay[2], yearMonthDay[1] - 1, yearMonthDay[0]);
          },
          min: minDate,
          autofix: true,
          overwrite: true 
        })
      } else if (this.rootElement.dataset.jsInputMaskDateBefore) {
        window.IMask(this.rootElement, {
          mask: Date,
          pattern: 'd{.}`m{.}`Y',
          blocks: {
            d: {
              mask: IMask.MaskedRange,
              from: 1,
              to: 31,
              maxLength: 2,
            },
            m: {
              mask: IMask.MaskedRange,
              from: 1,
              to: 12,
              maxLength: 2,
            },
            Y: {
              mask: IMask.MaskedRange,
              from: minDate.getFullYear(),
              to: 2100,
            }
          },
          format: function (date) {
            let day = date.getDate();
            let month = date.getMonth() + 1;
            let year = date.getFullYear();
            
            if (day < 10) day = "0" + day;
            if (month < 10) month = "0" + month;
            
            return [day, month, year].join(".");
          },
          parse: function (str) {
            let yearMonthDay = str.split(".");
            return new Date(yearMonthDay[2], yearMonthDay[1] - 1, yearMonthDay[0]);
          },
          min: minDate,
          autofix: true,
          overwrite: true
        })
      }
    } else {
      console.error('Библиотека "IMask" не подключена.')
    }
  }
}

class InputMaskCollection {
  constructor() {
    this.init()
  }
  
  init() {
    document.querySelectorAll(phoneNumber).forEach((element) => {
      new InputMask(element)
    })
    document.querySelectorAll(dateFrom).forEach((element) => {
      new InputMask(element)
    })
    document.querySelectorAll(dateBefore).forEach((element) => {
      new InputMask(element)
    })
  }
}

export default InputMaskCollection