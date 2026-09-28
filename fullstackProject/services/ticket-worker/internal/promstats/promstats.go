// Package promstats экспортирует счётчики воркера в формате Prometheus.
//
// Pull-модель: Collector читает атомики stats.Stats в момент скрейпа,
// поэтому double bookkeeping нет — места инкрементов (консьюмер и
// процессор) не меняются ни строкой. Вторая реализация «метрик» рядом
// с JSON-витриной /stats, как задумано гексагонально.
package promstats

import (
	"net/http"
	"time"

	"github.com/prometheus/client_golang/prometheus"
	"github.com/prometheus/client_golang/prometheus/collectors"
	"github.com/prometheus/client_golang/prometheus/promhttp"

	"ticket-worker/internal/stats"
)

// Exporter держит собственный реестр (не глобальный prometheus.DefaultRegisterer):
// тесты получают чистые ряды, приложение — один источник для /metrics.
type Exporter struct {
	registry *prometheus.Registry
}

// New собирает реестр: стандартные go_*/process_* коллекторы + показания
// счётчиков воркера.
func New(st *stats.Stats) *Exporter {
	reg := prometheus.NewRegistry()
	reg.MustRegister(
		collectors.NewGoCollector(),
		collectors.NewProcessCollector(collectors.ProcessCollectorOpts{}),
		&statsCollector{st: st},
	)
	return &Exporter{registry: reg}
}

// Handler отдаёт exposition-текст для mux.Handle("/metrics", ...).
func (e *Exporter) Handler() http.Handler {
	return promhttp.HandlerFor(e.registry, promhttp.HandlerOpts{})
}

// statsCollector переводит срез stats.Snapshot в промо-метрики.
type statsCollector struct {
	st *stats.Stats
}

var (
	verdictsDesc = prometheus.NewDesc(
		"cine_worker_verdicts_total",
		"Booking verdicts published by the worker",
		[]string{"verdict"}, nil,
	)
	refundsDesc = prometheus.NewDesc(
		"cine_worker_refunds_total",
		"Refund verdicts of the cancelling saga",
		[]string{"outcome"}, nil,
	)
	receivedDesc = prometheus.NewDesc(
		"cine_worker_events_received_total",
		"Booking events taken from RabbitMQ queues",
		nil, nil,
	)
	errorsDesc = prometheus.NewDesc(
		"cine_worker_errors_total",
		"Processing errors (nack to retry/dead-letter)",
		nil, nil,
	)
	uptimeDesc = prometheus.NewDesc(
		"cine_worker_uptime_seconds",
		"Seconds since worker start",
		nil, nil,
	)
)

func (c *statsCollector) Describe(ch chan<- *prometheus.Desc) {
	ch <- verdictsDesc
	ch <- refundsDesc
	ch <- receivedDesc
	ch <- errorsDesc
	ch <- uptimeDesc
}

func (c *statsCollector) Collect(ch chan<- prometheus.Metric) {
	ch <- prometheus.MustNewConstMetric(verdictsDesc, prometheus.CounterValue, float64(c.st.Confirmed.Load()), "confirmed")
	ch <- prometheus.MustNewConstMetric(verdictsDesc, prometheus.CounterValue, float64(c.st.Failed.Load()), "failed")
	ch <- prometheus.MustNewConstMetric(verdictsDesc, prometheus.CounterValue, float64(c.st.Expired.Load()), "expired")
	ch <- prometheus.MustNewConstMetric(refundsDesc, prometheus.CounterValue, float64(c.st.Refunds.Load()), "done")
	ch <- prometheus.MustNewConstMetric(refundsDesc, prometheus.CounterValue, float64(c.st.RefundFailed.Load()), "failed")
	ch <- prometheus.MustNewConstMetric(receivedDesc, prometheus.CounterValue, float64(c.st.Received.Load()))
	ch <- prometheus.MustNewConstMetric(errorsDesc, prometheus.CounterValue, float64(c.st.Errors.Load()))
	ch <- prometheus.MustNewConstMetric(uptimeDesc, prometheus.GaugeValue, time.Since(c.st.StartedAt).Seconds())
}
