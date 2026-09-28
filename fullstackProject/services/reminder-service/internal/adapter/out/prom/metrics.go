// Package prom — счётчики сервиса напоминаний для Prometheus. Метрики
// ведут адаптеры на границах: gRPC Schedule/Cancel и издатель «писем»
// в брокер (тикающий планировщик — фон, его результат виден именно
// в публикациях). Сквозная забота — в домен не проваливается.
package prom

import (
	"net/http"
	"strings"

	"github.com/prometheus/client_golang/prometheus"
	"github.com/prometheus/client_golang/prometheus/collectors"
	"github.com/prometheus/client_golang/prometheus/promhttp"
)

type Metrics struct {
	registry *prometheus.Registry

	scheduled *prometheus.CounterVec // result=ok|error
	cancels   *prometheus.CounterVec  // status=cancelled|missing
	fired     prometheus.Counter      // письма ушли в брокер
	failed    prometheus.Counter      // публикация не удалась (ждёт тик)
}

// New собирает реестр: собственный (не глобальный) — чистые ряды в тестах.
func New() *Metrics {
	reg := prometheus.NewRegistry()
	m := &Metrics{
		registry: reg,
		scheduled: prometheus.NewCounterVec(prometheus.CounterOpts{
			Name: "cine_reminder_scheduled_total",
			Help: "Reminders planned by booking confirmations",
		}, []string{"result"}),
		cancels: prometheus.NewCounterVec(prometheus.CounterOpts{
			Name: "cine_reminder_cancels_total",
			Help: "Cancellations by outcome (MISSING is an idempotent no-op)",
		}, []string{"status"}),
		fired: prometheus.NewCounter(prometheus.CounterOpts{
			Name: "cine_reminder_fired_total",
			Help: "Reminder letters published to the broker",
		}),
		failed: prometheus.NewCounter(prometheus.CounterOpts{
			Name: "cine_reminder_publish_failed_total",
			Help: "Failed publications (record stays SCHEDULED until next tick)",
		}),
	}
	reg.MustRegister(
		collectors.NewGoCollector(),
		collectors.NewProcessCollector(collectors.ProcessCollectorOpts{}),
		m.scheduled, m.cancels, m.fired, m.failed,
	)
	return m
}

// Handler отдаёт exposition-текст для mux.Handle("/metrics", ...).
func (m *Metrics) Handler() http.Handler {
	return promhttp.HandlerFor(m.registry, promhttp.HandlerOpts{})
}

// ScheduledOk — напоминание запланировано (SCHEDULED).
func (m *Metrics) ScheduledOk() {
	m.scheduled.WithLabelValues("ok").Inc()
}

// ScheduledError — хранилище напоминаний ответило сбоем (RPC Internal).
func (m *Metrics) ScheduledError() {
	m.scheduled.WithLabelValues("error").Inc()
}

// Cancelled — вердикт Cancel: гашение или идемпотентный MISSING.
func (m *Metrics) Cancelled(status string) {
	m.cancels.WithLabelValues(strings.ToLower(status)).Inc()
}

// Fired — письмо ушло в обмен cinema.
func (m *Metrics) Fired() {
	m.fired.Inc()
}

// PublishFailed — публикация не удалась, запись ждёт следующего тика.
func (m *Metrics) PublishFailed() {
	m.failed.Inc()
}
