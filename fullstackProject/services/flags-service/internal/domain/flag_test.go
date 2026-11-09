package domain

import "testing"

// Векторы бакетинга зафиксированы генератором (cmd/vectors, удалён):
// одинаковые значения вшиты и в TS-зеркало apps/api/src/flags —
// дрейф алгоритма ломает тесты с обеих сторон, а не раскатку.
var vectorFlags = struct {
	key    string
	bucket map[string]int // entityID → бакет
}{
	key: "checkout.new_flow",
	bucket: map[string]int{
		"user-1": 99,
		"user-2": 10,
		"user-3": 21,
	},
}

func TestEvaluateKillSwitchWinsOverAll(t *testing.T) {
	f := Flag{Key: "checkout.new_flow", Enabled: true, Percentage: 100, Killed: true}
	for _, entity := range []string{"user-1", "user-2", "user-3"} {
		v := Evaluate(f, entity)
		if v.Enabled || v.Reason != ReasonKillSwitch {
			t.Fatalf("kill-switch обязан оффить всех: %s → %+v", entity, v)
		}
	}
}

func TestEvaluateDisabledFlag(t *testing.T) {
	f := Flag{Key: vectorFlags.key, Enabled: false, Percentage: 100}
	v := Evaluate(f, "user-1")
	if v.Enabled || v.Reason != ReasonFlagOff {
		t.Fatalf("выключенный тумблер — оф независимо от процента: %+v", v)
	}
	// kill-switch всё же приоритетнее мастер-тумблера
	f.Killed = true
	if v := Evaluate(f, "user-1"); v.Reason != ReasonKillSwitch {
		t.Fatalf("kill-switch приоритетнее flag_off: %+v", v)
	}
}

func TestEvaluateFullRolloutIsOn(t *testing.T) {
	f := Flag{Key: vectorFlags.key, Enabled: true, Percentage: 100}
	v := Evaluate(f, "user-1") // бакет 99 — даже хвостовой бакет внутри
	if !v.Enabled || v.Reason != ReasonOn {
		t.Fatalf("100%% — это «on» для всех: %+v", v)
	}
}

func TestEvaluatePercentageBucket(t *testing.T) {
	base := Flag{Key: vectorFlags.key, Enabled: true}

	// 15%: user-2 (бакет 10) внутри, user-3 (21) и user-1 (99) снаружи
	p15 := base
	p15.Percentage = 15
	if v := Evaluate(p15, "user-2"); !v.Enabled || v.Reason != ReasonPercentage {
		t.Fatalf("бакет 10 < 15 — фича видна: %+v", v)
	}
	for _, e := range []string{"user-3", "user-1"} {
		if v := Evaluate(p15, e); v.Enabled || v.Reason != ReasonPercentage {
			t.Fatalf("бакет %d ≥ 15 — фича скрыта: %+v", vectorFlags.bucket[e], v)
		}
	}

	// граница включительно: 22% накрывает бакет 21
	p22 := base
	p22.Percentage = 22
	if v := Evaluate(p22, "user-3"); !v.Enabled {
		t.Fatalf("бакет 21 < 22 — фича видна: %+v", v)
	}

	// 0% — никто: сам процент задаёт пустую раскатку
	p0 := base
	p0.Percentage = 0
	if v := Evaluate(p0, "user-2"); v.Enabled || v.Reason != ReasonPercentage {
		t.Fatalf("0%% — пустая раскатка: %+v", v)
	}
}

func TestEvaluateDeterministic(t *testing.T) {
	f := Flag{Key: vectorFlags.key, Enabled: true, Percentage: 50}
	first := Evaluate(f, "user-1")
	for i := 0; i < 100; i++ {
		if v := Evaluate(f, "user-1"); v != first {
			t.Fatalf("вердикт «мигает»: %+v против %+v", v, first)
		}
	}
}

// Бакеты векторов (user-1: 99, user-2: 10, user-3: 21) переиспользуем
// для вариантов: кумулятивные доли [0..p1) → первый, [p1..p1+p2) → второй.
func TestEvaluateExperimentVariants(t *testing.T) {
	base := Flag{
		Key:     vectorFlags.key,
		Enabled: true,
		Variants: []Variant{
			{Name: "a", Percentage: 15},
			{Name: "b", Percentage: 20}, // кумулятив: a [0..15), b [15..35)
		},
	}

	// user-2 (бакет 10) — в варианте a; user-3 (21) — в b (15..35)
	if v := Evaluate(base, "user-2"); !v.Enabled || v.Reason != ReasonVariant || v.Variant != "a" {
		t.Fatalf("бакет 10 < 15 — вариант a: %+v", v)
	}
	if v := Evaluate(base, "user-3"); !v.Enabled || v.Reason != ReasonVariant || v.Variant != "b" {
		t.Fatalf("бакет 21 ∈ [15..35) — вариант b: %+v", v)
	}
	// user-1 (99) за пределами суммы долей (35) — база, фича скрыта
	if v := Evaluate(base, "user-1"); v.Enabled || v.Reason != ReasonBase || v.Variant != "" {
		t.Fatalf("бакет 99 ≥ 35 — база: %+v", v)
	}

	// детерминизм распределения: сущность не перелетает между вариантами
	first := Evaluate(base, "user-2")
	for i := 0; i < 100; i++ {
		if v := Evaluate(base, "user-2"); v != first {
			t.Fatalf("вариант «мигает»: %+v против %+v", v, first)
		}
	}
}

