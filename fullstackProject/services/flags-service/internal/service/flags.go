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
	// ErrInvalidVariants — список вариантов эксперимента вне правил.
	ErrInvalidVariants = errors.New("варианты: имена [a-z0-9_-] 1..30 без повторов, доли 0..100, сумма ≤ 100")
)

// Flags — применение правил к флагам: Evaluate спрашивают гварды и
// кэш состояний API, List/Upsert/Delete/Revisions — админка,
// Report* — точки применения фичи (экспозиция/конверсия эксперимента).
type Flags struct {
	store domain.FlagStore
	stats domain.ExperimentStore
	now   func() time.Time // инъекция времени для тестов аудита
}

// New собирает сервис над хранилищем флагов и счётчиками метрик.
func New(store domain.FlagStore, stats domain.ExperimentStore) *Flags {
	return &Flags{store: store, stats: stats, now: time.Now}
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
// вызывающий (админка API передаёт юзера). Варианты — ПОЛНОЕ состояние:
// upsert перезаписывает список, не мерджит.
func (s *Flags) Upsert(ctx context.Context, f domain.Flag) (domain.Flag, error) {
	if !domain.ValidKey(f.Key) {
		return domain.Flag{}, ErrInvalidKey
	}
	if f.Percentage < 0 || f.Percentage > 100 {
		return domain.Flag{}, ErrInvalidPercent
	}
	if !domain.ValidVariants(f.Variants) {
		return domain.Flag{}, ErrInvalidVariants
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

// ReportExposure — засчитать показ точки применения фичи. Вариант
// вызывающий НЕ присылает: сервис пересчитывает его из того же
// детерминированного бакетинга, что и Evaluate, — назначения сущностей
// хранить не нужно, отчёт невозможно подделать чужим вариантом.
// not_found — не ошибка: counted=false, счётчики не тронуты.
func (s *Flags) ReportExposure(ctx context.Context, key, entityID string) (string, bool, error) {
	return s.report(ctx, key, entityID, false)
}

// ReportConversion — засчитать конверсию (бизнес-событие сущности
// после экспозиции): та же семантика, что у ReportExposure.
func (s *Flags) ReportConversion(ctx context.Context, key, entityID string) (string, bool, error) {
	return s.report(ctx, key, entityID, true)
}

// report — общая кухня отчётов: вердикт по текущему состоянию флага →
// вариант → счётчик. Обычные (не-эксперимент) флаги считают те же
// метрики в implicit-вариантах on/off — механика единая для всех
// тумблеров, «эксперимент» — лишь многовариантное расширение.
func (s *Flags) report(ctx context.Context, key, entityID string, conversion bool) (string, bool, error) {
	f, found, err := s.store.Get(ctx, key)
	if err != nil {
		return "", false, err
	}
	if !found {
		return "", false, nil
	}
	v := domain.Evaluate(f, entityID)
	variant := v.Variant
	if !f.IsExperiment() {
		if v.Enabled {
			variant = "on"
		} else {
			variant = "off"
		}
	}
	if err := s.stats.Add(ctx, key, variant, conversion); err != nil {
		return variant, false, err
	}
	return variant, true, nil
}

// ExperimentStats — таблица метрик для витрины: строка на (флаг,
// вариант), сортировка за адаптером-хранилищем.
func (s *Flags) ExperimentStats(ctx context.Context) ([]domain.VariantStat, error) {
	return s.stats.Stats(ctx)
}
