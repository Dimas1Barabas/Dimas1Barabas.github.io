package domain

import (
	"errors"
	"testing"
	"time"
)

// Векторы правил: те же входы-выходы продублированы зеркалом на вебе
// (apps/web/src/shared/lib/pricing.spec.ts) — векторы сверены, чтобы
// демо-движок и Go-сервис не расходились в цене ни на рубль.

// at — момент в локальном времени кинотеатра (правила считают часы
// и дни недели в нём; тесты строят входы в том же поясе).
func at(y int, m time.Month, d, h int) time.Time {
	return time.Date(y, m, d, h, 0, 0, 0, time.Local)
}

func TestComputeQuoteTable(t *testing.T) {
	// вторник 2026-09-22 (будний), суббота 2026-09-26, воскресенье 2026-09-27
	cases := []struct {
		name     string
		session  time.Time
		base     int
		occupied int
		capacity int
		want     int
		codes    []string
	}{
		{
			name: "день буднего без спроса — база", session: at(2026, time.September, 22, 14),
			base: 400, occupied: 30, capacity: 80, // 37% — середина, факторов нет
			want: 400, codes: []string{},
		},
		{
			name: "утро буднего — скидка 20%", session: at(2026, time.September, 22, 10),
			base: 400, occupied: 30, capacity: 80,
			want: 320, codes: []string{"morning"},
		},
		{
			name: "вечер буднего — надбавка 20%", session: at(2026, time.September, 22, 19),
			base: 400, occupied: 30, capacity: 80,
			want: 480, codes: []string{"evening"},
		},
		{
			name: "ночь после 23 — база", session: at(2026, time.September, 22, 23),
			base: 400, occupied: 30, capacity: 80,
			want: 400, codes: []string{},
		},
		{
			name: "выходной день — надбавка 10%", session: at(2026, time.September, 26, 14),
			base: 400, occupied: 30, capacity: 80,
			want: 440, codes: []string{"weekend"},
		},
		{
			name: "вечер выходного — оба фактора", session: at(2026, time.September, 26, 19),
			base: 400, occupied: 30, capacity: 80,
			want: round10(400 * 1.2 * 1.1), codes: []string{"evening", "weekend"},
		},
		{
			name: "аншлаг — 25% (сильнее высокого спроса)", session: at(2026, time.September, 22, 14),
			base: 400, occupied: 70, capacity: 80, // 87%
			want: 500, codes: []string{"demand_full"},
		},
		{
			name: "высокий спрос — 10%", session: at(2026, time.September, 22, 14),
			base: 400, occupied: 45, capacity: 80, // 56%
			want: 440, codes: []string{"demand_high"},
		},
		{
			name: "зал почти пуст — 10% скидка", session: at(2026, time.September, 22, 14),
			base: 400, occupied: 10, capacity: 80, // 12%
			want: 360, codes: []string{"demand_low"},
		},
		{
			name: "граница низкого спроса — 20% ровно, фактора нет", session: at(2026, time.September, 22, 14),
			base: 400, occupied: 16, capacity: 80,
			want: 400, codes: []string{},
		},
		{
			name: "полный фарш: вечер субботы аншлаг", session: at(2026, time.September, 26, 19),
			base: 450, occupied: 80, capacity: 80,
			want: round10(450 * 1.2 * 1.1 * 1.25), codes: []string{"evening", "weekend", "demand_full"},
		},
		{
			name: "округление кратно 10", session: at(2026, time.September, 22, 14),
			base: 335, occupied: 30, capacity: 80, // 335 без факторов → 340
			want: 340, codes: []string{},
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			q, err := ComputeQuote(tc.session, tc.base, tc.occupied, tc.capacity)
			if err != nil {
				t.Fatal(err)
			}
			if q.PriceRub != tc.want {
				t.Fatalf("price = %d, want %d", q.PriceRub, tc.want)
			}
			got := make([]string, 0, len(q.Factors))
			for _, f := range q.Factors {
				got = append(got, f.Code)
			}
			if len(got) != len(tc.codes) {
				t.Fatalf("факторы = %v, want %v", got, tc.codes)
			}
			for i := range got {
				if got[i] != tc.codes[i] {
					t.Fatalf("факторы = %v, want %v", got, tc.codes)
				}
			}
		})
	}
}

func TestComputeQuoteClampsOvershoot(t *testing.T) {
	// проекция задрейфовала за ёмкость — доля зажимается в [0, 1]
	q, err := ComputeQuote(at(2026, time.September, 22, 14), 400, 120, 80)
	if err != nil {
		t.Fatal(err)
	}
	if q.Occupied != 80 {
		t.Fatalf("occupied = %d, want 80 (clamp)", q.Occupied)
	}
	q, err = ComputeQuote(at(2026, time.September, 22, 14), 400, -5, 80)
	if err != nil {
		t.Fatal(err)
	}
	if q.Occupied != 0 {
		t.Fatalf("occupied = %d, want 0 (clamp)", q.Occupied)
	}
	// отрицательный спрос оценивается как пустой зал
	if len(q.Factors) != 1 || q.Factors[0].Code != "demand_low" {
		t.Fatalf("факторы = %v, want [demand_low]", q.Factors)
	}
}

