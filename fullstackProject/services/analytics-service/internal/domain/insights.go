package domain

// Insights — витрина «Поведение»: всё, что накопили агрегаты, одним
// ответом. Названия фильмов веб подставит сам из каталога — здесь
// только идентификаторы и числа.
type Insights struct {
	// воронка в порядке пути зрителя; шаги без событий не входят
	Funnel []FunnelRow
	// фильмы: интерес (открытия модалки) против броней — конверсию
	// считает витрина, сортировка по интересу
	Movies []MovieInterest
	// страницы: просмотры и среднее активное время
	Pages []PageStat
	// места: тепловая карта кликов по залам
	Seats []SeatHeat
	// модалка: время в модалке по глубине пройденного пути
	Modal []ModalStat
}

// FunnelRow — один шаг воронки.
type FunnelRow struct {
	Step  FunnelStep
	Count int64
}

// MovieInterest — интерес к фильму: сколько раз открывали модалку
// (открытие = смотрели), сколько раз бронировали после оплаты.
type MovieInterest struct {
	MovieID  string
	Opens    int64
	Bookings int64
}

// PageStat — маршрут: просмотры и суммарное активное время; среднее
// считает витрина (total/views).
type PageStat struct {
	Route   string
	Views   int64
	TotalMS int64
}

// SeatHeat — клик по месту зала: тепловая карта популярности.
type SeatHeat struct {
	Hall   string
	Seat   string
	Clicks int64
}

// ModalStat — глубина пути в модалке: сколько раз дошли и сколько
// активного времени провели (среднее — total/events).
type ModalStat struct {
	Deepest  string
	Events   int64
	TotalMS  int64
}
