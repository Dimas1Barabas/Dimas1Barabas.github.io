// Package processing имитирует платёжный шлюз: задержка + вердикт.
// Не знает ни о брокере, ни о HTTP — чистая логика, легко тестировать.
package processing

import (
	"fmt"
	"math/rand/v2"
	"strings"
	"time"

	"ticket-worker/internal/events"
)

// Processor — «платёжный шлюз»: параметры имитации приходят извне,
// чтобы пакет не зависел на конфиг окружения.
type Processor struct {
	WorkerID string

	PayMin, PayMax       time.Duration // границы «оплаты»
	PaySuccessRate       float64       // доля успешных оплат
	RefundMin, RefundMax time.Duration // границы «возврата»
	RefundSuccessRate    float64       // доля успешных возвратов
}

// Process имитирует оплату брони: задержка + вердикт.
func (p *Processor) Process(ev events.BookingCreated) events.BookingProcessed {
	latency(p.PayMin, p.PayMax)

	now := time.Now().UTC().Format(time.RFC3339)
	if rand.Float64() < p.PaySuccessRate {
		return events.BookingProcessed{
			BookingID:   ev.BookingID,
			Status:      "CONFIRMED",
			Message:     fmt.Sprintf("Оплата %d ₽ прошла. Места %s. Приятного просмотра!", ev.TotalRub, strings.Join(ev.Seats, ", ")),
			ProcessedBy: p.WorkerID,
			ProcessedAt: now,
		}
	}
	return events.BookingProcessed{
		BookingID:   ev.BookingID,
		Status:      "FAILED",
		Message:     fmt.Sprintf("Платёж отклонён банком (код %02d). Бронь отменена, деньги не списаны.", rand.IntN(90)+10),
		ProcessedBy: p.WorkerID,
		ProcessedAt: now,
	}
}

// Refund имитирует возврат платежа для саги отмены: задержка + вердикт.
func (p *Processor) Refund(ev events.BookingCancelled) events.BookingRefunded {
	latency(p.RefundMin, p.RefundMax)

	now := time.Now().UTC().Format(time.RFC3339)
	if rand.Float64() < p.RefundSuccessRate {
		return events.BookingRefunded{
			BookingID:   ev.BookingID,
			Status:      "CANCELLED",
			Message:     fmt.Sprintf("Возврат %d ₽ зачислен. Места %s снова в продаже.", ev.TotalRub, strings.Join(ev.Seats, ", ")),
			ProcessedBy: p.WorkerID,
			ProcessedAt: now,
		}
	}
	return events.BookingRefunded{
		BookingID:   ev.BookingID,
		Status:      "REFUND_FAILED",
		Message:     fmt.Sprintf("Банк отклонил возврат (код %02d). Бронь остаётся подтверждённой, места держатся.", rand.IntN(90)+10),
		ProcessedBy: p.WorkerID,
		ProcessedAt: now,
	}
}

// Expired строит вердикт истечения: сообщение уже прождало окно оплаты
// в wait-очереди API, задержка не нужна. now — параметр для тестов.
func (p *Processor) Expired(ev events.BookingPaymentTimeout, now time.Time) events.BookingExpired {
	return events.BookingExpired{
		BookingID:   ev.BookingID,
		Message:     "Время оплаты истекло. Бронь отменена, места снова в продаже.",
		ProcessedBy: p.WorkerID,
		ExpiredAt:   now.UTC().Format(time.RFC3339),
	}
}

// latency спит случайный интервал внутри [min, max).
func latency(min, max time.Duration) {
	time.Sleep(min + time.Duration(rand.Int64N(int64(max-min))))
}
