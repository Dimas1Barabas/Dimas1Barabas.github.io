const display = document.querySelector('.display');
const buttons = document.querySelector('.buttons');

let currentNumber = '';
let previousNumber = '';
let operator = null;

function updateDisplay() {
    display.textContent = currentNumber || '0'; 
}

function clear() {
    currentNumber = '';
    previousNumber = '';
    operator = null;
    updateDisplay();
}

function calculate() {
    if (previousNumber === '' || currentNumber === '' || operator === null) {
        return; 
    }

    let result = 0;
    const prev = parseFloat(previousNumber);
    const curr = parseFloat(currentNumber);

    if (isNaN(prev) || isNaN(curr)) return; 

    switch (operator) {
        case '+':
            result = prev + curr;
            break;
        case '-':
            result = prev - curr;
            break;
        case '×':
            result = prev * curr;
            break;
        case '÷':
            if (curr === 0) {
                display.textContent = "Ошибка"; 
                return;
            }
            result = prev / curr;
            break;
        default:
            return;
    }

    currentNumber = result.toString();
    operator = null;
    previousNumber = '';
    updateDisplay();
}

buttons.addEventListener('click', (event) => {
    const target = event.target;

    if (!target.classList.contains('button')) {
        return; 
    }

    const value = target.textContent;

    if (target.classList.contains('clear')) {
        clear();
        return;
    }

    if (target.classList.contains('equal')) {
        calculate();
        return;
    }

    if (target.classList.contains('operator')) {
        if (currentNumber === '') return; 

        if (previousNumber !== '') {
            calculate();
        }

        operator = value;
        previousNumber = currentNumber;
        currentNumber = '';
        updateDisplay();
        return;
    }


    if (value === '.') {
        if (currentNumber.includes('.')) return;
    }

    currentNumber += value;
    updateDisplay();
});

updateDisplay();