func TestEvaluateExperimentToggles(t *testing.T) {
	exp := Flag{
		Key:     vectorFlags.key,
		Enabled: true,
		Variants: []Variant{
			{Name: "a", Percentage: 50},
			{Name: "b", Percentage: 50},
		},
	}

	// kill-switch приоритетнее вариантов: всем база, без варианта
	killed := exp
	killed.Killed = true
	for _, e := range []string{"user-1", "user-2", "user-3"} {
		if v := Evaluate(killed, e); v.Enabled || v.Reason != ReasonKillSwitch || v.Variant != "" {
			t.Fatalf("kill-switch гасит эксперимент: %s → %+v", e, v)
		}
	}

	// мастер-тумблер: пауза эксперимента — всем база
	paused := exp
	paused.Enabled = false
	if v := Evaluate(paused, "user-2"); v.Enabled || v.Reason != ReasonFlagOff || v.Variant != "" {
		t.Fatalf("пауза эксперимента — база: %+v", v)
	}

	// вариант с долей 0 не получает трафика: a=0, b=50 — бакет 10 идёт в b
	zero := Flag{
		Key:     vectorFlags.key,
		Enabled: true,
		Variants: []Variant{
			{Name: "a", Percentage: 0},
			{Name: "b", Percentage: 50},
		},
	}
	if v := Evaluate(zero, "user-2"); v.Variant != "b" {
		t.Fatalf("нулевая доля — без трафика: %+v", v)
	}

	// сумма долей 100 — базы нет, каждый в каком-то варианте
	full := exp
	for _, e := range []string{"user-1", "user-2", "user-3"} {
		if v := Evaluate(full, e); !v.Enabled || v.Variant == "" {
			t.Fatalf("полный эксперимент — все в вариантах: %s → %+v", e, v)
		}
	}
}

func TestValidVariants(t *testing.T) {
	// пустой список — обычный флаг, валиден
	if !ValidVariants(nil) || !ValidVariants([]Variant{}) {
		t.Fatalf("без вариантов — обычный флаг")
	}
	good := []Variant{
		{Name: "a", Percentage: 50},
		{Name: "b", Percentage: 49},
	}
	if !ValidVariants(good) {
		t.Fatalf("сумма 99 ≤ 100 — валидно (1%% — базе)")
	}
	full := []Variant{
		{Name: "control", Percentage: 50},
		{Name: "treatment", Percentage: 50},
	}
	if !ValidVariants(full) {
		t.Fatalf("сумма ровно 100 — валидно")
	}

	bad := [][]Variant{
		{{Name: "a", Percentage: 60}, {Name: "b", Percentage: 50}},    // сумма 110
		{{Name: "a", Percentage: 50}, {Name: "a", Percentage: 30}},    // повтор имени
		{{Name: "A", Percentage: 50}},                                 // заглавные
		{{Name: "вариант", Percentage: 50}},                           // не латиница
		{{Name: "", Percentage: 50}},                                  // пустое имя
		{{Name: "way-too-long-variant-name-over-30", Percentage: 50}}, // длина
		{{Name: "a", Percentage: 101}},                                // доля вне 0..100
		{{Name: "a", Percentage: -1}},                                 // отрицательная доля
	}
	for _, vs := range bad {
		if ValidVariants(vs) {
			t.Fatalf("ожидали невалидные варианты %+v", vs)
		}
	}
}

func TestValidVariantName(t *testing.T) {
	good := []string{"a", "b2", "control", "with-dash", "under_score"}
	for _, n := range good {
		if !ValidVariantName(n) {
			t.Fatalf("ожидали валидное имя %q", n)
		}
	}
	bad := []string{"", "A", "имя", "с пробелом", "точка.нельзя"}
	for _, n := range bad {
		if ValidVariantName(n) {
			t.Fatalf("ожидали невалидное имя %q", n)
		}
	}
	long := make([]byte, 31)
	for i := range long {
		long[i] = 'a'
	}
	if ValidVariantName(string(long)) {
		t.Fatalf("31 символ — за пределом")
	}
}

func TestValidKey(t *testing.T) {
	good := []string{"a", "checkout.new_flow", "demo.audience", "booking.qr-v2", "x_1"}
	for _, k := range good {
		if !ValidKey(k) {
			t.Fatalf("ожидали валидный ключ %q", k)
		}
	}
	bad := []string{
		"",                          // пустой
		"Checkout.New",              // заглавные
		"ключ",                      // не латиница
		"checkout new",              // пробел
		"checkout/new",              // слэш
		"checkout.new_flow?query=1", // мусор
	}
	for _, k := range bad {
		if ValidKey(k) {
			t.Fatalf("ожидали невалидный ключ %q", k)
		}
	}
	// длина: 100 ок, 101 нет (рядом одинаковых букв)
	long := make([]byte, 101)
	ok := make([]byte, 100)
	for i := range long {
		long[i] = 'a'
	}
	for i := range ok {
		ok[i] = 'a'
	}
	if ValidKey(string(long)) {
		t.Fatalf("101 символ — за пределом")
	}
	if !ValidKey(string(ok)) {
		t.Fatalf("100 символов — допустимо")
	}
}
