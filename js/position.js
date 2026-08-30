// Вспомогательные функции для работы с якорями чтения.
// Якорь = блок текста (по data-block-id) + смещение внутри блока.

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function normalizePreview(text) {
  return (text || '').replace(/\s+/g, ' ').trim().slice(0, 120);
}

function computeAnchorFromVisibleBlocks(blocks, viewport) {
  const visible = blocks
    .map((block) => ({
      blockId: block.blockId,
      rect: block.rect,
      text: block.text ?? '',
      previewText: normalizePreview(block.text ?? ''),
    }))
    .filter((item) => item.rect.bottom >= viewport.top && item.rect.top <= viewport.bottom);

  if (visible.length === 0) return null;

  visible.sort((a, b) => a.rect.top - b.rect.top);

  // Блок, на котором сосредоточен взгляд: содержащий вертикальный центр окна.
  // Так закладка привязывается к месту чтения, а не к началу страницы.
  const centerY = (viewport.top + viewport.bottom) / 2;
  const target = visible.find((item) => item.rect.top <= centerY && item.rect.bottom >= centerY) ?? visible[0];
  const blockHeight = Math.max(target.rect.height, 1);
  const offsetRatio = clamp((centerY - target.rect.top) / blockHeight, 0, 1);

  return {
    blockId: target.blockId,
    offsetRatio,
    previewText: target.previewText,
  };
}

export function buildPositionAnchor(root, viewport) {
  const blocks = Array.from(root.querySelectorAll('[data-block-id]'))
    // Во время анимации перелистывания в #flipLayer лежат КОПИИ страниц
    // с теми же data-block-id — их нужно исключить, иначе якорь может
    // «зацепиться» за лист, а не за статичную страницу.
    .filter((node) => !node.closest('#flipLayer'))
    .map((node) => ({
      blockId: node.dataset.blockId,
      rect: node.getBoundingClientRect(),
      text: node.textContent,
      previewText: normalizePreview(node.textContent),
    }));

  return computeAnchorFromVisibleBlocks(blocks, viewport);
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
 * @param {object} anchor — { blockId, offsetRatio, previewText }
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
