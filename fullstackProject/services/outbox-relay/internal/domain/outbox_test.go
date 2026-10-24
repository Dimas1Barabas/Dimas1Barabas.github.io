package domain

import (
	"testing"
	"time"
)

func TestNextDelay(t *testing.T) {
	const capDelay = time.Minute
	cases := []struct {
		attempts int
		want     time.Duration
	}{
		{0, 500 * time.Millisecond}, // <1 нормализуется: первая неудача
		{1, 500 * time.Millisecond},
		{2, time.Second},
		{3, 2 * time.Second},
		{4, 4 * time.Second},
		{7, 32 * time.Second},
		{8, capDelay},   // 64с > кэпа
		{100, capDelay}, // сдвиг переполнился — кэп
	}
	for _, c := range cases {
		if got := NextDelay(c.attempts, capDelay); got != c.want {
			t.Errorf("NextDelay(%d) = %v, хочу %v", c.attempts, got, c.want)
		}
	}
}

func TestNextDelayCapEdge(t *testing.T) {
	// кэп ровно между шагами экспоненты не должен ломать монотонность
	if got := NextDelay(3, 1500*time.Millisecond); got != 1500*time.Millisecond {
		t.Errorf("NextDelay(3, 1.5s) = %v, хочу кэп 1.5s", got)
	}
	if got := NextDelay(2, 1500*time.Millisecond); got != time.Second {
		t.Errorf("NextDelay(2, 1.5s) = %v, хочу 1s до кэпа", got)
	}
}
