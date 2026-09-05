<script setup lang="ts">
import { useAppStore } from '../stores/app';

const appStore = useAppStore();

const services = [
  { name: 'web', stack: 'Vue 3 · Vite · Pinia', url: 'http://localhost:18080', note: 'SPA, раздаётся nginx' },
  { name: 'api', stack: 'NestJS 11 · TypeORM', url: 'http://localhost:13000/api', note: 'REST: фильмы, брони, health' },
  { name: 'postgres', stack: 'PostgreSQL 16', url: 'localhost:15432', note: 'фильмы и брони' },
  { name: 'redis', stack: 'Redis 7', url: 'localhost:6379', note: 'кэш списка фильмов (TTL 60 c)' },
  { name: 'rabbitmq', stack: 'RabbitMQ 3.13', url: 'localhost:15672', note: 'обмен cinema (topic)' },
  { name: 'worker', stack: 'Go 1.24 · amqp091', url: 'http://localhost:8081', note: 'оплата и возвраты' },
];

const flow = [
  { step: '1', title: 'GET /api/movies', text: 'Vue запрашивает сеансы. NestJS сначала смотрит Redis: при попадании список не ходит в Postgres — ответ помечен «из кэша».' },
  { step: '2', title: 'POST /api/bookings', text: 'Бронь сохраняется в PostgreSQL со статусом PENDING и сразу возвращается клиенту.' },
  { step: '3', title: 'publish booking.created', text: 'API публикует событие в topic-обмен cinema (routing key booking.created) — ответственный сервис подхватит его асинхронно.' },
  { step: '4', title: 'Go-воркер', text: 'ticket-worker консьюмит очередь worker.booking.created, «проводит оплату» (1,2–2,8 с, ~90% успеха) и публикует booking.processed.' },
  { step: '5', title: 'consume booking.processed', text: 'NestJS слушает очередь api.booking.processed и обновляет статус брони в Postgres: CONFIRMED или FAILED + сообщение от воркера.' },
  { step: '6', title: 'SSE /api/bookings/stream', text: 'Фронт держит постоянное соединение (EventSource): каждое изменение брони прилетает событием «booking» с бронью и статистикой — без опроса. При обрыве браузер переподключается и делает полный resync.' },
  { step: '7', title: 'POST /api/bookings/:id/cancel', text: 'Компенсирующая сага: подтверждённую бронь можно отменить. Условный UPDATE переводит её в CANCELLING (двойной клик получает 409), API публикует booking.cancelled.' },
  { step: '8', title: 'booking.refunded', text: 'Go-воркер «возвращает платёж» (0,8–1,6 с, ~90% успеха). Успех → CANCELLED и места снова в продаже; отказ → бронь откатывается в CONFIRMED.' },
];
</script>

<template>
  <section class="arch">
    <div class="page-head">
      <div>
        <h1 class="page-title">Архитектура</h1>
        <p class="page-sub">
          Монорепо fullstackProject: NestJS + Vue + PostgreSQL + Redis +
          RabbitMQ + Go
        </p>
      </div>
      <span
        class="chip"
        :class="appStore.mode === 'live' ? 'chip--cache' : 'chip--db'"
      >
        {{ appStore.mode === 'live' ? '● подключён к API' : '● демо-режим' }}
      </span>
    </div>

    <div class="arch__diagram">
      <div class="node node--client">
        <span class="node__icon">🖥️</span>
        <strong>Vue SPA</strong>
        <small>GitHub Pages / nginx</small>
      </div>
      <div class="arrow">REST ↓↑</div>
      <div class="node node--api">
        <span class="node__icon">🦁</span>
        <strong>NestJS API</strong>
        <small>TypeORM · ioredis · amqp</small>
      </div>
      <div class="arch__stores">
        <div class="node node--pg">
          <span class="node__icon">🐘</span>
          <strong>PostgreSQL</strong>
          <small>movies · bookings</small>
        </div>
        <div class="node node--redis">
          <span class="node__icon">⚡</span>
          <strong>Redis</strong>
          <small>кэш, TTL 60 c</small>
        </div>
        <div class="node node--mq">
          <span class="node__icon">📮</span>
          <strong>RabbitMQ</strong>
          <small>topic-обмен cinema</small>
        </div>
      </div>
      <div class="arrow arrow--mq">
        booking.created ↓ · booking.processed ↑<br />
        booking.cancelled ↓ · booking.refunded ↑
      </div>
      <div class="node node--go">
        <span class="node__icon">🐹</span>
        <strong>Go ticket-worker</strong>
        <small>консьюмер + /stats</small>
      </div>
    </div>

    <h2 class="arch__title">Путь брони</h2>
    <ol class="flow">
      <li v-for="item in flow" :key="item.step" class="flow__item">
        <span class="flow__step">{{ item.step }}</span>
        <div>
          <code class="flow__code">{{ item.title }}</code>
          <p class="flow__text">{{ item.text }}</p>
        </div>
      </li>
    </ol>

    <h2 class="arch__title">Сервисы (docker compose)</h2>
    <div class="svc-table">
      <div
        v-for="svc in services"
        :key="svc.name"
        class="svc-row"
      >
        <code class="svc-row__name">{{ svc.name }}</code>
        <span class="svc-row__stack">{{ svc.stack }}</span>
        <code class="svc-row__url">{{ svc.url }}</code>
        <span class="svc-row__note">{{ svc.note }}</span>
      </div>
    </div>

    <div class="arch__run">
      <h2 class="arch__title">Поднять стенд локально</h2>
      <pre class="code">git clone https://github.com/Dimas1Barabas/Dimas1Barabas.github.io
cd Dimas1Barabas.github.io/fullstackProject
docker compose up --build

# web      → http://localhost:18080
# api      → http://localhost:13000/api/health
# rabbitmq → http://localhost:15672 (guest/guest)
# worker   → http://localhost:8081/stats</pre>
      <p class="arch__note">
        Пока бэкенд не поднят, эта страница работает в демо-режиме — поток
        бронирования симулируется в браузере с теми же таймингами, что у
        Go-воркера.
      </p>
    </div>
  </section>
</template>
