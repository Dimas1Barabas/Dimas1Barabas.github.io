package service

import (
	"context"
	"errors"
	"testing"

	"outbox-relay/internal/domain"
)

// Фейки портов: стор раздаёт записи батчами по limit, издатель помнит
// вызовы и отказывает выбранным записям. Сами доставленные/проваленные
// решения пометок — дело реального Store; здесь проверяем только то,
// что Relay передаёт ему правильный вердикт.

type fakeStore struct {
	pending []domain.Message // остаток хвоста
	batches []int            // размеры запрошенных батчей (лимит на вызов)
	err     error            // отказ хранилища целиком
}

func (s *fakeStore) DeliverBatch(_ context.Context, limit int, deliver domain.DeliverFn) (int, error) {
	s.batches = append(s.batches, limit)
	if s.err != nil {
		return 0, s.err
	}
	n := min(limit, len(s.pending))
	batch := s.pending[:n]
	s.pending = s.pending[n:]
	for _, m := range batch {
		_ = deliver(context.Background(), m)
	}
	return n, nil
}

func (s *fakeStore) Stats(context.Context) (domain.Stats, error) {
	return domain.Stats{Pending: int64(len(s.pending))}, nil
}

type fakePublisher struct {
	calls []domain.Message
	fail  map[string]error // по ID записи
}

func (p *fakePublisher) Publish(_ context.Context, m domain.Message) error {
	p.calls = append(p.calls, m)
	return p.fail[m.ID]
}

func messages(ids ...string) []domain.Message {
	ms := make([]domain.Message, 0, len(ids))
	for _, id := range ids {
		ms = append(ms, domain.Message{ID: id, RoutingKey: "booking.created"})
	}
	return ms
}

func TestTickDrainsPendingInBatches(t *testing.T) {
	store := &fakeStore{pending: messages("m1", "m2", "m3")}
	pub := &fakePublisher{}
	relay := NewRelay(store, pub, 2)

	relay.Tick(context.Background())

	// хвост 3 записи при батче 2: два захода — 2+1; короткий второй
	// батч останавливает цикл
	if len(store.batches) != 2 || store.batches[0] != 2 || store.batches[1] != 2 {
		t.Fatalf("батчи: %+v, хочу [2 2]", store.batches)
	}
	if len(pub.calls) != 3 {
		t.Fatalf("доставлено %d, хочу 3", len(pub.calls))
	}
	st, err := relay.Stats(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if st.PublishedTotal != 3 || st.FailedAttempts != 0 {
		t.Fatalf("счётчики: %+v", st)
	}
}

func TestTickDeliverErrorGoesToStoreVerdict(t *testing.T) {
	store := &fakeStore{pending: messages("ok", "bad")}
	pub := &fakePublisher{fail: map[string]error{"bad": errors.New("брокер недоступен")}}
	relay := NewRelay(store, pub, 10)

	relay.Tick(context.Background())

	// обе записи ушли в deliver; судьба «bad» — attempts+1/бэкофф —
	// решение Store, релей только посчитал провал и не упал
	if len(pub.calls) != 2 {
		t.Fatalf("доставлено %d, хочу 2", len(pub.calls))
	}
	st, _ := relay.Stats(context.Background())
	if st.PublishedTotal != 1 || st.FailedAttempts != 1 {
		t.Fatalf("счётчики: %+v", st)
	}
}

func TestTickStoreErrorLoggedAndRetriedNextTick(t *testing.T) {
	store := &fakeStore{err: errors.New("PG ушёл")}
	pub := &fakePublisher{}
	relay := NewRelay(store, pub, 10)

	relay.Tick(context.Background()) // не паникует, ничего не доставляет

	if len(pub.calls) != 0 || len(store.batches) != 1 {
		t.Fatalf("вызовы после отказа сторы: publisher=%d batches=%d", len(pub.calls), len(store.batches))
	}
}

func TestNotifySignalCoalesces(t *testing.T) {
	relay := NewRelay(&fakeStore{}, &fakePublisher{}, 1)

	if !relay.Notify() {
		t.Fatal("первый сигнал должен приниматься")
	}
	if relay.Notify() {
		t.Fatal("второй сигнал подряд должен сливаться: тик уже разбужен")
	}

	// main читает Wake в select рядом с тикером
	select {
	case <-relay.Wake():
	default:
		t.Fatal("принятый сигнал должен читаться из Wake()")
	}
	// и после чтения канал снова принимает
	if !relay.Notify() {
		t.Fatal("после чтения сигнал должен приниматься")
	}
}

func TestNewRelayBatchFloor(t *testing.T) {
	relay := NewRelay(&fakeStore{}, &fakePublisher{}, 0)
	relay.Tick(context.Background()) // батч 1: один заход по пустому хвосту
	if len(relay.store.(*fakeStore).batches) != 1 {
		t.Fatal("batch<1 должен нормализоваться в 1 и не делить на ноль")
	}
}

func TestStatsMirrorsStore(t *testing.T) {
	store := &fakeStore{pending: messages("m1")}
	pub := &fakePublisher{}
	relay := NewRelay(store, pub, 1)
	relay.Tick(context.Background())

	st, err := relay.Stats(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if st.Pending != 0 || st.PublishedTotal != 1 {
		t.Fatalf("счётчики после доставки: %+v", st)
	}
}
