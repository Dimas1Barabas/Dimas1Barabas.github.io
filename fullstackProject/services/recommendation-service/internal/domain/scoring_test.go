package domain

import (
	"math"
	"testing"
	"time"
)

func TestSignalWeight(t *testing.T) {
	cases := []struct {
		name   string
		kind   SignalKind
		rating int
		want   float64
	}{
		{"бронь даёт 1.0", KindBooking, 0, 1.0},
		{"отзыв 5 даёт 1.2", KindReview, 5, 1.2},
		{"отзыв 3 даёт 0.72", KindReview, 3, 0.72},
		{"отзыв 1 даёт 0.24", KindReview, 1, 0.24},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got := SignalWeight(tc.kind, tc.rating); math.Abs(got-tc.want) > 1e-9 {
				t.Fatalf("SignalWeight(%s, %d) = %v, want %v", tc.kind, tc.rating, got, tc.want)
			}
		})
	}
}

func TestBuildProfile(t *testing.T) {
	signals := []Signal{
		{UserID: "u1", MovieID: "m1", Genre: "фантастика", Kind: KindBooking, DedupKey: "booking:b1"},
		{UserID: "u1", MovieID: "m2", Genre: "фантастика", Kind: KindReview, Rating: 5, DedupKey: "review:r1"},
		{UserID: "u1", MovieID: "m3", Genre: "драма", Kind: KindReview, Rating: 3, DedupKey: "review:r2"},
	}
	p := BuildProfile("u1", signals)
	if len(p.Seen) != 3 || !p.Seen["m2"] {
		t.Fatalf("Seen = %v, want 3 фильма", p.Seen)
	}
	if math.Abs(p.GenreWeights["фантастика"]-(1.0+1.2)) > 1e-9 {
		t.Fatalf("вес фантастики = %v, want 2.2", p.GenreWeights["фантастика"])
	}
	if math.Abs(p.GenreWeights["драма"]-0.72) > 1e-9 {
		t.Fatalf("вес драмы = %v, want 0.72", p.GenreWeights["драма"])
	}
}

func TestValidate(t *testing.T) {
	base := func() Signal {
		return Signal{
			UserID: "u1", MovieID: "m1", MovieTitle: "Дюна", Genre: "фантастика",
			Kind: KindBooking, DedupKey: "booking:b1", OccurredAt: time.Now(),
		}
	}
	cases := []struct {
		name string
		mut  func(*Signal)
		want error
	}{
		{"валидная бронь", func(*Signal) {}, nil},
		{"валидный отзыв", func(s *Signal) { s.Kind, s.Rating = KindReview, 4 }, nil},
		{"нет зрителя", func(s *Signal) { s.UserID = "" }, ErrInvalidSignal},
		{"нет фильма", func(s *Signal) { s.MovieID = "" }, ErrInvalidSignal},
		{"нет жанра", func(s *Signal) { s.Genre = "" }, ErrInvalidSignal},
		{"нет dedup-ключа", func(s *Signal) { s.DedupKey = "" }, ErrInvalidSignal},
		{"неизвестный тип", func(s *Signal) { s.Kind = "click" }, ErrInvalidSignal},
		{"отзыв без рейтинга", func(s *Signal) { s.Kind, s.Rating = KindReview, 0 }, ErrInvalidSignal},
		{"отзыв со рейтингом 6", func(s *Signal) { s.Kind, s.Rating = KindReview, 6 }, ErrInvalidSignal},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			s := base()
			tc.mut(&s)
			if got := s.Validate(); got != tc.want {
				t.Fatalf("Validate() = %v, want %v", got, tc.want)
			}
		})
	}
}

func TestGenreCosine(t *testing.T) {
	weights := map[string]float64{"фантастика": 2, "драма": 1}
	if got := genreCosine("фантастика", weights); math.Abs(got-2/math.Sqrt(5)) > 1e-9 {
		t.Fatalf("cos(фантастика) = %v, want 2/sqrt(5)", got)
	}
	if got := genreCosine("жанра нет", weights); got != 0 {
		t.Fatalf("cos отсутствующего жанра = %v, want 0", got)
	}
}

