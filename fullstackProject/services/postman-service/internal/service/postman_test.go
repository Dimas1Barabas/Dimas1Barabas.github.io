package service

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"testing"
	"time"

	"postman-service/internal/adapter/out/memory"
	"postman-service/internal/domain"
)

// fakeSender — HTTP-партнёр подменён: отвечает по сценарию.
type fakeSender struct {
	failuresLeft int // сколько раз отказывать, потом успех
	got          []domain.Envelope
}

func (f *fakeSender) Send(_ context.Context, _ domain.Subscription, e domain.Envelope) error {
	if f.failuresLeft > 0 {
		f.failuresLeft--
		return fmt.Errorf("HTTP 500 (фейк партнёра)")
	}
	f.got = append(f.got, e)
	return nil
}

// frozen — часы тикают руками: Tick видит мир на момент «сейчас».
type frozen struct{ now time.Time }

func (c *frozen) Now() time.Time          { return c.now }
func (c *frozen) Advance(d time.Duration) { c.now = c.now.Add(d) }

func newPostman(t *testing.T, sender domain.WebhookSender, maxAttempts int) (*Postman, *memory.Store, *frozen) {
	t.Helper()
	store := memory.NewStore()
	clock := &frozen{now: time.Date(2026, 11, 26, 12, 0, 0, 0, time.UTC)}
	p := New(store.Subs, store.Deliveries, sender, nil, maxAttempts, 2*time.Second, 25)
	p.SetClock(clock.Now)
	return p, store, clock
}

func TestSubscribeValidation(t *testing.T) {
	p, _, _ := newPostman(t, &fakeSender{}, 3)

	if _, err := p.Subscribe(context.Background(), "ftp://partner.local/hook", nil); !errors.Is(err, domain.ErrInvalidSubscription) {
		t.Errorf("ftp-URL должен быть отвергнут: %v", err)
	}
	if _, err := p.Subscribe(context.Background(), "не url вовсе", nil); !errors.Is(err, domain.ErrInvalidSubscription) {
		t.Errorf("мусорный URL должен быть отвергнут: %v", err)
	}
	if _, err := p.Subscribe(context.Background(), "http://p.local/hook", []string{"bar.order.created"}); !errors.Is(err, domain.ErrInvalidSubscription) {
		t.Errorf("чужой тип события должен быть отвергнут: %v", err)
	}

	sub, err := p.Subscribe(context.Background(), "http://partner.local/hook", []string{" booking.processed ", "booking.processed"})
	if err != nil {
		t.Fatalf("валидная подписка: %v", err)
	}
	if sub.ID == "" || !strings.HasPrefix(sub.Secret, "whsec_") || len(sub.Secret) < 20 {
		t.Fatalf("подписка без id/секрета: %+v", sub)
	}
	if len(sub.Events) != 1 {
		t.Errorf("фильтр не нормализован: %v", sub.Events)
	}
}

func TestHandleEventFanOutAndDedup(t *testing.T) {
	ctx := context.Background()
	p, store, _ := newPostman(t, &fakeSender{}, 3)

	if _, err := p.Subscribe(ctx, "http://all.local/hook", nil); err != nil {
		t.Fatalf("подписка all: %v", err)
	}
	if _, err := p.Subscribe(ctx, "http://verdicts.local/hook", []string{"booking.processed"}); err != nil {
		t.Fatalf("подписка verdicts: %v", err)
	}

	evt := domain.Event{
		ID:         "abc123",
		Type:       "booking.processed",
		Payload:    []byte(`{"bookingId":"b-1","status":"CONFIRMED"}`),
		ReceivedAt: time.Now(),
	}
	if err := p.HandleEvent(ctx, evt); err != nil {
		t.Fatalf("HandleEvent: %v", err)
	}
	deliveries, _ := store.Deliveries.List(ctx, domain.DeliveryFilter{})
	if len(deliveries) != 2 {
		t.Fatalf("ждём доставки обоим подписчикам, есть %d", len(deliveries))
	}

	// redelivery того же события — дедупликация: новых строк нет
	if err := p.HandleEvent(ctx, evt); err != nil {
		t.Fatalf("ределивери: %v", err)
	}
	deliveries, _ = store.Deliveries.List(ctx, domain.DeliveryFilter{})
	if len(deliveries) != 2 {
		t.Fatalf("ределивери не должен плодить доставки, есть %d", len(deliveries))
	}

	// чужой тип подписчикам all не подходит? booking.created — подходит all,
	// не подходит verdicts: ровно одна новая строка
	created := domain.Event{ID: "def456", Type: "booking.created", Payload: []byte(`{}`), ReceivedAt: time.Now()}
	if err := p.HandleEvent(ctx, created); err != nil {
		t.Fatalf("booking.created: %v", err)
	}
	deliveries, _ = store.Deliveries.List(ctx, domain.DeliveryFilter{})
	if len(deliveries) != 3 {
		t.Fatalf("booking.created должен добавить одну доставку, есть %d", len(deliveries))
	}
}

