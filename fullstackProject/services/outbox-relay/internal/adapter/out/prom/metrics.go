// Package prom — счётчики Курьера для Prometheus. Метрики ведут адаптеры
// на границах: издатель в брокер (результат доставки) и gRPC Notify
// (принят/слился). Витрина pending — за Stats RPC/HTTP, дублировать её
// гейджем здесь не стали: он требовал бы отдельного опроса сторы.
package prom

import (
	"net/http"

	"github.com/prometheus/client_golang/prometheus"
	"github.com/prometheus/client_golang/prometheus/collectors"
	"github.com/prometheus/client_golang/prometheus/promhttp"
)

type Metrics struct {
	registry *prometheus.Registry

	delivered *prometheus.CounterVec // result=ok|error — исход доставки записи
	notified  *prometheus.CounterVec // accepted=true|false — сигнал Notify
}

// New собирает реестр: собственный (не глобальный) — чистые ряды в тестах.
func New() *Metrics {
	reg := prometheus.NewRegistry()
	m := &Metrics{
		registry: reg,
		delivered: prometheus.NewCounterVec(prometheus.CounterOpts{
			Name: "cine_outbox_delivered_total",
			Help: "Outbox records published to the broker",
		}, []string{"result"}),
		notified: prometheus.NewCounterVec(prometheus.CounterOpts{
			Name: "cine_outbox_notify_total",
			Help: "Wake-up signals from the API after commit",
		}, []string{"accepted"}),
	}
	reg.MustRegister(
		collectors.NewGoCollector(),
		collectors.NewProcessCollector(collectors.ProcessCollectorOpts{}),
		m.delivered, m.notified,
	)
	return m
}

// Handler отдаёт exposition-текст для mux.Handle("/metrics", ...).
func (m *Metrics) Handler() http.Handler {
	return promhttp.HandlerFor(m.registry, promhttp.HandlerOpts{})
}

// DeliveredOk — запись уехала в обмен cinema.
func (m *Metrics) DeliveredOk() {
	m.delivered.WithLabelValues("ok").Inc()
}

// DeliveredError — публикация не удалась; запись осталась в pending,
// следующий тик повторит с бэкоффом.
func (m *Metrics) DeliveredError() {
	m.delivered.WithLabelValues("error").Inc()
}

// NotifyAccepted — сигнал Notify разбудил тик.
func (m *Metrics) NotifyAccepted() {
	m.notified.WithLabelValues("true").Inc()
}

// NotifyCoalesced — сигнал слился с уже разбуженным тиком (RPC всё равно
// отработал, доставка не пострадала).
func (m *Metrics) NotifyCoalesced() {
	m.notified.WithLabelValues("false").Inc()
}