func TestRank(t *testing.T) {
	afisha := []Movie{
		{MovieID: "m1", Title: "Дюна", Genre: "фантастика", RatingAvg: 3.0, RatingCount: 3},
		{MovieID: "m2", Title: "Осенний вальс", Genre: "драма", RatingAvg: 4.9, RatingCount: 40},
		{MovieID: "m3", Title: "Скрик", Genre: "хоррор", RatingAvg: 0, RatingCount: 0},
	}
	profile := BuildProfile("u1", []Signal{
		{UserID: "u1", MovieID: "mX", Genre: "фантастика", Kind: KindBooking, DedupKey: "booking:b1"},
		{UserID: "u1", MovieID: "mY", Genre: "фантастика", Kind: KindReview, Rating: 5, DedupKey: "review:r1"},
	})

	t.Run("жанр профиля обгоняет чужой с высоким рейтингом", func(t *testing.T) {
		rec := Rank(afisha, profile, 0)
		if rec.Basis != BasisProfile {
			t.Fatalf("Basis = %s, want profile", rec.Basis)
		}
		if rec.Items[0].MovieID != "m1" {
			t.Fatalf("первый = %s, want m1 (фантастика)", rec.Items[0].MovieID)
		}
		if rec.Items[0].Reason != "вы часто смотрите «фантастика»" {
			t.Fatalf("Reason = %q", rec.Items[0].Reason)
		}
	})

	t.Run("просмотренное исключается", func(t *testing.T) {
		p := profile
		p.Seen["m1"] = true
		rec := Rank(afisha, p, 0)
		for _, it := range rec.Items {
			if it.MovieID == "m1" {
				t.Fatalf("m1 не должен попасть в топ")
			}
		}
	})

	t.Run("холодный старт — по рейтингу афиши", func(t *testing.T) {
		rec := Rank(afisha, Profile{UserID: "u2", GenreWeights: map[string]float64{}, Seen: map[string]bool{}}, 0)
		if rec.Basis != BasisPopular {
			t.Fatalf("Basis = %s, want popular", rec.Basis)
		}
		if rec.Items[0].MovieID != "m2" || rec.Items[2].MovieID != "m3" {
			t.Fatalf("порядок = %s…%s, want m2…m3", rec.Items[0].MovieID, rec.Items[2].MovieID)
		}
		if rec.Items[2].Reason != "новинка афиши" {
			t.Fatalf("Reason без отзывов = %q, want новинка афиши", rec.Items[2].Reason)
		}
		if rec.Items[0].Reason != "высокий рейтинг зрителей" {
			t.Fatalf("Reason рейтингового = %q", rec.Items[0].Reason)
		}
	})

	t.Run("всё просмотрено — empty", func(t *testing.T) {
		p := profile
		for _, m := range afisha {
			p.Seen[m.MovieID] = true
		}
		rec := Rank(afisha, p, 0)
		if rec.Basis != BasisEmpty || len(rec.Items) != 0 {
			t.Fatalf("Basis = %s, items = %d, want empty/0", rec.Basis, len(rec.Items))
		}
	})

	t.Run("лимит срезает и дефолт равен 4", func(t *testing.T) {
		many := []Movie{
			{MovieID: "a", Title: "А", Genre: "g"},
			{MovieID: "b", Title: "Б", Genre: "g"},
			{MovieID: "c", Title: "В", Genre: "g"},
			{MovieID: "d", Title: "Г", Genre: "g"},
			{MovieID: "e", Title: "Д", Genre: "g"},
			{MovieID: "f", Title: "Е", Genre: "g"},
		}
		if got := len(Rank(many, Profile{UserID: "u", GenreWeights: map[string]float64{}, Seen: map[string]bool{}}, 0).Items); got != DefaultLimit {
			t.Fatalf("дефолтный топ = %d, want %d", got, DefaultLimit)
		}
		if got := len(Rank(many, Profile{UserID: "u", GenreWeights: map[string]float64{}, Seen: map[string]bool{}}, 2).Items); got != 2 {
			t.Fatalf("топ с limit=2 = %d, want 2", got)
		}
	})

	t.Run("ничья по скору решается названием", func(t *testing.T) {
		twins := []Movie{
			{MovieID: "x2", Title: "Ясный день", Genre: "g", RatingAvg: 4},
			{MovieID: "x1", Title: "Антрацит", Genre: "g", RatingAvg: 4},
		}
		rec := Rank(twins, Profile{UserID: "u", GenreWeights: map[string]float64{}, Seen: map[string]bool{}}, 0)
		if rec.Items[0].Title != "Антрацит" {
			t.Fatalf("первый при ничьей = %s, want Антрацит", rec.Items[0].Title)
		}
	})
}
