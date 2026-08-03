// Standalone-режим: регистрируем Custom Element и добавляем его на страницу,
// чтобы разрабатывать виджет без Vue (pnpm dev в этой папке).
import FocusTimer from './FocusTimer.svelte'

if (!customElements.get('focus-timer')) {
  customElements.define('focus-timer', FocusTimer as unknown as CustomElementConstructor)
}

const el = document.createElement('focus-timer')
document.getElementById('app')?.appendChild(el)