func TestComputeQuoteValidation(t *testing.T) {
	for _, tc := range []struct {
		name           string
		base, occ, cap int
	}{
		{"база нулевая", 0, 10, 80},
		{"база отрицательная", -400, 10, 80},
		{"ёмкость нулевая", 400, 10, 0},
		{"ёмкость отрицательная", 400, 10, -80},
	} {
		t.Run(tc.name, func(t *testing.T) {
			if _, err := ComputeQuote(at(2026, time.September, 22, 14), tc.base, tc.occ, tc.cap); !errors.Is(err, ErrInvalidQuote) {
				t.Fatalf("err = %v, want ErrInvalidQuote", err)
			}
		})
	}
}

func TestTimeFactorUsesSessionLocation(t *testing.T) {
	// 19:00 локальное = 16:00 UTC: правило смотрит на часы кинотеатра,
	// а не на часы точки, где случился запрос
	utc := at(2026, time.September, 22, 19).UTC()
	q, err := ComputeQuote(utc, 400, 30, 80)
	if err != nil {
		t.Fatal(err)
	}
	if len(q.Factors) != 1 || q.Factors[0].Code != "evening" {
		t.Fatalf("факторы = %v, want [evening] — локальные часы сеанса", q.Factors)
	}
}

func TestRound10(t *testing.T) {
	for _, tc := range []struct {
		in   float64
		want int
	}{{334, 330}, {335, 340}, {345, 350}, {0, 0}, {5, 10}, {472.5, 470}} {
		if got := round10(tc.in); got != tc.want {
			t.Fatalf("round10(%v) = %d, want %d", tc.in, got, tc.want)
		}
	}
}

func TestComputeQuoteLoyalty(t *testing.T) {
	t.Run("Киноман: аншлаг не дорожает, раскладка объясняет", func(t *testing.T) {
		// 87% занятости анонимно = demand_full +25% (500); уровень 2
		// гасит надбавку — цена базовая, вместо надбавки фактор loyalty
		q, err := ComputeQuoteLoyalty(at(2026, time.September, 22, 14), 400, 70, 80, 2)
		if err != nil {
			t.Fatal(err)
		}
		if q.PriceRub != 400 {
			t.Fatalf("цена = %d, want 400 — надбавка аншлага погашена", q.PriceRub)
		}
		if len(q.Factors) != 1 || q.Factors[0].Code != "loyalty" || q.Factors[0].Percent != 0 {
			t.Fatalf("факторы = %v, want [loyalty 0 процент]", q.Factors)
		}
	})

	t.Run("Легенда: высокий спрос не дорожает, пустой зал дешевеет", func(t *testing.T) {
		q, err := ComputeQuoteLoyalty(at(2026, time.September, 22, 14), 400, 45, 80, 3)
		if err != nil {
			t.Fatal(err)
		}
		if q.PriceRub != 400 || len(q.Factors) != 1 || q.Factors[0].Code != "loyalty" {
			t.Fatalf("цена/факторы = %d/%v", q.PriceRub, q.Factors)
		}
		// отрицательный фактор уровня не трогает: скидка пустого зала действует
		q2, err := ComputeQuoteLoyalty(at(2026, time.September, 22, 14), 400, 10, 80, 3)
		if err != nil {
			t.Fatal(err)
		}
		if q2.PriceRub != 360 || q2.Factors[0].Code != "demand_low" {
			t.Fatalf("цена/факторы = %d/%v, want 360/[demand_low]", q2.PriceRub, q2.Factors)
		}
	})

	t.Run("Зритель (tier 1) платит как все — перк только с Киномана", func(t *testing.T) {
		q, err := ComputeQuoteLoyalty(at(2026, time.September, 22, 14), 400, 70, 80, 1)
		if err != nil {
			t.Fatal(err)
		}
		if q.PriceRub != 500 || len(q.Factors) != 1 || q.Factors[0].Code != "demand_full" {
			t.Fatalf("цена/факторы = %d/%v, want 500/[demand_full]", q.PriceRub, q.Factors)
		}
	})

	t.Run("время и выходные уровня не касаются", func(t *testing.T) {
		// вечер субботы с аншлагом: с-level гасит только спрос
		q, err := ComputeQuoteLoyalty(at(2026, time.September, 26, 19), 450, 80, 80, 2)
		if err != nil {
			t.Fatal(err)
		}
		want := round10(450 * 1.2 * 1.1)
		if q.PriceRub != want {
			t.Fatalf("цена = %d, want %d (вечер+выходной без спроса)", q.PriceRub, want)
		}
		codes := make([]string, 0, len(q.Factors))
		for _, f := range q.Factors {
			codes = append(codes, f.Code)
		}
		if len(codes) != 3 || codes[2] != "loyalty" {
			t.Fatalf("факторы = %v, want [evening weekend loyalty]", codes)
		}
	})

	t.Run("ComputeQuote без уровня — прежняя анонимная цена", func(t *testing.T) {
		q, err := ComputeQuote(at(2026, time.September, 22, 14), 400, 70, 80)
		if err != nil {
			t.Fatal(err)
		}
		if q.PriceRub != 500 || q.Factors[0].Code != "demand_full" {
			t.Fatalf("цена/факторы = %d/%v — анонимный витринный путь не изменился", q.PriceRub, q.Factors)
		}
	})
}
