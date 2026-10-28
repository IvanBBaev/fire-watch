/** Bulgarian copy for the `beforeAfter` fragment (V2-E2; moved here by V3-P1). */

import type { BeforeAfterMessages } from './before-after.js';

const fragment: { readonly beforeAfter: BeforeAfterMessages } = {
  beforeAfter: {
    open: 'Сравни сателитни изображения: преди / след',
    close: 'Затвори сравнението',
    title: 'Преди / след (сателит)',
    sliderLabel: 'Разделител между изображенията преди и след',
    sliderValue: (percent) => `Разделител на ${String(percent)}%`,
    beforeLabel: (date) => `Преди: ${date}`,
    afterLabel: (date) => `След: ${date}`,
    afterLatestLabel: (date) => `Последно налично: ${date}, не след последното засичане`,
    beforeEarlier: 'Изображение преди: един ден по-рано',
    beforeLater: 'Изображение преди: един ден по-късно',
    afterEarlier: 'Изображение след: един ден по-рано',
    afterLater: 'Изображение след: един ден по-късно',
    imageLabel: (before, after) =>
      `Сателитни изображения в естествени цветове около центъра на събитието: ${before} отляво, ${after} отдясно`,
    note:
      'Дневни мозайки от NASA VIIRS, около 375 м на пиксел, заснети в ранния следобед. Облаци ' +
      'или дим може да скриват земята и в двата дни, а това тук не се проверява. Не е карта ' +
      'на изгорелите площи.',
    unavailable: 'Все още няма наличен сателитен ден преди първото засичане на това събитие.',
    tilesFailed: 'Част от изображенията не се заредиха.',
  },
};

export default fragment;
