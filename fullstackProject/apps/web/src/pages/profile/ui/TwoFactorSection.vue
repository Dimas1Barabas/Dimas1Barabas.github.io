<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { ApiError, api } from '@/shared/api/client';
import { useAppStore } from '@/shared/api/app-mode';
import { demoEngine } from '@/shared/api/demo-engine';
import type {
  TrustedDevice,
  TwoFactorSetup,
  TwoFactorStatus,
} from '@/shared/api/types';
import QrCode from '@/shared/ui/QrCode.vue';

/**
 * Секция «Двухфакторная аутентификация» профиля: включение по QR
 * (otpauth-ссылку рисует общий QrCode), backup-коды один раз, выключение
 * кодом, доверенные устройства с отзывом. В демо движок зеркалит API и
 * подсказывает текущий код — телефона-то нет.
 */

const appStore = useAppStore();
const demo = computed(() => appStore.mode === 'demo');

type Stage = 'idle' | 'setup' | 'enabled-just';
const stage = ref<Stage>('idle');
const status = ref<TwoFactorStatus | null>(null);
const setupDto = ref<TwoFactorSetup | null>(null);
const code = ref('');
const backupCodes = ref<string[]>([]);
const devices = ref<TrustedDevice[]>([]);
const busy = ref(false);
const error = ref<string | null>(null);
/** демо-подсказка текущего кода (в live этого поля нет) */
const demoCode = ref<string | null>(null);

/** id текущего устройства из нечувствительной куки (сам токен httpOnly) */
const currentDeviceId = computed<string | null>(() => {
  if (typeof document === 'undefined') return null;
  const match = document.cookie
    .split('; ')
    .find((c) => c.startsWith('cine.device.id='));
  return match ? decodeURIComponent(match.split('=')[1]) : null;
});

function apiMessage(err: unknown): string | null {
  if (err instanceof ApiError) {
    try {
      const body = JSON.parse(err.body) as { message?: string };
      if (typeof body.message === 'string') return body.message;
    } catch {
      /* не JSON */
    }
  }
  return null;
}

async function refresh(): Promise<void> {
  try {
    status.value = demo.value
      ? demoEngine.twoFactorStatus()
      : await api.twoFactorStatus();
    demoCode.value =
      demo.value && 'demoCurrentCode' in (status.value ?? {})
        ? (status.value as { demoCurrentCode?: string }).demoCurrentCode ?? null
        : null;
    if (status.value.enabled) {
      devices.value = demo.value
        ? demoEngine.twoFactorDevices()
        : await api.twoFactorDevices();
    } else {
      devices.value = [];
    }
  } catch {
    // API недоступен/сессия умерла — секция не рисуется, профиль живёт
    status.value = null;
  }
}

onMounted(refresh);

async function startSetup(): Promise<void> {
  if (busy.value) return;
  busy.value = true;
  error.value = null;
  try {
    setupDto.value = demo.value ? demoEngine.twoFactorSetup() : await api.twoFactorSetup();
    stage.value = 'setup';
    code.value = '';
    demoCode.value = demo.value
      ? (((demoEngine.twoFactorStatus()) as { demoCurrentCode?: string })
          .demoCurrentCode ?? null)
      : null;
  } catch (err) {
    error.value = apiMessage(err) ?? 'Не удалось начать настройку';
  } finally {
    busy.value = false;
  }
}

async function enable(): Promise<void> {
  if (busy.value || !code.value.trim()) return;
  busy.value = true;
  error.value = null;
  try {
    const res = demo.value
      ? demoEngine.twoFactorEnable(code.value)
      : await api.twoFactorEnable(code.value.trim());
    backupCodes.value = res.backupCodes;
    setupDto.value = null;
    code.value = '';
    stage.value = 'enabled-just';
    await refresh();
  } catch (err) {
    error.value = apiMessage(err) ?? 'Код не подошёл';
  } finally {
    busy.value = false;
  }
}

async function disable(): Promise<void> {
  if (busy.value || !code.value.trim()) return;
  busy.value = true;
  error.value = null;
  try {
    if (demo.value) demoEngine.twoFactorDisable(code.value);
    else await api.twoFactorDisable(code.value.trim());
    code.value = '';
    backupCodes.value = [];
    stage.value = 'idle';
    await refresh();
  } catch (err) {
    error.value = apiMessage(err) ?? 'Код не подошёл';
  } finally {
    busy.value = false;
  }
}

async function revoke(deviceId: string): Promise<void> {
  if (busy.value) return;
  busy.value = true;
  error.value = null;
  try {
    if (demo.value) demoEngine.revokeTwoFactorDevice(deviceId);
    else await api.revokeTwoFactorDevice(deviceId);
    await refresh();
  } catch (err) {
    error.value = apiMessage(err) ?? 'Не получилось отозвать';
  } finally {
    busy.value = false;
  }
}

async function copyCodes(): Promise<void> {
  try {
    await navigator.clipboard.writeText(backupCodes.value.join('\n'));
  } catch {
    /* приватный режим/фокус — коды видны на экране */
  }
}

const fmtDate = (iso: string): string =>
  new Date(iso).toLocaleString('ru-RU', { dateStyle: 'medium', timeStyle: 'short' });
</script>

