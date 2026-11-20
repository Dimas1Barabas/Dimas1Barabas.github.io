import { defineStore } from 'pinia';
import { ref } from 'vue';
import { api, ApiError } from '@/shared/api/client';
import { demoEngine } from '@/shared/api/demo-engine';
import { useAppStore } from '@/shared/api/app-mode';
import type { FraudDecision } from '@/shared/lib/fraud';

/**
 * Витрина решений антифрода «Детектива» (этап 36): очередь ревью и
 * решения человека. Live — админ-маршруты API (за JWT и ролью admin),
 * демо — движок Pages (открыт всем, как промокоды). Сбой витрины —
 * пустой список: это не критичный путь (fail-soft, как у аудита флагов).
 */
export const useFraudStore = defineStore('fraud', () => {
  /** решения свежими сверху; статус-фильтр последнего запроса — для бейджа */
  const decisions = ref<FraudDecision[]>([]);
  const pendingCount = ref(0);
  const loading = ref(false);
  const error = ref<string | null>(null);
  /** бронь последнего резолва — экрану пригодится её судьба */
  const lastResolved = ref<{
    bookingId: string;
    resolved: string;
    status: string;
  } | null>(null);

  async function refresh(status?: string): Promise<void> {
    const app = useAppStore();
    loading.value = true;
    error.value = null;
    try {
      if (app.mode === 'demo') {
        decisions.value = demoEngine.fraudDecisionsList(
          status as FraudDecision['status'] | undefined,
        );
      } else {
        const res = await api.adminFraud(status);
        decisions.value = res.decisions ?? [];
      }
      // счётчик живой очереди — всегда по всем решениям, не по фильтру
      pendingCount.value =
        app.mode === 'demo'
          ? demoEngine.fraudDecisionsList('pending_review').length
          : decisions.value.filter((d) => d.status === 'pending_review').length;
    } catch {
      // витрина лежит — показываем пустую очередь с пометкой
      decisions.value = [];
      pendingCount.value = 0;
      error.value = 'Витрина антифрода недоступна';
    } finally {
      loading.value = false;
    }
  }

  /**
   * Решение человека: approve — системная оплата брони, reject — отмена.
   * 409 уже-решено/конфликта показываем ошибкой, список тянем заново
   * (refresh гасит error — присваиваем после него).
   */
  async function resolve(
    bookingId: string,
    action: 'approve' | 'reject',
  ): Promise<void> {
    const app = useAppStore();
    error.value = null;
    let failure: string | null = null;
    try {
      if (app.mode === 'demo') {
        const res = demoEngine.resolveFraud(
          bookingId,
          action,
          'admin@demo.local',
        );
        lastResolved.value = {
          bookingId,
          resolved: res.resolved,
          status: res.booking.status,
        };
      } else {
        const res = await api.resolveFraud(bookingId, action);
        lastResolved.value = {
          bookingId,
          resolved: res.resolved,
          status: res.booking.status,
        };
      }
    } catch (err) {
      failure =
        err instanceof ApiError
          ? 'Решение не прошло — возможно, уже принято или бронь закрыта'
          : 'Детектив недоступен';
    }
    await refresh();
    error.value = failure;
  }

  return { decisions, pendingCount, loading, error, lastResolved, refresh, resolve };
});
