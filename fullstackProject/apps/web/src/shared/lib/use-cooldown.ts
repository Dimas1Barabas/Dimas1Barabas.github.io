import { onUnmounted, ref } from 'vue';

/**
 * Кулдаун кнопки после 429 Привратника: retryAfterSec тикает вниз до нуля,
 * таймер гасится по нулю и при размонтировании компонента. Пока секунды
 * идут — повторная отправка не имеет смысла: корзина ещё не долита.
 */
export function useCooldown() {
  const cooldownSec = ref(0);
  let timer: ReturnType<typeof setInterval> | null = null;

  function stop(): void {
    if (timer) clearInterval(timer);
    timer = null;
  }

  /** запустить (или перезапустить) отсчёт с N секунд */
  function startCooldown(seconds: number): void {
    stop();
    cooldownSec.value = Math.max(1, Math.ceil(seconds));
    timer = setInterval(() => {
      cooldownSec.value -= 1;
      if (cooldownSec.value <= 0) {
        cooldownSec.value = 0;
        stop();
      }
    }, 1000);
  }

  onUnmounted(stop);

  return { cooldownSec, startCooldown };
}
