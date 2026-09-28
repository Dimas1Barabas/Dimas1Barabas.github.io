// Package prom — вторая реализация порта domain.Metrics: каждый вызов
// делегируется обёрнутому адаптеру (JSON-витрина /stats продолжает
// работать как раньше) и зеркалится в счётчики Prometheus. Домен и
// use-case не меняются — composition root просто подкладывает обёртку.
package prom

import (
	"net/http"

	"github.com/prometheus/client_golang/prometheus"
	"github.com/prometheus/client_golang/prometheus/collectors"
	"github.com/prometheus/client_golang/prometheus/promhttp"

	"notification-service/internal/domain"
)

// Metrics реализует domain.Metrics поверх любого внутреннего адаптера.
type Metrics struct {
	inner    domain.Metrics
	registry *prometheus.Registry

	received prometheus.Counter
	sent     *prometheus.CounterVec // kind — тип письма
	failed   prometheus.Counter
	errors   prometheus.Counter
}

// New оборачивает inner и регистрирует собственный реестр (не глобальный
// prometheus.DefaultRegisterer — тесты получают чистые ряды).
func New(inner domain.Metrics) *Metrics {
	reg := prometheus.NewRegistry()
	m := &Metrics{
		inner:    inner,
		registry: reg,
		received: prometheus.NewCounter(prometheus.CounterOpts{
			Name: "cine_notification_received_total",
			Help: "Booking verdict events taken from the queue",
		}),
		sent: prometheus.NewCounterVec(prometheus.CounterOpts{
			Name: "cine_notification_sent_total",
			Help: "Client notifications delivered (by kind)",
		}, []string{"kind"}),
		failed: prometheus.NewCounter(prometheus.CounterOpts{
			Name: "cine_notification_delivery_failed_total",
			Help: "Delivery gateway failures",
		}),
		errors: prometheus.NewCounter(prometheus.CounterOpts{
			Name: "cine_notification_errors_total",
			Help: "Own service errors while handling an event",
		}),
	}
	reg.MustRegister(
		collectors.NewGoCollector(),
		collectors.NewProcessCollector(collectors.ProcessCollectorOpts{}),
		m.received, m.sent, m.failed, m.errors,
	)
	return m
}

// Handler отдаёт exposition-текст для mux.Handle("/metrics", ...).
func (m *Metrics) Handler() http.Handler {
	return promhttp.HandlerFor(m.registry, promhttp.HandlerOpts{})
}

func (m *Metrics) Received() {
	m.inner.Received()
	m.received.Inc()
}

func (m *Metrics) Sent(kind domain.Kind) {
	m.inner.Sent(kind)
	m.sent.WithLabelValues(string(kind)).Inc()
}

func (m *Metrics) Failed() {
	m.inner.Failed()
	m.failed.Inc()
}

func (m *Metrics) Errors() {
	m.inner.Errors()
	m.errors.Inc()
}

// Snapshot прозрачно проходит в обёрнутый адаптер — /stats не отличить.
func (m *Metrics) Snapshot() map[string]any {
	return m.inner.Snapshot()
}
