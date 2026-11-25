<script setup lang="ts">
import { computed, onMounted } from 'vue';
import { useLoyaltyStore } from '@/entities/loyalty/model/store';

/**
 * Секция «Уровень «Киноман»» профиля (этап 38): текущая ступень по
 * пожизненным тратам, перки прямо сейчас и прогресс до следующей.
 * Только витрина: начисления — вердиктным циклом, скидка — в кинобаре.
 */

const loyalty = useLoyaltyStore();

const status = computed(() => loyalty.status);

/** перки списком: нулевые не показываем — честно, но без шума */
const perks = computed(() => {
  const s = status.value;
  if (!s) return [];
  const list: string[] = [
    `кэшбэк ${s.perks.cashbackPercent}% с каждой оплаты`,
  ];
  if (s.perks.barDiscountPercent > 0) {
    list.push(`скидка ${s.perks.barDiscountPercent}% на заказ кинобара`);
  }
  if (s.perks.demandMarkupWaived) {
    list.push('цена без надбавок за аншлаг');
  }
  return list;
});

onMounted(() => void loyalty.refresh());
</script>

<template>
  <section v-if="status" class="loyalty" data-testid="loyalty-section">
    <h2 class="profile-subtitle">Уровень «Киноман»</h2>

    <div class="loyalty-card">
      <div class="loyalty-head">
        <span class="loyalty-tier" :data-tier="status.code" data-testid="loyalty-tier">
          {{ status.name }}
        </span>
        <span class="loyalty-spent" data-testid="loyalty-spent">
          {{ status.lifetimeSpentRub.toLocaleString('ru-RU') }} ₽ потрачено
        </span>
      </div>

      <ul class="loyalty-perks">
        <li v-for="perk in perks" :key="perk">{{ perk }}</li>
      </ul>
      <p v-if="perks.length === 1" class="loyalty-hint">
        С уровня «Зритель» добавятся скидка кинобара и прибавка кэшбэка.
      </p>

      <div v-if="status.next" class="loyalty-progress">
        <div class="loyalty-bar">
          <div
            class="loyalty-bar__fill"
            :style="{ width: `${status.next.progressPercent}%` }"
            data-testid="loyalty-progress"
          ></div>
        </div>
        <p class="loyalty-next" data-testid="loyalty-next">
          До «{{ status.next.name }}» осталось
          {{ status.next.toNextRub.toLocaleString('ru-RU') }} ₽
          ({{ status.next.progressPercent }}%)
        </p>
      </div>
      <p v-else class="loyalty-top" data-testid="loyalty-top">
        Вершина лестницы — выше только легенды экрана ✨
      </p>
    </div>
  </section>
</template>

<style scoped>
.loyalty-card {
  margin-top: 12px;
  padding: 16px;
  background: var(--bg-soft);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  display: grid;
  gap: 12px;
}

.loyalty-head {
  display: flex;
  justify-content: space-between;
  align-items: baseline;
  gap: 10px;
  flex-wrap: wrap;
}

.loyalty-tier {
  padding: 3px 12px;
  border-radius: 999px;
  font-weight: 600;
  font-size: 0.92rem;
  background: rgba(96, 165, 250, 0.14);
  color: #60a5fa;
}

/* ступени подкрашиваем по slug: рост — от прохладного к золоту */
.loyalty-tier[data-tier='viewer'] {
  background: rgba(74, 222, 128, 0.14);
  color: #4ade80;
}

.loyalty-tier[data-tier='cinephile'] {
  background: rgba(251, 191, 36, 0.16);
  color: #fbbf24;
}

.loyalty-tier[data-tier='legend'] {
  background: rgba(248, 113, 113, 0.16);
  color: #f87171;
}

.loyalty-spent {
  color: var(--muted);
  font-size: 0.88rem;
}

.loyalty-perks {
  margin: 0;
  padding-left: 18px;
  font-size: 0.9rem;
  display: grid;
  gap: 4px;
}

.loyalty-hint {
  margin: 0;
  color: var(--muted);
  font-size: 0.84rem;
}

.loyalty-progress {
  display: grid;
  gap: 6px;
}

.loyalty-bar {
  height: 8px;
  border-radius: 999px;
  background: var(--border);
  overflow: hidden;
}

.loyalty-bar__fill {
  height: 100%;
  border-radius: 999px;
  background: linear-gradient(90deg, #60a5fa, #4ade80);
  transition: width 0.3s ease;
}

.loyalty-next {
  margin: 0;
  color: var(--muted);
  font-size: 0.84rem;
}

.loyalty-top {
  margin: 0;
  color: #fbbf24;
  font-size: 0.88rem;
}
</style>
