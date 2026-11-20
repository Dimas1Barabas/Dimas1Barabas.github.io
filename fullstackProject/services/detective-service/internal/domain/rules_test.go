package domain

import (
	"reflect"
	"testing"
)

// дефолтные пороги — как в конфиге: review от 40, block от 70
var t40 = Thresholds{Review: 40, Block: 70}

func base() Facts {
	// спокойный покупатель: счёт месяц, покупает впервые
	return Facts{
		BookingID:      "b-1",
		UserID:         "u-1",
		SessionID:      "s-1",
		SeatsCount:     2,
		TotalRub:       800,
		AccountAgeDays: 30,
		Bookings24h:    0,
		Cancels24h:     0,
		Failed24h:      0,
	}
}

// Векторы скоринга. Зеркало этих чисел обязано совпадать с демо-режимом
// витрины (apps/web shared/lib/fraud) — там свой набор тех же векторов.
func TestScoreVectors(t *testing.T) {
	cases := []struct {
		name    string
		mutate  func(f *Facts)
		score   int
		verdict Verdict
		reasons []string
	}{
		{
			name:    "спокойный покупатель — allow без вопросов",
			mutate:  func(f *Facts) {},
			score:   0,
			verdict: VerdictAllow,
			reasons: []string{},
		},
		{
			name: "новый счёт, одна бронь — allow (не дотягивает до review)",
			mutate: func(f *Facts) {
				f.AccountAgeDays = 0
			},
			score:   30,
			verdict: VerdictAllow,
			reasons: []string{"newAccount"},
		},
		{
			name: "ветеран — скидка риска не уводит скор в минус",
			mutate: func(f *Facts) {
				f.AccountAgeDays = 200
			},
			score:   0,
			verdict: VerdictAllow,
			reasons: []string{"trusted"},
		},
		{
			name: "новый счёт пилит брони — review",
			mutate: func(f *Facts) {
				f.AccountAgeDays = 0
				f.Bookings24h = 5
			},
			score:   55,
			verdict: VerdictReview,
			reasons: []string{"newAccount", "velocity"},
		},
		{
			name: "конвейер 10+ броней и куча мест — block",
			mutate: func(f *Facts) {
				f.AccountAgeDays = 0
				f.Bookings24h = 10
				f.SeatsCount = 6
			},
			score:   75,
			verdict: VerdictBlock,
			reasons: []string{"newAccount", "velocityHigh", "manySeats"},
		},
		{
			name: "большой чек — ровно на пороге правила",
			mutate: func(f *Facts) {
				f.TotalRub = 15000
			},
			score:   20,
			verdict: VerdictAllow,
			reasons: []string{"bigCheck"},
		},
		{
			name: "ветеран скупает ползала — большой чек и много мест гасят скидку",
			mutate: func(f *Facts) {
				f.AccountAgeDays = 365
				f.TotalRub = 20000
				f.SeatsCount = 8
			},
			score:   15,
			verdict: VerdictAllow,
			reasons: []string{"bigCheck", "manySeats", "trusted"},
		},
		{
			name: "шторм отмен и отказов оплаты — review без нового счёта",
			mutate: func(f *Facts) {
				f.Cancels24h = 3
				f.Failed24h = 3
			},
			score:   35,
			verdict: VerdictAllow,
			reasons: []string{"cancelAbuse", "failedPayments"},
		},
		{
			name: "новый счёт со штормом отмен — block через сумму рисков",
			mutate: func(f *Facts) {
				f.AccountAgeDays = 0
				f.Cancels24h = 3
				f.Failed24h = 3
				f.TotalRub = 16000
			},
			score:   85,
			verdict: VerdictBlock,
			reasons: []string{"newAccount", "cancelAbuse", "failedPayments", "bigCheck"},
		},
		{
			name: "9 броней — ещё velocity, не velocityHigh",
			mutate: func(f *Facts) {
				f.Bookings24h = 9
			},
			score:   25,
			verdict: VerdictAllow,
			reasons: []string{"velocity"},
		},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			f := base()
			tc.mutate(&f)
			got := Score(f, t40)
			if got.Score != tc.score {
				t.Errorf("score = %d, хочу %d", got.Score, tc.score)
			}
			if got.Verdict != tc.verdict {
				t.Errorf("verdict = %s, хочу %s", got.Verdict, tc.verdict)
			}
			if len(tc.reasons) == 0 {
				if len(got.Reasons) != 0 {
					t.Errorf("reasons = %v, хочу пусто", got.Reasons)
				}
				return
			}
			if !reflect.DeepEqual(got.Reasons, tc.reasons) {
				t.Errorf("reasons = %v, хочу %v", got.Reasons, tc.reasons)
			}
		})
	}
}

// пороги — конфигурация: с узкими порогами тот же скор меняет вердикт
func TestThresholdsChangeVerdict(t *testing.T) {
	f := Facts{AccountAgeDays: 30, TotalRub: 15000} // score 20
	if got := Score(f, t40).Verdict; got != VerdictAllow {
		t.Fatalf("verdict = %s, хочу allow", got)
	}
	narrow := Thresholds{Review: 10, Block: 100}
	if got := Score(f, narrow).Verdict; got != VerdictReview {
		t.Fatalf("узкий review-порог: verdict = %s, хочу review", got)
	}
}

// Score детерминирован: один срез фактов — одно и то же решение
func TestScoreDeterministic(t *testing.T) {
	f := base()
	f.AccountAgeDays = 0
	f.Bookings24h = 5
	first := Score(f, t40)
	for i := 0; i < 10; i++ {
		got := Score(f, t40)
		// Decision содержит слайс — сравниваем поля поодиночке
		if got.Score != first.Score || got.Verdict != first.Verdict ||
			!reflect.DeepEqual(got.Reasons, first.Reasons) {
			t.Fatalf("итерация %d: решение дрейфует: %+v", i, got)
		}
	}
}

func TestStatusOf(t *testing.T) {
	cases := map[Verdict]Status{
		VerdictAllow:  StatusAutoAllowed,
		VerdictReview: StatusPendingReview,
		VerdictBlock:  StatusAutoBlocked,
	}
	for v, want := range cases {
		if got := StatusOf(v); got != want {
			t.Errorf("StatusOf(%s) = %s, хочу %s", v, got, want)
		}
	}
}

func TestResolveStatus(t *testing.T) {
	if got, _ := ResolveStatus(ResolveApprove); got != StatusApproved {
		t.Errorf("approve = %s, хочу %s", got, StatusApproved)
	}
	if got, _ := ResolveStatus(ResolveReject); got != StatusRejected {
		t.Errorf("reject = %s, хочу %s", got, StatusRejected)
	}
	if _, err := ResolveStatus(ResolveAction("соглашаться")); err != ErrUnknownResolveAction {
		t.Errorf("мусорное действие: err = %v, хочу ErrUnknownResolveAction", err)
	}
}
