<svelte:options customElement="focus-timer" />

<script lang="ts">
  import { createEventDispatcher, onMount } from 'svelte'

  // --- «Пропсы» кастомного элемента (атрибуты focus / break в минутах) ---
  interface Props {
    focus?: number
    brk?: number
  }
  let { focus = 25, brk = 5 }: Props = $props()

  type Mode = 'focus' | 'break'

  // --- Состояние ---
  let mode = $state<Mode>('focus')
  let remaining = $state(0)
  let running = $state(false)
  let sessions = $state(0)
  let timer: ReturnType<typeof setInterval> | null = null

  // --- Производные значения (как computed во Vue) ---
  const modeSeconds = $derived((mode === 'focus' ? focus : brk) * 60)
  const minutes = $derived(Math.floor(remaining / 60))
  const seconds = $derived(remaining % 60)
  const display = $derived(`${pad(minutes)}:${pad(seconds)}`)
  const progress = $derived(modeSeconds === 0 ? 0 : 1 - remaining / modeSeconds)

  // Геометрия кольца прогресса.
  const R = 54
  const CIRC = 2 * Math.PI * R

  const dispatch = createEventDispatcher<{
    complete: { sessions: number; mode: Mode }
  }>()

  function pad(n: number): string {
    return String(n).padStart(2, '0')
  }

  function applyMode(next: Mode): void {
    mode = next
    remaining = (next === 'focus' ? focus : brk) * 60
  }

  function tick(): void {
    if (remaining <= 1) {
      remaining = 0
      stop()
      if (mode === 'focus') {
        sessions += 1
        // Сообщаем наружу (в Vue) о завершённой фокус-сессии.
        dispatch('complete', { sessions, mode: 'focus' })
        applyMode('break')
      } else {
        applyMode('focus')
      }
    } else {
      remaining -= 1
    }
  }

  function start(): void {
    if (running) return
    running = true
    timer = setInterval(tick, 1000)
  }

  function stop(): void {
    running = false
    if (timer) {
      clearInterval(timer)
      timer = null
    }
  }

  function toggle(): void {
    running ? stop() : start()
  }

  function reset(): void {
    stop()
    sessions = 0
    applyMode('focus')
  }

  // Инициализируем таймер фокус-режимом и очищаем интервал при размонтировании.
  onMount(() => {
    applyMode('focus')
    return stop
  })
</script>

<div class="ft" class:ft--break={mode === 'break'}>
  <span class="ft__mode">{mode === 'focus' ? 'Фокус' : 'Перерыв'}</span>

  <div class="ft__ring">
    <svg viewBox="0 0 120 120" aria-hidden="true">
      <circle class="ft__track" cx="60" cy="60" {R} />
      <circle
        class="ft__progress"
        cx="60"
        cy="60"
        {R}
        style="stroke-dasharray: {CIRC}; stroke-dashoffset: {CIRC * (1 - progress)}"
      />
    </svg>
    <div class="ft__time">{display}</div>
  </div>

  <div class="ft__sessions">🍅 Сессий завершено: {sessions}</div>

  <div class="ft__controls">
    <button class="ft__btn ft__btn--primary" onclick={toggle}>
      {running ? 'Пауза' : 'Старт'}
    </button>
    <button class="ft__btn" onclick={reset}>Сброс</button>
  </div>
</div>

<style>
  /* Стили инлайнятся в Shadow DOM кастомного элемента.
     CSS-переменные (var(--…)) наследуются из <html data-theme> Vue-приложения —
     поэтому виджет автоматически подхватывает тёмную тему. */
  .ft {
    --accent: var(--primary, #4f46e5);
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 0.75rem;
    padding: 1.5rem 1rem;
    color: var(--text, #1a1d23);
    font-family: inherit;
  }
  .ft--break {
    --accent: var(--success, #16a34a);
  }

  .ft__mode {
    font-size: 0.85rem;
    font-weight: 700;
    text-transform: uppercase;
    letter-spacing: 0.08em;
    color: var(--accent);
  }

  .ft__ring {
    position: relative;
    width: 180px;
    height: 180px;
  }
  .ft__ring svg {
    width: 100%;
    height: 100%;
    transform: rotate(-90deg);
  }
  .ft__track {
    fill: none;
    stroke: var(--border, #e2e5ea);
    stroke-width: 10;
  }
  .ft__progress {
    fill: none;
    stroke: var(--accent);
    stroke-width: 10;
    stroke-linecap: round;
    transition: stroke-dashoffset 0.3s linear;
  }
  .ft__time {
    position: absolute;
    inset: 0;
    display: grid;
    place-items: center;
    font-size: 2.4rem;
    font-weight: 800;
    font-variant-numeric: tabular-nums;
  }

  .ft__sessions {
    font-size: 0.88rem;
    color: var(--text-muted, #6b7280);
  }

  .ft__controls {
    display: flex;
    gap: 0.6rem;
  }
  .ft__btn {
    padding: 0.55rem 1.2rem;
    border: 1px solid var(--border, #e2e5ea);
    border-radius: 10px;
    background: var(--surface-2, #f0f1f4);
    color: var(--text, #1a1d23);
    font-weight: 600;
    font-size: 0.92rem;
    cursor: pointer;
    transition: background 0.15s ease, transform 0.05s ease;
  }
  .ft__btn:active {
    transform: translateY(1px);
  }
  .ft__btn--primary {
    background: var(--accent);
    border-color: var(--accent);
    color: #fff;
  }
</style>