<template>
  <section v-if="status" class="twofactor">
    <h2 class="profile-subtitle">Двухфакторная аутентификация</h2>

    <!-- выключена: предложить включить -->
    <template v-if="!status.enabled && stage !== 'setup'">
      <p class="auth-note">
        Код из приложения-аутентификатора при входе: пароль недостаточен,
        даже если его узнали. Backup-коды — на случай утери телефона.
      </p>
      <button class="btn" type="button" :disabled="busy" @click="startSetup">
        Включить 2FA
      </button>
    </template>

    <!-- настройка: QR + секрет + код подтверждения -->
    <template v-else-if="stage === 'setup' && setupDto">
      <p class="auth-note">
        Отсканируйте QR приложением-аутентификатором (Google Authenticator,
        Aegis, 1Password) и введите текущий код — так вы докажете, что
        приложение работает.
      </p>
      <div class="twofactor-qr">
        <QrCode :value="setupDto.otpauthUri" :pixels="200" />
      </div>
      <p class="auth-note">
        Не сканируется? Введите секрет вручную:
        <code class="twofactor-secret">{{ setupDto.secret }}</code>
      </p>
      <p v-if="demoCode" class="auth-note">
        Демо без телефона: текущий код — <code>{{ demoCode }}</code>
      </p>
      <label class="field">
        <span class="field__label">Код из приложения</span>
        <input
          v-model="code"
          class="field__input"
          type="text"
          inputmode="numeric"
          autocomplete="one-time-code"
          minlength="6"
          maxlength="6"
          placeholder="123456"
        />
      </label>
      <button class="btn" type="button" :disabled="busy" @click="enable">
        {{ busy ? 'Проверяем…' : 'Подтвердить и включить' }}
      </button>
    </template>

    <!-- включена -->
    <template v-else>
      <p class="auth-note twofactor-on">
        Включена: вход спрашивает код из приложения.
        <template v-if="status.pending">Есть незавершённая настройка — начните заново.</template>
      </p>

      <!-- backup-коды показаны один раз -->
      <div v-if="stage === 'enabled-just'" class="twofactor-backup">
        <p class="auth-note">
          Backup-коды показываются <strong>один раз</strong> — сохраните:
          каждый работает один раз вместо кода приложения.
        </p>
        <ul class="twofactor-codes">
          <li v-for="c in backupCodes" :key="c"><code>{{ c }}</code></li>
        </ul>
        <button class="btn btn-ghost" type="button" @click="copyCodes">
          Скопировать все
        </button>
      </div>

      <div class="twofactor-devices">
        <h3 class="twofactor-sub">Доверенные устройства</h3>
        <p v-if="!devices.length" class="auth-note">
          Пока нет: галочка «доверять» на входе с кодом добавляет браузер
          на 30 дней.
        </p>
        <ul v-else class="twofactor-device-list">
          <li v-for="d in devices" :key="d.id">
            <div class="twofactor-device">
              <span class="twofactor-device-name">
                {{ d.name }}
                <em v-if="d.id === currentDeviceId" class="twofactor-current">
                  это устройство
                </em>
              </span>
              <span class="auth-note">вход без кода: {{ fmtDate(d.lastUsedAt) }}</span>
            </div>
            <button
              class="link"
              type="button"
              :disabled="busy"
              @click="revoke(d.id)"
            >
              Отозвать
            </button>
          </li>
        </ul>
      </div>

      <label class="field">
        <span class="field__label">Код приложения — выключить 2FA</span>
        <input
          v-model="code"
          class="field__input"
          type="text"
          inputmode="numeric"
          autocomplete="one-time-code"
          minlength="6"
          maxlength="14"
          placeholder="код или backup"
        />
      </label>
      <button class="btn btn-danger" type="button" :disabled="busy" @click="disable">
        {{ busy ? 'Проверяем…' : 'Выключить' }}
      </button>
    </template>

    <p v-if="error" class="auth-error">{{ error }}</p>
  </section>
</template>

<style scoped>
.twofactor {
  display: grid;
  gap: 14px;
  margin-top: 28px;
}

.twofactor-qr {
  display: flex;
  justify-content: center;
  padding: 12px;
  background: #fff;
  border-radius: 12px;
  width: fit-content;
  margin: 0 auto;
}

.twofactor-secret {
  word-break: break-all;
}

.twofactor-on {
  color: var(--text-muted, #9aa4b2);
}

.twofactor-backup {
  display: grid;
  gap: 10px;
  padding: 12px;
  border: 1px dashed var(--border, #454b56);
  border-radius: 12px;
}

.twofactor-codes {
  list-style: none;
  margin: 0;
  padding: 0;
  display: grid;
  grid-template-columns: repeat(2, 1fr);
  gap: 6px 16px;
}

.twofactor-device-list {
  list-style: none;
  margin: 0;
  padding: 0;
  display: grid;
  gap: 10px;
}

.twofactor-device-list li {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 12px;
}

.twofactor-device {
  display: grid;
  gap: 2px;
}

.twofactor-device-name {
  font-weight: 600;
}

.twofactor-current {
  font-style: normal;
  font-weight: 400;
  color: var(--accent, #6ea8fe);
  margin-left: 6px;
}

.twofactor-sub {
  margin: 0;
  font-size: 1rem;
}

.link {
  background: none;
  border: none;
  color: #ff8080;
  text-decoration: underline;
  cursor: pointer;
  padding: 0;
  font: inherit;
}

.btn-ghost {
  background: none;
  border: 1px solid var(--border, #454b56);
  color: inherit;
  width: fit-content;
}

.btn-danger {
  border-color: #a33;
  color: #ff8080;
}
</style>
