import { ApiProperty } from '@nestjs/swagger';
import { MovieDoc } from './meili.store';

/** подсказка поиска: карточка-миниатюра в выпадающем списке витрины */
export class SearchSuggestionDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty({ example: 'Рекурсия' })
  title!: string;

  @ApiProperty({ example: 'фантастика' })
  genre!: string;

  @ApiProperty({ example: '🌀', description: 'emoji-иконка жанра' })
  genreIcon!: string;

  @ApiProperty({ example: 275, description: 'оттенок градиентного чипа (HSL hue)' })
  hue!: number;

  @ApiProperty({ example: 4.6, description: 'средняя оценка отзывов' })
  ratingAvg!: number;
}

export function docToSuggestion(doc: MovieDoc): SearchSuggestionDto {
  return {
    id: doc.id,
    title: doc.title,
    genre: doc.genre,
    genreIcon: doc.genreIcon,
    hue: doc.hue,
    ratingAvg: doc.ratingAvg,
  };
}