func TestHandleEventPoison(t *testing.T) {
	p, _, _ := newPostman(t, &fakeSender{}, 3)
	ctx := context.Background()

	if err := p.HandleEvent(ctx, domain.Event{ID: "x", Type: "bar.order.created", Payload: []byte(`{}`)}); !errors.Is(err, domain.ErrInvalidEvent) {
		t.Errorf("чужой routing key = ErrInvalidEvent: %v", err)
	}
	if err := p.HandleEvent(ctx, domain.Event{ID: "x", Type: "booking.created", Payload: []byte(`не json`)}); !errors.Is(err, domain.ErrInvalidEvent) {
		t.Errorf("битый JSON = ErrInvalidEvent: %v", err)
	}
	if err := p.HandleEvent(ctx, domain.Event{Type: "booking.created", Payload: []byte(`{}`)}); !errors.Is(err, domain.ErrInvalidEvent) {
		t.Errorf("пустой отпечаток = ErrInvalidEvent: %v", err)
	}
}

func TestTickDelivered(t *testing.T) {
	ctx := context.Background()
	sender := &fakeSender{}
	p, store, _ := newPostman(t, sender, 3)

	if _, err := p.Subscribe(ctx, "http://partner.local/hook", nil); err != nil {
		t.Fatalf("подписка: %v", err)
	}
	if err := p.HandleEvent(ctx, domain.Event{ID: "e1", Type: "booking.expired", Payload: []byte(`{"bookingId":"b-9"}`)}); err != nil {
		t.Fatalf("HandleEvent: %v", err)
	}

	p.Tick(ctx)

	deliveries, _ := store.Deliveries.List(ctx, domain.DeliveryFilter{})
	if len(deliveries) != 1 || deliveries[0].Status != domain.StatusDelivered {
		t.Fatalf("ждём delivered с первой попытки: %+v", deliveries)
	}
	if deliveries[0].DeliveredAt == nil {
		t.Error("DeliveredAt не проставлен")
	}
	if deliveries[0].Attempts != 1 {
		t.Errorf("Attempts = %d, want 1", deliveries[0].Attempts)
	}
	if len(sender.got) != 1 || sender.got[0].Type != "booking.expired" {
		t.Fatalf("отправителю ушёл не тот конверт: %+v", sender.got)
	}
}

func TestTickBackoffAndDead(t *testing.T) {
	ctx := context.Background()
	sender := &fakeSender{failuresLeft: 5} // умрёт раньше, чем закончатся отказы
	p, store, clock := newPostman(t, sender, 3)

	if _, err := p.Subscribe(ctx, "http://partner.local/hook", nil); err != nil {
		t.Fatalf("подписка: %v", err)
	}
	if err := p.HandleEvent(ctx, domain.Event{ID: "e2", Type: "booking.refunded", Payload: []byte(`{}`)}); err != nil {
		t.Fatalf("HandleEvent: %v", err)
	}

	// попытка 1: отказ, ретрай через baseBackoff (2 c)
	p.Tick(ctx)
	d, err := store.Deliveries.Get(ctx, firstDeliveryID(t, store))
	if err != nil {
		t.Fatalf("get: %v", err)
	}
	if d.Status != domain.StatusQueued || d.Attempts != 1 {
		t.Fatalf("после 1-го отказа ждём queued/1: %+v", d)
	}
	if want := clock.Now().Add(2 * time.Second); !d.NextAttemptAt.Equal(want) {
		t.Errorf("NextAttemptAt = %v, want %v", d.NextAttemptAt, want)
	}

	// раньше времени тикер её не берёт
	clock.Advance(1 * time.Second)
	p.Tick(ctx)
	if d, _ = store.Deliveries.Get(ctx, d.ID); d.Attempts != 1 {
		t.Fatalf("досрочный тик не должен пытаться: %+v", d)
	}

	// попытка 2: отказ, пауза удвоилась (4 c)
	clock.Advance(1 * time.Second)
	p.Tick(ctx)
	if d, _ = store.Deliveries.Get(ctx, d.ID); d.Attempts != 2 {
		t.Fatalf("попытка 2 не зафиксирована: %+v", d)
	}
	if want := clock.Now().Add(4 * time.Second); !d.NextAttemptAt.Equal(want) {
		t.Errorf("пауза не удвоилась: NextAttemptAt = %v, want %v", d.NextAttemptAt, want)
	}

	// попытка 3: последняя — DLQ
	clock.Advance(4 * time.Second)
	p.Tick(ctx)
	if d, _ = store.Deliveries.Get(ctx, d.ID); d.Status != domain.StatusDead || d.Attempts != 3 {
		t.Fatalf("после 3-х отказов ждём dead/3: %+v", d)
	}
	if d.LastError == "" {
		t.Error("LastError пуст")
	}

	// DLQ не пытается снова
	clock.Advance(10 * time.Minute)
	p.Tick(ctx)
	if d, _ = store.Deliveries.Get(ctx, d.ID); d.Attempts != 3 {
		t.Fatalf("DLQ не должен ретраиться: %+v", d)
	}
}

