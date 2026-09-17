// Package stats ведёт счётчики обработки: атомарные поля инкрементят
// горутины консьюмера, а читает их HTTP-эндпоинт /stats без блокировок.
package stats

import (
	"sync/atomic"
	"time"
)

type Stats struct {
	Received     atomic.Int64
	Confirmed    atomic.Int64
	Failed       atomic.Int64
	Expired      atomic.Int64
	Refunds      atomic.Int64
	RefundFailed atomic.Int64
	Errors       atomic.Int64
	StartedAt    time.Time
	WorkerID     string
}

// New создаёт счётчики с фиксированным стартом uptime.
func New(workerID string) *Stats {
	return &Stats{StartedAt: time.Now(), WorkerID: workerID}
}

// Snapshot отдаёт мгновенный срез метрик для JSON-ответа.
func (s *Stats) Snapshot() map[string]any {
	return map[string]any{
		"workerId":     s.WorkerID,
		"uptimeSec":    int(time.Since(s.StartedAt).Seconds()),
		"received":     s.Received.Load(),
		"confirmed":    s.Confirmed.Load(),
		"failed":       s.Failed.Load(),
		"expired":      s.Expired.Load(),
		"refunds":      s.Refunds.Load(),
		"refundFailed": s.RefundFailed.Load(),
		"errors":       s.Errors.Load(),
	}
}
