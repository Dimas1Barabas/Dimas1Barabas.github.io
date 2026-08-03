// Точка входа для библиотечной сборки: импорт компонента и регистрация Custom Element.
// Этот файл становится саморегистрирующимся IIFE-бандлом focus-timer.js.
import FocusTimer from './FocusTimer.svelte'

if (typeof customElements !== 'undefined' && !customElements.get('focus-timer')) {
  customElements.define('focus-timer', FocusTimer as unknown as CustomElementConstructor)
}
