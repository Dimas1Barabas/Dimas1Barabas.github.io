// Package prom — счётчики Бармена для Prometheus. Как у соседей,
// метрики считает адаптер на границе: принятые заказы, кнопки экрана
// бара, отмены и сбои; в домен сквозная забота не проваливается.
package prom

import (
	"net/http"

	"github.com/prometheus/client_golang/prometheus"
	"github.com/prometheus/client_golang/prometheus/collectors"
	"github.com/prometheus/client_golang/prometheus/promhttp"
)

type Metrics struct {
	registry *prometheus.Registry

	accepted      *prometheus.CounterVec // принятые заказы по routing key
	buttons       *prometheus.CounterVec // нажатия кнопок экрана бара
	published     *prometheus.CounterVec // опубликованные статусы
	publishFailed prometheus.Counter     // сбои публикации статусов
	errors        prometheus.Counter     // сбои обработки событий (транзиентные, уйдут в retry)
}

// New собирает реестр: собственный (не глобальный) — чистые ряды в тестах.
func New() *Metrics {
	reg := prometheus.NewRegistry()
	m := &Metrics{
		registry: reg,
		accepted: prometheus.NewCounterVec(prometheus.CounterOpts{
			Name: "cine_barman_accepted_total",
			Help: "Orders accepted into the bar queue",
		}, []string{"routing_key"}),
		buttons: prometheus.NewCounterVec(prometheus.CounterOpts{
			Name: "cine_barman_buttons_total",
			Help: "Bar screen button presses (applied transitions)",
		}, []string{"action"}),
		published: prometheus.NewCounterVec(prometheus.CounterOpts{
			Name: "cine_barman_published_total",
			Help: "bar.order.status events published",
		}, []string{"status"}),
		publishFailed: prometheus.NewCounter(prometheus.CounterOpts{
			Name: "cine_barman_publish_failed_total",
			Help: "Failed status publications (retry by re-pressing the button)",
		}),
		errors: prometheus.NewCounter(prometheus.CounterOpts{
			Name: "cine_barman_errors_total",
			Help: "Transient processing failures (store down, event retried)",
		}),
	}
	reg.MustRegister(
		collectors.NewGoCollector(),
		collectors.NewProcessCollector(collectors.ProcessCollectorOpts{}),
		m.accepted, m.buttons, m.published, m.publishFailed, m.errors,
	)
	return m
}

// Handler отдаёт exposition-текст для mux.Handle("/metrics", ...).
func (m *Metrics) Handler() http.Handler {
	return promhttp.HandlerFor(m.registry, promhttp.HandlerOpts{})
}

// Accepted — заказ лёг в очередь (routing key события приёма/отмены).
func (m *Metrics) Accepted(routingKey string) {
	m.accepted.WithLabelValues(routingKey).Inc()
}

// Button — кнопка экрана бара применила переход (start|ready|pickup).
func (m *Metrics) Button(action string) {
	m.buttons.WithLabelValues(action).Inc()
}

// Published — статус ушёл в обмен cinema.
func (m *Metrics) Published(status string) {
	m.published.WithLabelValues(status).Inc()
}

// PublishFailed — публикация не удалась (брокер недоступен).
func (m *Metrics) PublishFailed() {
	m.publishFailed.Inc()
}

// Error — транзиентный сбой обработки события.
func (m *Metrics) Error() {
	m.errors.Inc()
}
