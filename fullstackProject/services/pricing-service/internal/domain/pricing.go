// Package domain — правила ценообразования Тарификатора: чистые
// функции без знания о транспортах и хранилищах.
package domain

import (
	"errors"
	"math"
	"time"
)

// Factor — слагаемое раскладки цены. Отсутствие фактора в ответе —
// множитель 1.0: раскладка показывает только то, что сработало.
type Factor struct {
	Code    string // машинное имя: evening, weekend, demand_full …
	Label   string // человекочитаемо: «вечерний прайм +20%»
	Percent int    // вклад фактора, %: −20 … +25
}

// Quote — расчёт цены одного места сеанса.
type Quote struct {
	BasePriceRub int      // базовая цена фильма из афиши
	PriceRub     int      // после факторов, кратно 10 ₽
	Factors      []Factor // что сработало, в порядке вычисления
	Occupied     int      // занятые места проекции спроса (после clamp)
	Capacity     int      // ёмкость зала
}

// QuoteRecord — проведённый расчёт для витрины (история квотов).
type QuoteRecord struct {
	SessionID    string
	BasePriceRub int
	PriceRub     int
	Factors      string // «evening+20%; weekend+10%» — компактная раскладка
	CreatedAt    time.Time
}

// DemandRecord — строка проекции спроса для витрины.
type DemandRecord struct {
	SessionID string
	Occupied  int
	UpdatedAt time.Time
}

var (
	// ErrInvalidQuote — запрос квота не проходит валидацию
	// (база ≤ 0, ёмкость ≤ 0, отрицательный спрос).
	ErrInvalidQuote = errors.New("некорректный запрос цены")
	// ErrInvalidDemandEvent — событие спроса без ключей или с нулевым
	// числом мест: обрабатывать нечего, ядовитое.
	ErrInvalidDemandEvent = errors.New("некорректное событие спроса")
)

// Пороги факторов. Часы — локальное время кинотеатра (TZ окружения:
// стенд задаёт Europe/Moscow в compose; зеркало на вебе считает
// в локальном времени браузера — на одном стенде это одинаковые часы).
const (
	// время суток: утро до 12 — скидка, вечер 17–23 — надбавка
	morningHourEnd = 12
	eveningHourBeg = 17
	nightHourBeg   = 23
	// спрос: доля занятых мест зала
	demandLowBelow  = 0.2 // меньше 20% — зал пустоват
	demandHighAbove = 0.5 // больше половины — спрос высокий
	demandFullAbove = 0.8 // больше 80% — аншлаг
)

// факторы времени суток: код, подпись, процент
func timeFactor(at time.Time) (Factor, bool) {
	h := at.Hour()
	switch {
	case h < morningHourEnd:
		return Factor{"morning", "утренний сеанс −20%", -20}, true
	case h >= eveningHourBeg && h < nightHourBeg:
		return Factor{"evening", "вечерний прайм +20%", +20}, true
	default:
		return Factor{}, false // день и поздняя ночь — базовый тариф
	}
}

// weekdayFactor — выходной (суббота, воскресенье) дорожает
func weekdayFactor(at time.Time) (Factor, bool) {
	wd := at.Weekday()
	if wd == time.Saturday || wd == time.Sunday {
		return Factor{"weekend", "выходной +10%", +10}, true
	}
	return Factor{}, false
}

// demandFactor —tier по доле занятых мест: аншлаг сильнее высокого
// спроса, пустой зал дешевле; середина (20–50%) — без фактора.
func demandFactor(occupied, capacity int) (Factor, bool) {
	share := float64(occupied) / float64(capacity)
	switch {
	case share >= demandFullAbove:
		return Factor{"demand_full", "аншлаг +25%", +25}, true
	case share >= demandHighAbove:
		return Factor{"demand_high", "спрос высокий +10%", +10}, true
	case share < demandLowBelow:
		return Factor{"demand_low", "зал почти пуст −10%", -10}, true
	default:
		return Factor{}, false
	}
}

// ComputeQuote — цена места: база × факторы, округление кратно 10 ₽.
// Чистая функция от входов: одинаковым входам — одинаковая цена,
// зеркало на вебе (shared/lib/pricing) считает так же.
func ComputeQuote(sessionAt time.Time, basePriceRub, occupied, capacity int) (Quote, error) {
	if basePriceRub <= 0 || capacity <= 0 {
		return Quote{}, ErrInvalidQuote
	}
	// проекция могла дрейфовать (потерянное событие) — зажимаем
	// в границы зала: доля спроса не выйдет за [0, 1]
	if occupied < 0 {
		occupied = 0
	}
	if occupied > capacity {
		occupied = capacity
	}

	local := sessionAt.In(time.Local)
	quote := Quote{
		BasePriceRub: basePriceRub,
		Occupied:     occupied,
		Capacity:     capacity,
		Factors:      []Factor{},
	}
	multiplier := 1.0
	apply := func(f Factor, ok bool) {
		if !ok {
			return
		}
		quote.Factors = append(quote.Factors, f)
		multiplier *= 1 + float64(f.Percent)/100
	}
	apply(timeFactor(local))
	apply(weekdayFactor(local))
	apply(demandFactor(occupied, capacity))
	quote.PriceRub = round10(float64(basePriceRub) * multiplier)
	return quote, nil
}

// round10 — цена места кратна десяти: монеты из афиши не возвращаются.
func round10(v float64) int {
	return int(math.Round(v/10) * 10)
}
