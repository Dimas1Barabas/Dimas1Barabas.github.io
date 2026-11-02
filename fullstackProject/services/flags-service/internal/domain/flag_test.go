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
