package service

import (
	"context"
	"errors"
	"testing"

	"recommendation-service/internal/adapter/out/memory"
	"recommendation-service/internal/domain"
)

func TestHandleSignalInvalid(t *testing.T) {
	a := NewAdvisor(memory.NewStore())
	cases := []struct {
		name string
		sig  domain.Signal
	}{
		{"пустой жанр", domain.Signal{UserID: "u1", MovieID: "m1", Kind: domain.KindBooking, DedupKey: "booking:b1"}},
		{"отзыв со рейтингом 6", domain.Signal{UserID: "u1", MovieID: "m1", Genre: "драма", Kind: domain.KindReview, Rating: 6, DedupKey: "review:r1"}},
		{"неизвестный тип", domain.Signal{UserID: "u1", MovieID: "m1", Genre: "драма", Kind: "click", DedupKey: "click:c1"}},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if err := a.HandleSignal(context.Background(), tc.sig); !errors.Is(err, domain.ErrInvalidSignal) {
				t.Fatalf("HandleSignal() = %v, want ErrInvalidSignal", err)
			}
		})
	}
}

func TestHandleSignalStoresAndDedups(t *testing.T) {
	a := NewAdvisor(memory.NewStore())
	ctx := context.Background()
	sig := domain.Signal{
		UserID: "u1", MovieID: "m1", MovieTitle: "Скрик", Genre: "хоррор",
		Kind: domain.KindBooking, DedupKey: "booking:b1",
	}
	if err := a.HandleSignal(ctx, sig); err != nil {
		t.Fatalf("первый HandleSignal: %v", err)
	}
	// Редоставление того же события — no-op, не ошибка.
	if err := a.HandleSignal(ctx, sig); err != nil {
		t.Fatalf("повторный HandleSignal: %v", err)
	}

	rec, err := a.Recommend(ctx, "u1", []domain.Movie{
		{MovieID: "m1", Title: "Скрик", Genre: "хоррор"},
		{MovieID: "m2", Title: "Заклятие", Genre: "хоррор"},
	}, 0)
	if err != nil {
		t.Fatalf("Recommend: %v", err)
	}
	if len(rec.Items) != 1 || rec.Items[0].MovieID != "m2" {
		t.Fatalf("топ = %+v, want только m2 (m1 просмотрен)", rec.Items)
	}
	if rec.Items[0].Reason != "вы часто смотрите «хоррор»" {
		t.Fatalf("Reason = %q", rec.Items[0].Reason)
	}
}

func TestRecommendEmptyUser(t *testing.T) {
	a := NewAdvisor(memory.NewStore())
	if _, err := a.Recommend(context.Background(), "", nil, 0); !errors.Is(err, domain.ErrEmptyUserID) {
		t.Fatalf("Recommend(\"\") = %v, want ErrEmptyUserID", err)
	}
}

func TestRecommendColdStart(t *testing.T) {
	a := NewAdvisor(memory.NewStore())
	rec, err := a.Recommend(context.Background(), "u-new", []domain.Movie{
		{MovieID: "m1", Title: "Дюна", Genre: "фантастика", RatingAvg: 4.8, RatingCount: 12},
	}, 0)
	if err != nil {
		t.Fatalf("Recommend: %v", err)
	}
	if rec.Basis != domain.BasisPopular {
		t.Fatalf("Basis = %s, want popular", rec.Basis)
	}
}

func TestRecommendStoreError(t *testing.T) {
	a := NewAdvisor(failingStore{})
	if err := a.HandleSignal(context.Background(), domain.Signal{
		UserID: "u1", MovieID: "m1", Genre: "драма", Kind: domain.KindBooking, DedupKey: "booking:b1",
	}); err == nil {
		t.Fatal("HandleSignal должен прокинуть ошибку хранилища (retry)")
	}
	if _, err := a.Recommend(context.Background(), "u1", nil, 0); err == nil {
		t.Fatal("Recommend должен прокинуть ошибку хранилища (retry)")
	}
}

type failingStore struct{}

func (failingStore) Append(context.Context, domain.Signal) error {
	return errors.New("бд недоступна")
}
func (failingStore) List(context.Context, string) ([]domain.Signal, error) {
	return nil, errors.New("бд недоступна")
}
