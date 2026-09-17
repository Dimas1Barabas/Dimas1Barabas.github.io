package memory

import (
	"sync"
	"sync/atomic"
	"time"

	"notification-service/internal/domain"
)

// Metrics — адаптер порта домена: атомарные счётчики + срез для /stats.
type Metrics struct {
	received atomic.Int64
	sent     atomic.Int64
	failed   atomic.Int64
	errors   atomic.Int64
	byKind   sync.Map // domain.Kind → *atomic.Int64

	startedAt time.Time
}

func NewMetrics() *Metrics {
	return &Metrics{startedAt: time.Now()}
}

func (m *Metrics) Received() { m.received.Add(1) }
func (m *Metrics) Failed()   { m.failed.Add(1) }
func (m *Metrics) Errors()   { m.errors.Add(1) }

func (m *Metrics) Sent(kind domain.Kind) {
	m.sent.Add(1)
	if v, ok := m.byKind.Load(kind); ok {
		v.(*atomic.Int64).Add(1)
		return
	}
	actual, _ := m.byKind.LoadOrStore(kind, new(atomic.Int64))
	actual.(*atomic.Int64).Add(1)
}

// Snapshot отдаёт мгновенный срез метрик для JSON-ответа.
func (m *Metrics) Snapshot() map[string]any {
	kinds := map[string]int64{}
	m.byKind.Range(func(k, v any) bool {
		kinds[string(k.(domain.Kind))] = v.(*atomic.Int64).Load()
		return true
	})
	return map[string]any{
		"service":   "notification",
		"uptimeSec": int(time.Since(m.startedAt).Seconds()),
		"received":  m.received.Load(),
		"sent":      m.sent.Load(),
		"failed":    m.failed.Load(),
		"errors":    m.errors.Load(),
		"byKind":    kinds,
	}
}
