package domain

// Thresholds — пороги вердиктов: скор ниже review — allow, между review
// и block — очередь ревью, от block — отказ. Пороги задаёт окружение
// стенда (в тест-стенде можно сузить), веса правил — код: меняются реже
// и проверяются векторами.
type Thresholds struct {
	Review int
	Block  int
}

// rule — один сигнал риска: код (уезжает вызывающему), вес и предикат.
// Веса подобраны так, чтобы:
//   - свежий счёт с одной-двумя бронями (обычный зритель) — allow;
//   - свежий счёт, заказавший 5+ броней подряд, — review;
//   - свежий счёт с 10+ бронями и крупным заказом — block.
type rule struct {
	code   string
	weight int
	fired  func(f Facts) bool
}

var rules = []rule{
	{"newAccount", 30, func(f Facts) bool { return f.AccountAgeDays < 1 }},
	{"velocity", 25, func(f Facts) bool { return f.Bookings24h >= 5 && f.Bookings24h < 10 }},
	{"velocityHigh", 35, func(f Facts) bool { return f.Bookings24h >= 10 }},
	{"cancelAbuse", 20, func(f Facts) bool { return f.Cancels24h >= 3 }},
	{"failedPayments", 15, func(f Facts) bool { return f.Failed24h >= 3 }},
	{"bigCheck", 20, func(f Facts) bool { return f.TotalRub >= 15000 }},
	{"manySeats", 10, func(f Facts) bool { return f.SeatsCount >= 6 }},
	// безупречная история — скидка риска: скор не уходит в минус
	{"trusted", -15, func(f Facts) bool { return f.AccountAgeDays >= 180 }},
}

// Score — сумма весов сработавших правил (не ниже нуля) и вердикт по
// порогам. Чистая функция: один срез фактов даёт одно решение.
// Зеркало живёт в демо-режиме витрины (apps/web shared/lib/fraud) —
// векторы совпадают.
func Score(f Facts, t Thresholds) Decision {
	score := 0
	reasons := make([]string, 0, len(rules))
	for _, r := range rules {
		if r.fired(f) {
			score += r.weight
			reasons = append(reasons, r.code)
		}
	}
	if score < 0 {
		score = 0 // trusted не уводит скор в минус — ниже allow не бывает
	}
	return Decision{Facts: f, Score: score, Verdict: verdictOf(score, t), Reasons: reasons}
}

func verdictOf(score int, t Thresholds) Verdict {
	switch {
	case score >= t.Block:
		return VerdictBlock
	case score >= t.Review:
		return VerdictReview
	default:
		return VerdictAllow
	}
}

// StatusOf — стартовый статус решения в витрине: автоматические
// вердикты закрываются сразу, review ждёт человека.
func StatusOf(v Verdict) Status {
	switch v {
	case VerdictBlock:
		return StatusAutoBlocked
	case VerdictReview:
		return StatusPendingReview
	default:
		return StatusAutoAllowed
	}
}

// ResolveStatus — статус после решения человека.
func ResolveStatus(a ResolveAction) (Status, error) {
	switch a {
	case ResolveApprove:
		return StatusApproved, nil
	case ResolveReject:
		return StatusRejected, nil
	default:
		return "", ErrUnknownResolveAction
	}
}
