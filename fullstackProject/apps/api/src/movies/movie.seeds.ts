import { Movie } from './movie.entity';

function inDays(days: number, hour: number): Date {
  const d = new Date();
  d.setDate(d.getDate() + days);
  d.setHours(hour, 0, 0, 0);
  return d;
}

/** Стартовые фильмы с расписанием: у каждого 2–3 сеанса, «завтра» обязателен —
 *  чтобы фильтр «Сегодня» и ночная демка не оставались пустыми */
export const MOVIE_SEEDS: Array<
  Omit<Partial<Movie>, 'sessions'> & { sessions: { hall: string; startsAt: Date }[] }
> = [
  {
    title: 'Млечный Путь: Операция «Туманность»',
    description:
      'Космофлот теряет связь с колонией Туманность. Экипаж разведчика «Скиталец» должен выяснить, что произошло, — и постараться не сойти с ума по дороге.',
    genre: 'фантастика',
    genreIcon: '🚀',
    durationMin: 132,
    priceRub: 450,
    hue: 220,
    sessions: [
      { hall: 'IMAX', startsAt: inDays(0, 19) },
      { hall: 'Красный', startsAt: inDays(1, 12) },
      { hall: 'IMAX', startsAt: inDays(2, 21) },
    ],
  },
  {
    title: 'Последний дебаг',
    description:
      'За сутки до релиза в проде плавает баг, который воспроизводится только у джуниора. Он ещё не знает: это не баг, а фича. Чужая.',
    genre: 'триллер',
    genreIcon: '🐞',
    durationMin: 98,
    priceRub: 320,
    hue: 160,
    sessions: [
      { hall: 'Красный', startsAt: inDays(1, 21) },
      { hall: 'Красный', startsAt: inDays(3, 15) },
    ],
  },
  {
    title: 'Госпожа Кэш',
    description:
      'Богатейшая женщина города раздаёт долги незнакомцам. Но у каждого подарка есть цена, и она не измеряется деньгами.',
    genre: 'драма',
    genreIcon: '💰',
    durationMin: 141,
    priceRub: 380,
    hue: 330,
    sessions: [
      { hall: 'Красный', startsAt: inDays(0, 21) },
      { hall: 'IMAX', startsAt: inDays(1, 18) },
    ],
  },
  {
    title: 'Рекурсия',
    description:
      'Функция вызывает саму себя, чтобы пережить один и тот же вечер снова и снова. Рано или поздно стек переполнится.',
    genre: 'хоррор',
    genreIcon: '🌀',
    durationMin: 112,
    priceRub: 400,
    hue: 275,
    sessions: [
      { hall: 'IMAX', startsAt: inDays(1, 23) },
      { hall: 'Красный', startsAt: inDays(2, 22) },
    ],
  },
  {
    title: 'Тайна старого репозитория',
    description:
      'Археолог находит заброшенный git-репозиторий 2009 года. В истории коммитов спрятано послание, которое меняет всё.',
    genre: 'приключения',
    genreIcon: '🗺️',
    durationMin: 124,
    priceRub: 350,
    hue: 30,
    sessions: [
      { hall: 'Красный', startsAt: inDays(2, 15) },
      { hall: 'IMAX', startsAt: inDays(3, 13) },
      { hall: 'Красный', startsAt: inDays(3, 20) },
    ],
  },
  {
    title: 'Сорок девятый поток',
    description:
      'Год жизни курса веб-разработчиков: от «hello world» до оффера. Без монтажа, без купюр.',
    genre: 'документальный',
    genreIcon: '🎬',
    durationMin: 76,
    priceRub: 250,
    hue: 200,
    sessions: [
      { hall: 'Красный', startsAt: inDays(1, 14) },
      { hall: 'Красный', startsAt: inDays(2, 18) },
    ],
  },
];
