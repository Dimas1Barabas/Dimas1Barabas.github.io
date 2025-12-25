export const getReviewWordWithEnding = (reviewСount: number) => {
  switch (reviewСount) {
    case 1 || 21 || 31:
      return `${reviewСount} отзыв`
    case 2 || 3 || 4 || 22 || 23 || 24:
      return `${reviewСount} отзыва`
    default:
      return`${reviewСount} отзывов`
  }
}