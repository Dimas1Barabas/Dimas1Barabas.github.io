// Package service — use-case'ы «Суфлёра»: вердикты, витрина и правки
// флагов без знания о транспортах.
package service

import (
	"context"
	"errors"
	"time"

	"flags-service/internal/domain"
)

var (
	// ErrInvalidKey — ключ вне алфавита домена (см. domain.ValidKey).
	ErrInvalidKey = errors.New("ключ флага: строчные буквы/цифры/._-, 1..100 символов")
	// ErrInvalidPercent — процент раскатки вне диапазона.
	ErrInvalidPercent = errors.New("процент раскатки вне 0..100")
)

// Flags — применение правил к флагам: Evaluate спрашивают гварды и
// кэш состояний API, List/Upsert/Delete/Revisions — админка.
type Flags struct {
	store domain.FlagStore
	now   func() time.Time // инъекция времени для тестов аудита
}

// New собирает сервис над хранилищем.
func New(store domain.FlagStore) *Flags {
	return &Flags{store: store, now: time.Now}
}

// Evaluate — вердикт флага для сущности. Отсутствие флага — НЕ ошибка:
// оф с причиной not_found — новая фича по умолчанию скрыта, отдельный
// реестр «известных флагов» сервису не нужен. Ошибка хранилища
// всплывает вызывающему: gRPC ответит Internal, API погасит офлайном
// последнего снимка (fail-safe: фича скрыта).
func (s *Flags) Evaluate(ctx context.Context, key, entityID string) (domain.Verdict, error) {
	f, found, err := s.store.Get(ctx, key)
	if err != nil {
		return domain.Verdict{}, err
	}
	if !found {
		return domain.Verdict{Enabled: false, Reason: domain.ReasonNotFound}, nil
	}
	return domain.Evaluate(f, entityID), nil
}

// List — все флаги по ключу: снимок для кэша API и витрины админки.
func (s *Flags) List(ctx context.Context) ([]domain.Flag, error) {
	return s.store.List(ctx)
}

// Upsert — создать или обновить флаг: валидация домена, штамп времени
// ставит сервис (не доверяем часам вызывающего), автора записывает
// вызывающий (админка API передаёт юзера).
func (s *Flags) Upsert(ctx context.Context, f domain.Flag) (domain.Flag, error) {
	if !domain.ValidKey(f.Key) {
		return domain.Flag{}, ErrInvalidKey
	}
	if f.Percentage < 0 || f.Percentage > 100 {
		return domain.Flag{}, ErrInvalidPercent
	}
	f.UpdatedAt = s.now()
	if err := s.store.Save(ctx, f); err != nil {
		return domain.Flag{}, err
	}
	return f, nil
}

// Delete — убрать флаг; false, если его и не было. Аудит правок
// переживает удаление (см. domain.Revision).
func (s *Flags) Delete(ctx context.Context, key string) (bool, error) {
	return s.store.Delete(ctx, key)
}

// Revisions — аудит правок флага, свежими сверху.
func (s *Flags) Revisions(ctx context.Context, key string, limit int) ([]domain.Revision, error) {
	if limit < 1 {
		limit = 20
	}
	return s.store.Revisions(ctx, key, limit)
}
