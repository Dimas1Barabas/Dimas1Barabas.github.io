// Package domain — флаги фич и их вердикты: чистые правила «Суфлёра»
// без знания о транспортах и хранилище.
package domain

import "time"

// Flag — тумблер фичи: состояние раскатки и последняя правка.
type Flag struct {
	Key         string    // идентификатор: checkout.new_flow
	Description string    // что за фича, человеком
	Enabled     bool      // мастер-тумблер: пауза раскатки без потери процента
	Percentage  int       // доля сущностей, которым фича видна: 0..100
	Killed      bool      // kill-switch: мгновенный оф всем, приоритет над всем
	UpdatedBy   string    // автор последней правки: админ/система
	UpdatedAt   time.Time // момент последней правки
}

// Reason — какое правило вынесло вердикт.
type Reason string

const (
	ReasonOn         Reason = "on"          // флаг полностью включён (100%)
	ReasonPercentage Reason = "percentage"  // вердикт решил бакет раскатки (enabled — попал/нет)
	ReasonFlagOff    Reason = "flag_off"    // мастер-тумблер выключен
	ReasonKillSwitch Reason = "kill_switch" // аварийный оф поверх любых настроек
	ReasonNotFound   Reason = "not_found"   // флага нет — скрыта по умолчанию
)

// Verdict — решение Evaluate для одной сущности.
type Verdict struct {
	Enabled    bool
	Reason     Reason
	Percentage int // текущий процент флага на момент вердикта
}

// Evaluate — чистая функция вердикта: какое правило сработало первым,
// то и решило. Порядок: kill-switch → мастер-тумблер → бакет раскатки;
// процент 100 — это «on», бакет всегда попадает. Детерминирована:
// одинаковая пара (флаг, сущность) всегда даёт одинаковый вердикт —
// «мигание» фича-вердикта между запросами исключено.
func Evaluate(f Flag, entityID string) Verdict {
	switch {
	case f.Killed:
		return Verdict{Enabled: false, Reason: ReasonKillSwitch, Percentage: f.Percentage}
	case !f.Enabled:
		return Verdict{Enabled: false, Reason: ReasonFlagOff, Percentage: f.Percentage}
	case f.Percentage >= 100:
		return Verdict{Enabled: true, Reason: ReasonOn, Percentage: 100}
	}
	return Verdict{
		Enabled:    Bucket(f.Key, entityID) < f.Percentage,
		Reason:     ReasonPercentage,
		Percentage: f.Percentage,
	}
}

// ValidKey — алфавит ключа флага: строчные буквы, цифры, точка,
// подчёркивание, дефис (checkout.new_flow), длина 1..100. Строгий
// алфавит делает флаг предсказуемым идентификатором в логах, метриках
// и URL админки; ключи-«случайные строки» запрещаем на входе.
func ValidKey(key string) bool {
	if key == "" || len(key) > 100 {
		return false
	}
	for _, r := range key {
		switch {
		case r >= 'a' && r <= 'z', r >= '0' && r <= '9', r == '.', r == '_', r == '-':
		default:
			return false
		}
	}
	return true
}
