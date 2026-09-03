// Вспомогательные функции для работы с якорями чтения.
// Якорь = блок текста (по data-block-id) + смещение внутри блока.

function normalizePreview(text) {
  return (text || '').replace(/\s+/g, ' ').trim().slice(0, 120);
}

export function buildPositionAnchor(root, viewport) {
  /* Якорь = ПЕРВОЕ предложение (блок) на развороте:
     - в двухстраничном режиме разворот начинается с ЛЕВОЙ страницы;
     - в одностраничном — с (единственной) правой.

     Почему не «блок в центре окна», как раньше: центр окна в single- и
     double-режимах попадает в разные места текста, и при переключении
     режима часть текста перечитывалась или пропускалась. Якорь-начало
     разворота указывает на одно и то же предложение в обоих режимах:
     читатель продолжает ровно с того места, где остановился.

     Пагинатор режет длинные абзацы по ПРЕДЛОЖЕНИЯМ (splitParagraph),
     поэтому первый блок разворота — это всегда целое предложение. */

  const bookEl = document.getElementById('book');
  const single = bookEl?.classList.contains('single-page') === true;

  const all = Array.from(root.querySelectorAll('[data-block-id]'))
    // Во время анимации перелистывания в #flipLayer лежат КОПИИ страниц
    // с теми же data-block-id — их нужно исключить, иначе якорь может
    // «зацепиться» за лист, а не за статичную страницу.
    .filter((node) => !node.closest('#flipLayer'))
    .map((node) => ({
      blockId: node.dataset.blockId,
      rect: node.getBoundingClientRect(),
      text: node.textContent,
      previewText: normalizePreview(node.textContent),
      // Какой странице принадлежит блок (подложки левой/правой страницы)
      side: node.closest('#contentUnderLeft') ? 'left' : 'right',
    }));

  if (all.length === 0) return null;

  // Сторона, с которой начинается разворот в текущем режиме
  const preferredSide = single ? 'right' : 'left';
  let candidates = all.filter((b) => b.side === preferredSide);
  // Левая страница пуста (конец книги / начало в single) — берём правую
  if (candidates.length === 0) candidates = all.filter((b) => b.side === 'right');
  if (candidates.length === 0) return null;

  // Первый блок стороны = первое предложение на развороте. Фильтр по
  // viewport не нужен: страница разворота принадлежит текущему
  // положению книги целиком, а не видимой части окна.
  candidates.sort((a, b) => a.rect.top - b.rect.top);
  // Якорь = первая ВИДИМАЯ БУКВА текста: блоки без текста (картинки-figure,
  // пустые чанки) пропускаем. Иначе якорь цеплялся за край картинки,
  // а в другом браузере/вкладке с иной вёрсткой «первым блоком» оказывался
  // другой элемент — якоря «прыгали» между вкладками и браузерами.
  // Фолбэк: страница без текста (только картинки) — берём первый блок.
  const target = candidates.find((b) => b.text.trim()) ?? candidates[0];

  return {
    blockId: target.blockId,
    previewText: target.previewText,
  };
}

/* ---------- Поиск страницы по якорю ---------- */

/** Нормализует текст для сравнения: схлопывает пробелы/переносы. */
function normalizeText(text) {
  return (text || '').replace(/\s+/g, ' ').trim();
}

/**
 * Находит индекс страницы, соответствующий сохранённому якорю.
 *
 * Почему не просто поиск по blockId: длинные абзацы разрезаются на части,
 * и границы нарезки меняются при изменении размера шрифта/окна. Из-за этого
 * в старом формате blockId «уезжал» на другой текст. Теперь один и тот же
 * исходный абзац имеет один стабильный id, а выбор точной страницы среди
 * страниц абзаца делается по сохранённому тексту закладки (previewText).
 *
 * @param {object} anchor — { blockId, previewText }
 * @param {string[]} pages — HTML-строки страниц
 * @param {Array<Array<{blockId:string,text:string}>>} [pageBlocks] — метаданные блоков по страницам
 * @returns {number} индекс страницы или -1
 */
export function resolveAnchorPage(anchor, pages, pageBlocks) {
  if (!anchor?.blockId) return -1;
  const { blockId, previewText } = anchor;
  const needle = normalizeText(previewText);

  // 1) Все страницы, где встречается блок (абзац может занимать несколько страниц)
  const hits = [];
  if (pageBlocks) {
    for (let i = 0; i < pageBlocks.length; i++) {
      const blocks = pageBlocks[i] || [];
      if (blocks.some((b) => b.blockId === blockId)) hits.push(i);
    }
  } else {
    const html = `data-block-id="${blockId}"`;
    for (let i = 0; i < pages.length; i++) {
      if (pages[i].includes(html)) hits.push(i);
    }
  }

  // 2) Блок не найден — ищем по тексту (старые закладки, смена нарезки абзацев)
  if (hits.length === 0) {
    return findPageByText(needle, pageBlocks, pages);
  }

  // 3) Уточняем страницу по тексту закладки. Это важно и для одиночных блоков:
  //    старый id (нарезка по чанкам) может «совпасть» с другим текстом, поэтому
  //    всегда проверяем, что текст блока действительно соответствует превью.
  if (needle && pageBlocks) {
    // Сначала точное совпадение начала блока с превью
    for (const len of [120, 80, 50, 30, 16]) {
      const pref = needle.slice(0, len);
      if (!pref) continue;
      for (const i of hits) {
        for (const b of pageBlocks[i]) {
          if (b.blockId === blockId && normalizeText(b.text).startsWith(pref)) return i;
        }
      }
    }
    // Затем «содержит» — если граница нарезки попала в начало закладки
    for (const len of [80, 50, 30]) {
      const pref = needle.slice(0, len);
      if (!pref) continue;
      for (const i of hits) {
        for (const b of pageBlocks[i]) {
          if (b.blockId === blockId && normalizeText(b.text).includes(pref)) return i;
        }
      }
    }
    // Блок найден, но текст НЕ совпадает с сохранённым превью — id «уехал»
    // (например, закладка создана в старой версии). Ищем страницу по тексту.
    const byText = findPageByText(needle, pageBlocks, pages);
    if (byText >= 0) return byText;
  }

  // Не смогли уточнить — берём первую страницу с этим блоком
  return hits[0];
}

/** Ищет страницу, содержащую фрагмент текста (убывающие префиксы). */
function findPageByText(needle, pageBlocks, pages) {
  if (!needle) return -1;
  const lengths = [120, 80, 50, 30, 16];
  if (pageBlocks) {
    for (const len of lengths) {
      const pref = needle.slice(0, len);
      if (!pref) continue;
      for (let i = 0; i < pageBlocks.length; i++) {
        for (const b of pageBlocks[i] || []) {
          if (normalizeText(b.text).includes(pref)) return i;
        }
      }
    }
  }
  return -1;
}
