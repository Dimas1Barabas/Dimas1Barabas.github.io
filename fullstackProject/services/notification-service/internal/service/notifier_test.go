package service

// Сценарий тестируется через реальные порты с маленькими стабами:
// это и есть смысл гексагона — use-case не знает, что за ним не стоит
// ни брокер, ни сеть.

import (
	"context"
	"errors"
	"reflect"
	"testing"
	"time"

	"notification-service/internal/domain"
)

// spySender запоминает, что и как «отправилось».
type spySender struct {
	sent []domain.Notification
	fail bool
}

func (s *spySender) Send(_ context.Context, n domain.Notification) error {
	if s.fail {
		return errors.New("шлюз лежит")
	}
	s.sent = append(s.sent, n)
	return nil
}

// fakeMetrics считает вызовы порта метрик.
type fakeMetrics struct {
	received, sent, failed, errs int
	kinds                        []domain.Kind
}

func (m *fakeMetrics) Received() { m.received++ }
func (m *fakeMetrics) Failed()   { m.failed++ }
func (m *fakeMetrics) Errors()   { m.errs++ }
func (m *fakeMetrics) Sent(k domain.Kind) {
	m.sent++
	m.kinds = append(m.kinds, k)
}
func (m *fakeMetrics) Snapshot() map[string]any { return nil }

func TestHandleOutcomeHappyPath(t *testing.T) {
	sender := &spySender{}
	repo := &fakeRepo{}
	metrics := &fakeMetrics{}
	svc := NewNotifier(sender, repo, metrics)
	svc.now = func() time.Time { return time.Date(2026, 9, 17, 10, 0, 0, 0, time.UTC) }

	err := svc.HandleOutcome(context.Background(), domain.Outcome{
		BookingID: "b-7", Verdict: "CONFIRMED", Message: "Оплата прошла",
	})
	if err != nil {
		t.Fatalf("неожданная ошибка: %v", err)
	}

	if len(sender.sent) != 1 {
		t.Fatalf("отправлено писем %d, want 1", len(sender.sent))
	}
	saved := repo.saved[0]
	if saved.Status != domain.StatusSent || saved.Error != "" {
		t.Fatalf("статус = %s/%q, want SENT без ошибки", saved.Status, saved.Error)
	}
	if metrics.received != 1 || metrics.sent != 1 || metrics.failed != 0 || metrics.errs != 0 {
		t.Fatalf("метрики = %+v", metrics)
	}
	if !reflect.DeepEqual(metrics.kinds, []domain.Kind{domain.KindConfirmed}) {
		t.Fatalf("kinds = %v, want [booking_confirmed]", metrics.kinds)
	}
}

func TestHandleOutcomeSenderFails(t *testing.T) {
	sender := &spySender{fail: true}
	repo := &fakeRepo{}
	metrics := &fakeMetrics{}
	svc := NewNotifier(sender, repo, metrics)

	err := svc.HandleOutcome(context.Background(), domain.Outcome{
		BookingID: "b-8", Verdict: "EXPIRED", Message: "окно истекло",
	})
	if err != nil {
		t.Fatalf("сбой доставки — не сбой сценария: %v", err)
	}

	saved := repo.saved[0]
	if saved.Status != domain.StatusFailed {
		t.Fatalf("статус = %s, want FAILED", saved.Status)
	}
	if saved.Error == "" {
		t.Fatal("текст ошибки доставки не сохранён")
	}
	if metrics.failed != 1 || metrics.sent != 0 {
		t.Fatalf("метрики = %+v", metrics)
	}
}

func TestHandleOutcomePoisonVerdict(t *testing.T) {
	sender := &spySender{}
	repo := &fakeRepo{}
	metrics := &fakeMetrics{}
	svc := NewNotifier(sender, repo, metrics)

	err := svc.HandleOutcome(context.Background(), domain.Outcome{BookingID: "b-9", Verdict: "???"})
	if !errors.Is(err, domain.ErrUnknownVerdict) {
		t.Fatalf("ошибка = %v, want ErrUnknownVerdict", err)
	}
	if len(repo.saved) != 0 || len(sender.sent) != 0 {
		t.Fatal("ядовитое событие не должно доходить до отправки и хранения")
	}
	if metrics.errs != 1 {
		t.Fatalf("errors = %d, want 1", metrics.errs)
	}
}

func TestListClampsLimit(t *testing.T) {
	sender := &spySender{}
	repo := &fakeRepo{}
	svc := NewNotifier(sender, repo, &fakeMetrics{})

	// limit <= 0 и > 500 нормализуются сценарием — репозиторий видит 50
	if err := svc.HandleOutcome(context.Background(), domain.Outcome{BookingID: "b", Verdict: "CONFIRMED"}); err != nil {
		t.Fatal(err)
	}
	_, got := svc.List(context.Background(), domain.Filter{Limit: 0})
	if got != nil {
		t.Fatal(got)
	}
	if repo.lastLimit != 50 {
		t.Fatalf("лимит в репозиторий = %d, want 50", repo.lastLimit)
	}
}

// fakeRepo — стаб порта хранилища.
type fakeRepo struct {
	saved     []domain.Notification
	lastLimit int
}

func (r *fakeRepo) Save(_ context.Context, n domain.Notification) error {
	r.saved = append(r.saved, n)
	return nil
}

func (r *fakeRepo) List(_ context.Context, f domain.Filter) ([]domain.Notification, error) {
	r.lastLimit = f.Limit
	return r.saved, nil
}