func TestReplay(t *testing.T) {
	ctx := context.Background()
	sender := &fakeSender{}
	p, store, clock := newPostman(t, sender, 3)

	if _, err := p.Subscribe(ctx, "http://partner.local/hook", nil); err != nil {
		t.Fatalf("подписка: %v", err)
	}
	if err := p.HandleEvent(ctx, domain.Event{ID: "e3", Type: "booking.created", Payload: []byte(`{}`)}); err != nil {
		t.Fatalf("HandleEvent: %v", err)
	}

	p.Tick(ctx) // отправитель без отказов → delivered

	id := firstDeliveryID(t, store)
	d, _ := store.Deliveries.Get(ctx, id)
	if d.Status != domain.StatusDelivered {
		t.Fatalf("подготовка: ждём delivered, есть %s", d.Status)
	}

	// replay delivered → queued с нулевыми попытками
	revived, err := p.Replay(ctx, id)
	if err != nil {
		t.Fatalf("replay: %v", err)
	}
	if revived.Status != domain.StatusQueued || revived.Attempts != 0 {
		t.Fatalf("replay должен вернуть queued/0: %+v", revived)
	}
	if want := clock.Now(); !revived.NextAttemptAt.Equal(want) {
		t.Errorf("replay должен ставить «сейчас»: %v != %v", revived.NextAttemptAt, want)
	}

	// повторный replay queued → отказ
	if _, err := p.Replay(ctx, id); !errors.Is(err, domain.ErrNotReplayable) {
		t.Errorf("queued не перепосылается: %v", err)
	}
	if _, err := p.Replay(ctx, "whdl_netu"); !errors.Is(err, domain.ErrDeliveryNotFound) {
		t.Errorf("несуществующая доставка: %v", err)
	}
}

func TestUnsubscribe(t *testing.T) {
	ctx := context.Background()
	p, store, _ := newPostman(t, &fakeSender{}, 3)

	sub, err := p.Subscribe(ctx, "http://gone.local/hook", nil)
	if err != nil {
		t.Fatalf("подписка: %v", err)
	}
	if err := p.HandleEvent(ctx, domain.Event{ID: "e4", Type: "booking.created", Payload: []byte(`{}`)}); err != nil {
		t.Fatalf("HandleEvent: %v", err)
	}

	deleted, err := p.Unsubscribe(ctx, sub.ID)
	if err != nil || !deleted {
		t.Fatalf("Unsubscribe: %v %v", deleted, err)
	}
	if again, _ := p.Unsubscribe(ctx, sub.ID); again {
		t.Error("повторное удаление должно вернуть false")
	}

	// доставка стоит в очереди, подписки уже нет → тихий DLQ
	p.Tick(ctx)
	d, _ := store.Deliveries.Get(ctx, firstDeliveryID(t, store))
	if d.Status != domain.StatusDead || d.LastError != "подписка удалена" {
		t.Fatalf("осиротевшая доставка должна уйти в DLQ: %+v", d)
	}
}

// firstDeliveryID — единственная (или первая) доставка хранилища.
func firstDeliveryID(t *testing.T, store *memory.Store) string {
	t.Helper()
	deliveries, err := store.Deliveries.List(context.Background(), domain.DeliveryFilter{})
	if err != nil || len(deliveries) == 0 {
		t.Fatalf("нет доставок: %v", err)
	}
	return deliveries[len(deliveries)-1].ID // самая старая — последняя после DESC
}

func TestEnvelopeCarriesPayloadVerbatim(t *testing.T) {
	ctx := context.Background()
	sender := &fakeSender{}
	p, _, _ := newPostman(t, sender, 3)

	if _, err := p.Subscribe(ctx, "http://partner.local/hook", []string{"booking.processed"}); err != nil {
		t.Fatalf("подписка: %v", err)
	}
	payload := map[string]any{"bookingId": "b-42", "status": "CONFIRMED", "processedAt": "2026-11-26T12:00:00Z"}
	raw, _ := json.Marshal(payload)
	if err := p.HandleEvent(ctx, domain.Event{ID: "e5", Type: "booking.processed", Payload: raw}); err != nil {
		t.Fatalf("HandleEvent: %v", err)
	}
	p.Tick(ctx)

	if len(sender.got) != 1 {
		t.Fatalf("конверт не ушёл: %+v", sender.got)
	}
	var data map[string]any
	if err := json.Unmarshal(sender.got[0].Data, &data); err != nil {
		t.Fatalf("data не JSON: %v", err)
	}
	if data["bookingId"] != "b-42" || data["status"] != "CONFIRMED" {
		t.Errorf("payload искажён: %v", data)
	}
	if sender.got[0].SubscriptionID == "" || sender.got[0].DeliveryID == "" {
		t.Errorf("конверт без идентификаторов: %+v", sender.got[0])
	}
}
