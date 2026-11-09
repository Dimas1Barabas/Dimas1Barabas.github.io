// Package domain — флаги фич и их вердикты: чистые правила «Суфлёра»
// без знания о транспортах и хранилище.
package domain

import "time"

// Flag — тумблер фичи: состояние раскатки и последняя правка.
// Непустой Variants превращает флаг в A/B-эксперимент: трафик делят
// именованные варианты с кумулятивными долями, остаток — «база»
// (контрольный опыт без фичи); percentage в эксперименте не участвует.
type Flag struct {
	Key         string    // идентификатор: checkout.new_flow
	Description string    // что за фича, человеком
	Enabled     bool      // мастер-тумблер: пауза раскатки без потери процента
	Percentage  int       // доля сущностей, которым фича видна: 0..100
	Killed      bool      // kill-switch: мгновенный оф всем, приоритет над всем
	Variants    []Variant // варианты A/B-эксперимента (пусто — обычный флаг)
	UpdatedBy   string    // автор последней правки: админ/система
	UpdatedAt   time.Time // момент последней правки
}

// Variant — вариант A/B-эксперимента: имя и доля трафика. Бакет
// сущности [0..100) падает в вариант по кумулятивной сумме долей:
// [0..p1) → первый, [p1..p1+p2) → второй, … остаток — база.
type Variant struct {
	Name       string
	Percentage int
}

// Reason — какое правило вынесло вердикт.
type Reason string

const (
	ReasonOn         Reason = "on"          // флаг полностью включён (100%)
	ReasonPercentage Reason = "percentage"  // вердикт решил бакет раскатки (enabled — попал/нет)
	ReasonVariant    Reason = "variant"     // эксперимент: сущность распределена в именованный вариант
	ReasonBase       Reason = "base"        // эксперимент: сущность в остатке трафика — база (контроль)
	ReasonFlagOff    Reason = "flag_off"    // мастер-тумблер выключен
	ReasonKillSwitch Reason = "kill_switch" // аварийный оф поверх любых настроек
	ReasonNotFound   Reason = "not_found"   // флага нет — скрыта по умолчанию
)

// Verdict — решение Evaluate для одной сущности.
type Verdict struct {
	Enabled    bool
	Reason     Reason
	Percentage int    // текущий процент флага на момент вердикта
	Variant    string // вариант эксперимента сущности (пустой = база / не-эксперимент)
}

// Evaluate — чистая функция вердикта: какое правило сработало первым,
// то и решило. Порядок: kill-switch → мастер-тумблер → эксперимент
// (варианты) → бакет раскатки; процент 100 — это «on», бакет всегда
// попадает. Детерминирована: одинаковая пара (флаг, сущность) всегда
// даёт одинаковый вердикт — «мигание» фича-вердикта и перелёты
// сущности между вариантами между запросами исключены.
func Evaluate(f Flag, entityID string) Verdict {
	switch {
	case f.Killed:
		return Verdict{Enabled: false, Reason: ReasonKillSwitch, Percentage: f.Percentage}
	case !f.Enabled:
		return Verdict{Enabled: false, Reason: ReasonFlagOff, Percentage: f.Percentage}
	case len(f.Variants) > 0:
		return evaluateVariant(f, entityID)
	case f.Percentage >= 100:
		return Verdict{Enabled: true, Reason: ReasonOn, Percentage: 100}
	}
	return Verdict{
		Enabled:    Bucket(f.Key, entityID) < f.Percentage,
		Reason:     ReasonPercentage,
		Percentage: f.Percentage,
	}
}

// evaluateVariant — распределение сущности по варианту эксперимента:
// бакет [0..100) сравнивается с кумулятивными суммами долей. Вариант
// с долей 0 не получает трафика; сущности за пределами суммы долей —
// база: фича скрыта, гвард ответит как «вне раскатки».
func evaluateVariant(f Flag, entityID string) Verdict {
	b := Bucket(f.Key, entityID)
	cum := 0
	for _, v := range f.Variants {
		cum += v.Percentage
		if b < cum {
			return Verdict{Enabled: true, Reason: ReasonVariant, Variant: v.Name}
		}
	}
	return Verdict{Enabled: false, Reason: ReasonBase}
}

// IsExperiment — флаг является A/B-экспериментом (есть варианты).
func (f Flag) IsExperiment() bool { return len(f.Variants) > 0 }

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

// ValidVariantName — алфавит имени варианта: [a-z0-9_-], 1..30.
// Те же мотивы, что у ValidKey: имя попадает в метрики и витрину.
func ValidVariantName(name string) bool {
	if name == "" || len(name) > 30 {
		return false
	}
	for _, r := range name {
		switch {
		case r >= 'a' && r <= 'z', r >= '0' && r <= '9', r == '_', r == '-':
		default:
			return false
		}
	}
	return true
}

// ValidVariants — правила списка вариантов: пустой список — обычный
// флаг (валиден); дальше имена в алфавите и без повторов, доли 0..100,
// сумма ≤ 100 — остаток трафика достаётся базе.
func ValidVariants(vs []Variant) bool {
	if len(vs) == 0 {
		return true
	}
	seen := make(map[string]bool, len(vs))
	sum := 0
	for _, v := range vs {
		if !ValidVariantName(v.Name) || seen[v.Name] {
			return false
		}
		seen[v.Name] = true
		if v.Percentage < 0 || v.Percentage > 100 {
			return false
		}
		sum += v.Percentage
	}
	return sum <= 100
}
