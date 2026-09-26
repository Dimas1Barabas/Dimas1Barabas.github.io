package domain

import "errors"

// Action — лимитируемое действие API. Строка ездит в gRPC-контракте
// как есть: таблица политик здесь, вызывающий знает только имя.
type Action string

const (
	ActionBookingsCreate Action = "bookings.create"
	ActionAuthLogin      Action = "auth.login"
)

// ErrUnknownAction — действие вне таблицы политик: конфигурационная
// ошибка вызывающего, а не сбой хранилища (не повод для fail-open).
var ErrUnknownAction = errors.New("неизвестное действие")

// Policy — параметры корзины действия: burst-ёмкость и равномерный
// долив. «N в минуту» = ёмкость N, долив N/60 в секунду: первый визит
// может потратить весь минутный запас разом, дальше — темп долива.
type Policy struct {
	Capacity     float64
	RefillPerSec float64
	LimitPerMin  int // для витрины и ответа вызывающему
}

// PolicyOf — политика из предела в минуту.
func PolicyOf(limitPerMin int) Policy {
	return Policy{
		Capacity:     float64(limitPerMin),
		RefillPerSec: float64(limitPerMin) / 60,
		LimitPerMin:  limitPerMin,
	}
}
