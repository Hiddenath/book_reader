/* ===== BookHaven 3D — инициализация, состояние, демо-контент ===== */

import { Reader } from './reader.js?v=20260831b';
import { Library } from './library.js?v=20260822a';
import { Bookmarks } from './bookmarks.js?v=20260806d';
import { TOC } from './toc.js?v=20260806d';
import { Notes } from './notes.js?v=20260827b';
import { loadState, loadStateFromServer, loadBooksFromServer, loadBookText, loadBookMeta, saveBookToServer, saveBookMeta, persistSnapshot, debouncedSave, saveState } from './storage.js?v=20260830b';
import { buildPositionAnchor, resolveAnchorPage } from './position.js?v=20260830a';

// API-сервер (для загрузки картинок из FB2: обложки и иллюстраций в тексте)
const API_PORT = 8001;
const SERVER_URL = `${location.protocol}//${location.hostname}:${API_PORT}`;

// Кэш размеров картинок из FB2: ключ «bookId|src» (id <binary> повторяется
// между книгами — «cover.jpg» есть почти в каждой) -> { w, h }.
// Нужен, чтобы пагинатор знал высоту картинки ДО её загрузки (img грузится асинхронно).
const imageSizeCache = new Map();
const imgCacheKey = (bookId, src) => `${bookId}|${src}`;

/**
 * Предзагружает все картинки книги и сохраняет их natural-размеры в кэш.
 * Возвращает Promise, который резолвится, когда все картинки загружены.
 */
function preloadBookImages(blocks, bookId) {
  const tasks = [];
  for (const b of blocks) {
    if (b.type !== 'image' || !b.src) continue;
    const key = imgCacheKey(bookId, b.src);
    if (imageSizeCache.has(key)) continue;
    const url = `${SERVER_URL}/books/${encodeURIComponent(bookId)}/image/${encodeURIComponent(b.src)}`;
    tasks.push(new Promise((resolve) => {
      const img = new Image();
      img.onload = () => {
        imageSizeCache.set(key, { w: img.naturalWidth, h: img.naturalHeight });
        resolve();
      };
      img.onerror = () => resolve();   // не блокируем при ошибке
      img.src = url;
    }));
  }
  return Promise.all(tasks);
}

const State = {
  currentBook: null,
  lastOpenedBookId: null,
  restoringPosition: false,
  pageCache: new Map(),
  toc: null,   // экземпляр класса TOC
  notes: null, // экземпляр класса Notes (сноски)
  settings: {
    fontSize: 18,
    lineHeight: 1.6,
    margins: 60,
    vmargins: 50,
    theme: 'paper',
    pageFlipAnimation: true,
    hyphenation: true,
  },
};

/* ---------- Демо-текст ---------- */

const DEMO_TEXT = `
Глава 1. Начало

Тихий вечер опустился на город. Улицы постепенно пустели, и только редкие прохожие спешили по своим делам, уткнувшись в воротники пальто. Ветер гонял по мостовой жёлтые листья, шурша ими, словно страницами невидимой книги.

В маленькой квартире на третьем этаже старого дома горел свет. За столом, заваленным бумагами, сидел человек и писал. Он писал быстро, почти не отрывая пера от бумаги, будто боялся упустить мысль, которая вот-вот могла ускользнуть навсегда.

Комната была тесной, но уютной. На стенах висели полки с книгами — сотни корешков, потёртых от времени, хранили истории, которые пережили своих авторов. Воздух пах старой бумагой и чернилами.

Человек отложил перо и откинулся на спинку кресла. Перед ним лежала рукопись — плод многих месяцев работы. Он знал, что эта книга изменит всё. Он чувствовал это каждой клеточкой своего существа.

Глава 2. Библиотека

На следующее утро он отправился в старую библиотеку на окраине города. Это место знали немногие — оно не значилось ни на одной карте, и вход туда был скрыт за неприметной дверью в глухом переулке.

Внутри царил полумрак. Высокие стеллажи уходили вверх, теряясь в темноте под потолком. Пыль танцевала в лучах света, пробивающегося сквозь узкие окна. Здесь время текло иначе — медленнее, вдумчивее.

Хранитель библиотеки, сухонький старик с проницательными глазами, встретил его у входа. Они обменялись молчаливыми кивками — слова здесь были излишни. Каждый, кто приходил сюда, знал, зачем.

Он прошёл в дальний зал, где хранились самые редкие издания. Там, на полке из тёмного дуба, стояла книга, которую он искал. Её корешок не имел названия, а страницы, казалось, шептали что-то на забытом языке.

Глава 3. Открытие

Книга оказалась не простой. В её страницах скрывались карты несуществующих земель, рецепты забытых зелий и истории людей, которых никогда не было — или, может быть, ещё не было.

Он читал запоем, забывая о еде и сне. Каждая страница открывала новый мир, и он чувствовал, как границы реальности начинают размываться. Что есть вымысел, а что — правда? Этот вопрос переставал иметь смысл.

Ночами ему снились странные сны: бескрайние океаны слов, горы из пергамента, реки чернил. Он плыл по этим рекам, и каждая капля была историей, ждущей своего читателя.

Когда он закрыл последнюю страницу, за окном уже светало. Мир выглядел иначе — словно кто-то переписал его заново, добавив деталей и красок. Он улыбнулся. Теперь он знал, что делать дальше.

Глава 4. Возвращение

Он вернулся к своему столу и взял чистый лист бумаги. Перо заскользило по странице, рождая новые миры. Теперь он писал не один — с ним были все те истории, что он прочитал, все голоса, что он услышал.

За окном город просыпался. Зазвенели трамваи, зашумели люди. Но в маленькой комнате на третьем этаже царила тишина, нарушаемая лишь скрипом пера. Так рождаются книги — в тишине и одиночестве, но для всех.

Страница за страницей, глава за главой. Рукопись росла, и вместе с ней росла уверенность: эта история найдёт своего читателя. Все книги находят — рано или поздно. Таков закон библиотеки.

А когда последняя точка была поставлена, он встал, подошёл к окну и посмотрел на город. Где-то там, в одном из окон, горел свет — кто-то читал. И это было самое главное.
`;

/* ---------- Пагинация (упрощённый BookParser) ---------- */

// Стабильный идентификатор блока: привязан к книге и порядковому номеру,
// поэтому не меняется при пересчёте страниц (нужно для сохранения позиции)
function makeStableBlockId(bookId, index) {
  const safeBookId = String(bookId || 'book').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');
  return `block-${safeBookId}-${index}`;
}

function escapeHtml(text) {
  const value = text == null ? '' : String(text);
  return value
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
}

/* Маркеры сносок из серверного парсера FB2:
   \uE000 <noteId> \uE001 <текст ссылки> \uE002
   Превращаем их в кликабельные ссылки-сноски. Текст уже экранирован. */
function renderNoteRefs(escapedText) {
  return escapedText.replace(
    /\uE000([^\uE001]*)\uE001([^\uE002]*)\uE002/g,
    (m, noteId, label) =>
      `<a class="note-ref" data-note-id="${noteId}" data-note-label="${label}">${label}</a>`
  );
}

/* Экранирует текст и делает сноски кликабельными. */
function escapeAndLink(text) {
  return renderNoteRefs(escapeHtml(text));
}

function renderBlocks(blocks, bookId = 'demo') {
  return blocks.map(({ text, blockId, type = 'paragraph', level = 0, src, noteId }) => {
    const escaped = escapeHtml(text);
    switch (type) {
      case 'chapter':
        return `<h2 class="chapter-title" data-block-id="${blockId}" data-level="${level}">${escaped}</h2>`;
      case 'subtitle':
        return `<h3 class="subtitle" data-block-id="${blockId}">${escaped}</h3>`;
      case 'epigraph':
        return `<blockquote class="epigraph" data-block-id="${blockId}">${escapeAndLink(text)}</blockquote>`;
      case 'cite':
        return `<blockquote class="cite" data-block-id="${blockId}">${escapeAndLink(text)}</blockquote>`;
      case 'poem':
        return `<pre class="poem" data-block-id="${blockId}">${escapeAndLink(text)}</pre>`;
      case 'note':
        // Текст сноски (примечания): якорь для перехода по клику на ссылку
        return `<p class="note-block" data-block-id="${blockId}" data-note-anchor="${noteId || ''}">${escapeAndLink(text)}</p>`;
      case 'image':
           // Картинка из FB2: src = id <binary>, грузим с сервера.
        // aspect-ratio из кэша размеров — чтобы пагинатор знал высоту ДО загрузки.
        // Высота figure задана ЯВНО (включая padding 1.2em сверху и снизу):
        // иначе измеритель и реальный рендер расходятся на ~2.4em → overflow.
        const imgSrc = `${SERVER_URL}/books/${encodeURIComponent(bookId)}/image/${encodeURIComponent(src || '')}`;
        // aspect-ratio на img: измеритель знает высоту ДО загрузки,
        // а max-height (CSS) сжимает слишком высокие картинки.
        const dim = src ? imageSizeCache.get(imgCacheKey(bookId, src)) : null;
        const style = dim && dim.w && dim.h ? `aspect-ratio:${dim.w}/${dim.h};` : '';
        return `<figure class="book-image" data-block-id="${blockId}"><img src="${imgSrc}" alt="" style="${style}" /></figure>`;
      default:
        return `<p data-block-id="${blockId}">${escapeAndLink(text)}</p>`;
    }
  }).join('');
}

/* ---------- Якорь-булавка: жёсткая фиксация первой буквы ---------- */

/* Нормализация как в position.js (previewText якоря уже нормализован). */
const pinNorm = (s) => String(s || '').replace(/\s+/g, ' ').trim();

/* Делит текст на предложения — тот же алгоритм, что в splitParagraph. */
function splitSentences(text) {
  return String(text ?? '')
    .split(/(?<=[.!?…])(\s+)/)
    .reduce((acc, part, i) => {
      if (i % 2 === 0) acc.push(part);
      else acc[acc.length - 1] += part;   // пробел — к предыдущему предложению
      return acc;
    }, [])
    .filter((s) => s.trim());
}

/* Делит блок по якорю: { before, after } — текст до якорной буквы и от неё
   до конца блока. null — якорь неприменим (не текст / текст не совпал). */
function splitPinnedBlock(block, pin) {
  const text = String(block.text ?? '');
  const needle = pinNorm(pin.previewText);

  // Неразрезаемые блоки (картинка/глава/подзаголовок): якорь — начало блока
  if (block.type === 'image' || block.type === 'chapter' || block.type === 'subtitle') {
    if (needle && !pinNorm(text).startsWith(needle.slice(0, 16))) return null;
    return { before: '', after: text };
  }
  if (!text.trim() || !needle) return null;

  // Ищем предложение, с которого начинается якорный фрагмент: хвост блока
  // от этого предложения должен начинаться текстом якоря (previewText).
  // Идём с конца: при повторах одинаковых предложений берём самое позднее
  // совпадение (границы в повторяющемся тексте и так неразличимы).
  const sentences = splitSentences(text);
  for (let j = sentences.length - 1; j >= 0; j--) {
    const tail = pinNorm(sentences.slice(j).join(''));
    if (tail.startsWith(needle)) {
      return {
        before: sentences.slice(0, j).join(''),
        after: sentences.slice(j).join(''),
      };
    }
  }

  // Запасной путь: якорный чанк был разрезан по СЛОВАМ (предложение
  // длиннее целой страницы — splitParagraph режет по словам). Ищем границу
  // по словам: остаток от неё должен начинаться текстом якоря.
  // ВАЖНО: идём по ВСЕМ индексам с пропускам разделителей — шаг строго -2
  // от чётной/нечётной позиции попадает только на разделители при
  // чётной длине массива (слова в split(/(\s+)/) лежат на чётных индексах,
  // но последний элемент может быть как словом, так и разделителем).
  const parts = text.split(/(\s+)/);   // слова и разделители — по очереди
  for (let w = parts.length - 1; w >= 0; w--) {
    if (!parts[w] || !parts[w].trim()) continue;   // разделитель — мимо
    const tail = pinNorm(parts.slice(w).join(''));
    if (tail.startsWith(needle)) {
      return {
        before: parts.slice(0, w).join(''),
        after: parts.slice(w).join(''),
      };
    }
  }
  return null; // совпадения нет (книга изменилась?) — якорь не применяем
}

/* Вставляет в поток блоков принудительный разрыв страницы по якорю:
   часть блока ДО якорной буквы остаётся в прежнем потоке, а от якорной
   буквы и далее — открывает новую страницу (в double-режиме — ЛЕВУЮ,
   чтобы буква возглавляла разворот). Всем блокам заранее назначаются
   стабильные id — части разделённого блока делят один id исходного. */
function applyPinToBlocks(blocks, bookId, pin, single) {
  const out = [];
  let idx = 0;               // счётчик текстовых блоков (бывший sourceIndex)
  let pinned = false;
  for (const b of blocks) {
    if (b.type === 'pagebreak') { out.push(b); continue; }
    const bid = makeStableBlockId(bookId, idx++);
    if (!pinned && pin?.blockId && bid === pin.blockId) {
      const split = splitPinnedBlock(b, pin);
      if (split) {
        pinned = true;
        if (split.before.trim()) out.push({ ...b, text: split.before, blockId: bid });
        out.push({ type: 'pagebreak', pinAlign: !single });
        out.push({ ...b, text: split.after, blockId: bid });
        continue;
      }
    }
    out.push({ ...b, blockId: bid });
  }
  return out;
}

function paginate(content, settings, bookId = 'book', pin = null) {
  const bookEl = document.getElementById('book');
  const measurer = document.createElement('div');
  measurer.className = 'page-content';
  // Наследуем шрифт книги: иначе измеритель считает метриками body-шрифта,
  // и высота блоков не совпадает с реальной (переполнение страниц).
  const bookFont = bookEl ? getComputedStyle(bookEl).fontFamily : '';
  measurer.style.cssText = `
    position: absolute; visibility: hidden; pointer-events: none;
    height: auto; inset: auto;
    font-size: ${settings.fontSize}px;
    line-height: ${settings.lineHeight};
    font-family: ${bookFont};
    padding: 0;
  `;
  document.body.appendChild(measurer);

  const book = document.getElementById('book');

  // ВАЖНО: используем offsetWidth/offsetHeight (реальные layout-размеры),
  // а НЕ getBoundingClientRect — тот искажён 3D-перспективой (rotateX + perspective),
  // из-за чего абзацы измерялись выше и переносились на новую страницу раньше времени.
  // Книга ВСЕГДА разворот по ширине (даже в single-режиме левая — подложка),
  // поэтому ширина страницы = offsetWidth / 2 в обоих режимах.
  const pageW = book.offsetWidth / 2;
  const pageH = book.offsetHeight;

  // Отступы текста на странице: вертикальные берём из настроек (vmargins).
  // В single-режиме верх чуть меньше, низ увеличен (компенсация наклона
  // rotateX — нижний край страницы ближе к зрителю). Значения должны
  // совпадать с CSS padding .page-content (см. --vmargins в reader.css).
  const single = book.classList.contains('single-page');
  const vm = settings.vmargins ?? 50;
  const padTop = single ? vm - 8 : vm;
  const padBottom = single ? vm + 42 : vm;

  const contentW = pageW - settings.margins * 2;
  const contentH = pageH - padTop - padBottom;
  const lineH = settings.fontSize * settings.lineHeight;

  // Доступная высота страницы — для ограничения высоты картинок в CSS
  book.style.setProperty('--page-content-h', `${contentH}px`);

  measurer.style.width = `${contentW}px`;

  // Поддержка блоков (новый формат) или plain text (старый)
  const blocks = Array.isArray(content)
    ? content
    : (content || '').trim().split(/\n\s*\n/).map(p => ({ type: 'paragraph', text: p.trim() })).filter(b => b.text);

  // Якорь-булавка: принудительный разрыв страницы ровно на первой букве
  // якоря — при ЛЮБОЙ вёрстке (шрифт/отступы/режим) эта буква открывает
  // страницу разворота. Всем блокам заранее назначаются стабильные id.
  const work = applyPinToBlocks(blocks, bookId, pin, single);

  const pages = [];
  const pageBlocks = [];   // метаданные блоков: pageBlocks[i] = [{ blockId, text }]
  const toc = [];           // оглавление: [{ title, page }]
  let pinPage = -1;         // индекс страницы, которую открывает якорная буква
  let currentPage = [];
  let currentBlocks = [];
  let currentH = 0;
  let sourceIndex = 0;      // стабильный номер ИСХОДНОГО блока (не чанка!)
  let lastWasHeader = false; // предыдущий блок был заголовком (глава/подзаголовок)

  for (const block of work) {
    // Разрыв страницы: принудительно завершаем текущую страницу
    if (block.type === 'pagebreak') {
      if (currentPage.length > 0) {
        pages.push(renderBlocks(currentPage, bookId));
        pageBlocks.push(currentBlocks);
        currentPage = [];
        currentBlocks = [];
        currentH = 0;
      }
      // Разрыв по якорю-булавке: в двухстраничном режиме якорная буква
      // должна возглавить ЛЕВУЮ страницу разворота (чётный индекс).
      // В single-режиме выравнивание не нужно — пустая страница была бы ВИДНА.
      if (block.pinAlign && !single) {
        if (pages.length % 2 !== 0) {
          pages.push('');
          pageBlocks.push([]);
        }
        pinPage = pages.length; // следующая открываемая страница — якорная
      }
      lastWasHeader = false;
      continue;
    }

    // Заголовок главы: глава начинается с новой страницы, НО если подряд идут
    // несколько заголовков (автор, серия, название, аннотация, пролог) —
    // каждый на своей странице — слишком много пустых страниц. Поэтому
    // разрыв делаем только если предыдущий блок НЕ был заголовком.
    if (block.type === 'chapter') {
      if (!lastWasHeader && currentPage.length > 0) {
        pages.push(renderBlocks(currentPage, bookId));
        pageBlocks.push(currentBlocks);
        currentPage = [];
        currentBlocks = [];
        currentH = 0;
      }
      // В двухстраничном режиме название главы — на ЛЕВОЙ странице разворота:
      // если текущая позиция нечётная (правая страница), добавляем пустую.
      // В single-режиме этого НЕ делаем — пустая страница была бы видна.
      if (!single && pages.length % 2 !== 0) {
        pages.push('');
        pageBlocks.push([]);
      }
      // TOC указывает на ФАКТИЧЕСКУЮ страницу заголовка (после выравнивания)
      toc.push({ title: block.text, page: pages.length });
      lastWasHeader = true;
    } else if (block.type === 'subtitle') {
      lastWasHeader = true;
    } else {
      lastWasHeader = false;
    }

    const blockHtml = renderBlocks([{ ...block, blockId: 'temp' }], bookId);

    // Измеряем с невидимым префиксом: так абзац НЕ является first-child,
    // и к нему не применяется ::first-letter (буквица), которая завышала высоту.
    // margin-bottom уже включён в измерение — отдельный gap не нужен.
    measurer.innerHTML = `<span style="display:block;height:0"></span>${blockHtml}`;
    let blockH = measurer.getBoundingClientRect().height;

    // Высота картинки: измерение может дать ТОЛЬКО padding (43px), если
    // aspect-ratio не подставился (кэш размеров пуст в момент измерения).
    // В этом случае считаем высоту из кэша размеров; заодно ограничиваем
    // высоту страницы (CSS max-height сжимает рендер так же).
    if (block.type === 'image') {
      const dim = block.src ? imageSizeCache.get(imgCacheKey(bookId, block.src)) : null;
      if (dim && dim.w && dim.h) {
        const pad = settings.fontSize * 2.4;                  // padding figure
        const maxImgH = contentH - pad;
        const imgH = Math.min(contentW * dim.h / dim.w, maxImgH);
        // Расчётная высота всегда точнее измерения: она учитывает и
        // схлопывание (кэш был пуст), и ограничение высотой страницы.
        blockH = imgH + pad;
      }
    }

    // ВАЖНО: один стабильный id на ИСХОДНЫЙ блок текста.
    // Длинный абзац, разрезанный на несколько страниц, сохраняет ОДИН id,
    // чтобы закладки не «съезжали» при смене размера шрифта/окна.
    // id назначен заранее (applyPinToBlocks): части блока, разделённого
    // якорем (до/после буквы), делят ОДИН id исходного блока.
    const blockId = block.blockId || makeStableBlockId(bookId, sourceIndex++);

    // Блок не помещается в остаток страницы:
    // - если блок ЦЕЛИКОМ помещается на пустой странице — переносим целиком
    //   (не рвём прозу без необходимости);
    // - если блок длиннее целой страницы — режем по ПРЕДЛОЖЕНИЯМ, заполняя
    //   остаток текущей страницы первым чанком (предложение не разрывается).
    // ВАЖНО: режем и на ПУСТОЙ странице — иначе блок, открытый якорем-
    //   булавкой (или просто длинный), переполняет страницу текстом за полями.
    const splittable = block.type !== 'image' && block.type !== 'chapter' && block.type !== 'subtitle';
    if (splittable && currentH + blockH > contentH && blockH > contentH) {
      const avail = contentH - currentH;
      const chunks = splitParagraph(measurer, block.text, contentH, lineH, block.type, avail);
      // Пустой первый чанк = блок целиком переносится на новую страницу
      if (chunks[0] === '') {
        pages.push(renderBlocks(currentPage, bookId));
        pageBlocks.push(currentBlocks);
        currentPage = [];
        currentBlocks = [];
        currentH = 0;
        // Блок длиннее страницы — раскладываем остаток постранично
        for (let i = 0; i < chunks.length; i++) {
          if (!chunks[i]) continue;
          const cb = { text: chunks[i], type: block.type, level: block.level, blockId };
          if (i < chunks.length - 1) {
            pages.push(renderBlocks([cb], bookId));
            pageBlocks.push([{ blockId, text: chunks[i] }]);
          } else {
            currentPage.push(cb);
            currentBlocks.push({ blockId, text: chunks[i] });
            currentH = measurerLastH;
          }
        }
        continue;
      }
      // Первый чанк — в остаток текущей страницы
      currentPage.push({ text: chunks[0], type: block.type, level: block.level, blockId });
      currentBlocks.push({ blockId, text: chunks[0] });
      pages.push(renderBlocks(currentPage, bookId));
      pageBlocks.push(currentBlocks);
      currentPage = [];
      currentBlocks = [];
      currentH = 0;
      // Остальные чанки — постранично
      for (let i = 1; i < chunks.length; i++) {
        const cb = { text: chunks[i], type: block.type, level: block.level, blockId };
        if (i < chunks.length - 1) {
          pages.push(renderBlocks([cb], bookId));
          pageBlocks.push([{ blockId, text: chunks[i] }]);
        } else {
          currentPage.push(cb);
          currentBlocks.push({ blockId, text: chunks[i] });
          currentH = measurerLastH;
        }
      }
      continue;
    }

    // Блок не влезает в остаток — переносим ЦЕЛИКОМ на следующую страницу
    if (currentH + blockH > contentH && currentPage.length > 0) {
      pages.push(renderBlocks(currentPage, bookId));
      pageBlocks.push(currentBlocks);
      currentPage = [];
      currentBlocks = [];
      currentH = 0;
    }

    currentPage.push({
      text: block.text,
      type: block.type,
      level: block.level,
      blockId,
      src: block.src,     // для картинок из FB2
      noteId: block.noteId, // для блоков-сносок (якорь перехода)
      });
    currentBlocks.push({ blockId, text: block.text });
    currentH += blockH;
  }

  if (currentPage.length > 0) {
    pages.push(renderBlocks(currentPage, bookId));
    pageBlocks.push(currentBlocks);
  }

  measurer.remove();

  // Хвостовой выравниватель нужен ТОЛЬКО в double-режиме (чётное число
  // страниц для разворотов). В single пустая последняя страница видна.
  if (!single && pages.length % 2 !== 0) {
    pages.push('');
    pageBlocks.push([]);
  }

  // Карта сносок: noteId -> индекс страницы, где лежит текст сноски.
  // Ищем в HTML страниц якорь data-note-anchor="...".
  const notePages = {};
  for (let i = 0; i < pages.length; i++) {
    const re = /data-note-anchor="([^"]+)"/g;
    let m;
    while ((m = re.exec(pages[i])) !== null) {
      if (m[1] && !(m[1] in notePages)) notePages[m[1]] = i;
    }
  }

  return { pages, toc, pageBlocks, notePages, pinPage };
}

// Высота последнего измеренного чанка (заполняется в splitParagraph)
let measurerLastH = 0;

/* Делит длинный блок (абзац/стих/эпиграф) на куски, каждый из которых
   помещается в contentH. Бинарным поиском по словам находит максимальный
   влезающий префикс. Измеряет РЕАЛЬНОЙ разметкой блока (blockquote/pre),
   чтобы высота совпадала с финальным рендером. Переносы строк (\n)
   сохраняются: слова стыкуются тем же разделителем, что был в тексте. */
function splitParagraph(measurer, para, contentH, lineH, type = 'paragraph', firstLimit = null) {
  // Режем по ПРЕДЛОЖЕНИЯМ (заканчиваются на . ! ? …), чтобы предложение
  // не разрывалось между страницами. firstLimit — отдельный лимит для ПЕРВОГО
  // чанка (заполнение остатка страницы), остальные чанки — по contentH.
  const text = String(para ?? '');
  const chunks = [];

  const renderChunk = (str) => renderBlocks([{ text: str, type, blockId: 'temp' }], 'demo');

  const PREFIX = '<span style="display:block;height:0"></span>';
  const fits = (str, limit) => {
    measurer.innerHTML = `${PREFIX}${renderChunk(str)}`;
    return measurer.getBoundingClientRect().height <= limit;
  };

  // Деление на предложения: тот же алгоритм, что и в делении по якорю
  const sentences = splitSentences(text);

  if (sentences.length === 0) {
    measurerLastH = 0;
    return chunks;
  }

  // Сборка чанков: жадно набираем предложения в лимит.
  const buildChunks = (list, firstLimit) => {
    const out = [];
    let rest = list;
    let limit = firstLimit ?? contentH;
    let isFirst = true;
    while (rest.length > 0) {
      if (!fits(rest[0], limit)) {
        if (isFirst && fits(rest[0], contentH)) {
          // Первое предложение не влезает в остаток страницы, но влезает
          // в целую страницу — первый чанк ПУСТОЙ (блок начнётся с новой
          // страницы целиком, предложение не разорвётся).
          out.push('');
          limit = contentH;
          isFirst = false;
          continue;
        }
        // Фолбэк: предложение длиннее целой страницы.
        // Сначала пробуем резать по запятым/двоеточиям (естественные паузы),
        // и только если и часть не влезает — по словам.
        const parts = rest[0].split(/(?<=[,;:])\s+/).filter((s) => s.trim());
        if (parts.length > 1 && fits(parts[0], limit)) {
          // Жадно набираем части предложения
          let lo = 1, hi = parts.length, fit = 1;
          while (lo <= hi) {
            const mid = (lo + hi) >> 1;
            if (fits(parts.slice(0, mid).join(' '), limit)) { fit = mid; lo = mid + 1; }
            else { hi = mid - 1; }
          }
          out.push(parts.slice(0, fit).join(' '));
          rest = [parts.slice(fit).join(' '), ...rest.slice(1)];
        } else {
          // Совсем безнадёжно — режем по словам
          const tokens = rest[0].split(/(\s+)/).filter((t) => t !== '');
          const words = tokens.filter((t) => !/^\s+$/.test(t));
          let lo = 1, hi = words.length, fit = 1;
          while (lo <= hi) {
            const mid = (lo + hi) >> 1;
            if (fits(words.slice(0, mid).join(' '), limit)) { fit = mid; lo = mid + 1; }
            else { hi = mid - 1; }
          }
          out.push(words.slice(0, fit).join(' '));
          rest = [words.slice(fit).join(' '), ...rest.slice(1)];
        }
        limit = contentH;
        isFirst = false;
        continue;
      }
      // Бинарный поиск: максимум предложений, влезающих в лимит
      let lo = 1, hi = rest.length, fit = 1;
      while (lo <= hi) {
        const mid = (lo + hi) >> 1;
        if (fits(rest.slice(0, mid).join(' '), limit)) { fit = mid; lo = mid + 1; }
        else { hi = mid - 1; }
      }
      out.push(rest.slice(0, fit).join(' '));
      rest = rest.slice(fit);
      limit = contentH;
      isFirst = false;
    }
    return out;
  };

  const result = buildChunks(sentences, firstLimit);

  // Высота последнего чанка — для продолжения накопления страницы
  measurer.innerHTML = `${PREFIX}${renderChunk(result[result.length - 1])}`;
  measurerLastH = measurer.getBoundingClientRect().height;
  return result;
}

/* ---------- Применение настроек ---------- */

let reflowTimer = null;
let persistTimer = null;

function applyVisualSettings() {
  const s = State.settings;
  const book = document.getElementById('book');
  book.style.setProperty('--font-size', `${s.fontSize}px`);
  book.style.setProperty('--line-height', s.lineHeight);
  book.style.setProperty('--margins', `${s.margins}px`);
  book.style.setProperty('--vmargins', `${s.vmargins ?? 50}px`);
  document.documentElement.dataset.theme = s.theme;
  // Перенос слов: управляется классом на книге (hyphens: auto/manual в CSS)
  book.classList.toggle('no-hyphens', s.hyphenation === false);

  document.querySelectorAll('.theme-dot').forEach(d =>
    d.classList.toggle('active', d.dataset.themeName === s.theme));
}

/** Синхронизирует контролы панели настроек с State.settings
    (после подтягивания состояния с сервера). */
function syncSettingsUI() {
  const s = State.settings;
  const font = document.getElementById('setFontSize');
  const line = document.getElementById('setLineHeight');
  const margins = document.getElementById('setMargins');
  const vmargins = document.getElementById('setVMargins');
  const flip = document.getElementById('setPageFlipAnimation');
  const hyph = document.getElementById('setHyphenation');
  if (font) font.value = s.fontSize;
  if (line) line.value = s.lineHeight;
  // Отступы: клампим в диапазон слайдеров (10–100) — в старых сохранённых
  // настройках могли быть значения 0/120 с прежней шкалой
  if (margins) {
    s.margins = Math.min(100, Math.max(10, Number(s.margins) || 60));
    margins.value = s.margins;
  }
  if (vmargins) {
    s.vmargins = Math.min(100, Math.max(10, Number(s.vmargins) || 50));
    vmargins.value = s.vmargins;
  }
  if (flip) flip.checked = s.pageFlipAnimation !== false;
  if (hyph) hyph.checked = s.hyphenation !== false;
}

function getPageCacheKey(book, settings) {
  const bookId = book?.id ?? 'demo';
  const bookEl = document.getElementById('book');
  const mode = bookEl?.classList.contains('single-page') ? 'single' : 'double';
  // Размер книги в ключе: при изменении ширины окна макет должен перестраиваться,
  // иначе закэшированные страницы (старой ширины) выходят за нижнюю грань.
  const size = bookEl ? `${bookEl.offsetWidth}x${bookEl.offsetHeight}` : '0x0';
  return `${bookId}|${settings.fontSize}|${settings.lineHeight}|${settings.margins}|${settings.vmargins ?? 50}|${mode}|${size}`;
}

function getPagesForBook(book, settings, pin = null) {
  const key = getPageCacheKey(book, settings);
  // Кэш читаем только БЕЗ якоря-булавки: вёрстка с булавкой зависит от
  // позиции чтения. Результат (с булавкой или без) записывается под тот же
  // ключ — все последующие обращения (восстановление позиции, сноски)
  // получают ту же вёрстку, что сейчас на экране.
  if (!pin && State.pageCache.has(key)) return State.pageCache.get(key);

  const content = book?.blocks || book?.text || DEMO_TEXT;
  const result = paginate(content, settings, book?.id ?? 'demo', pin);
  result.pin = pin;   // якорь, с которым построена вёрстка (для сверки)
  State.pageCache.set(key, result);
  return result;
}

function showLoading(show) {
  const overlay = document.getElementById('loadingOverlay');
  if (overlay) overlay.classList.toggle('visible', show);
}

function applySettings(reader, pin) {
  applyVisualSettings();

  // Якорь-булавка: принудительный разрыв ровно на первой букве якоря —
  // эта буква открывает страницу разворота при любой вёрстке.
  // По умолчанию — текущая позиция (первая буква левой страницы);
  // при открытии книги страниц ещё нет — передаётся сохранённый якорь.
  const anchor = pin !== undefined
    ? pin
    : (State.currentBook && reader.pages.length > 0 ? captureCurrentAnchor() : null);

  // Пересчёт страниц
  const { pages, toc, pageBlocks, notePages, pinPage } =
    getPagesForBook(State.currentBook, State.settings, anchor);
  const sameBook = reader._bookId === State.currentBook?.id && reader._bookId !== undefined;
  reader._bookId = State.currentBook?.id;
  reader.setPages(pages, sameBook, pageBlocks);
  reader.setPageFlipAnimation(State.settings.pageFlipAnimation);

  // Позиция: страница с якорной буквой (pinPage — её индекс); если булавка
  // не применилась (текст не совпал) — обычный поиск по тексту якоря
  if (anchor?.blockId) {
    const page = pinPage >= 0
      ? pinPage
      : resolveAnchorPage(anchor, reader.pages, pageBlocks);
    if (page >= 0) reader.goTo(page);
  }

  // Обновляем оглавление книги
  if (toc) State.toc?.setItems(toc);

  // Обновляем карту сносок (noteId -> страница)
  State.notes?.setNotePages(notePages);
}

function scheduleReflow(reader) {
  clearTimeout(reflowTimer);
  reflowTimer = setTimeout(() => applySettings(reader), 140);
}

function schedulePersist(library) {
  clearTimeout(persistTimer);
  persistTimer = setTimeout(() => persist(library), 350);
}

/* ---------- Автосохранение ---------- */

// Штамп состояния, которое клиент уже видел (updatedAt из state.json).
// Сервер по нему отвергает запись устаревших копий.
let knownUpdatedAt = 0;

function persist(library) {
  // Настройки и последняя открытая книга — в state.json (глобально)
  const snapshot = persistSnapshot(State.settings, library.books, State.lastOpenedBookId, knownUpdatedAt);
  saveState(snapshot).then((result) => {
    if (result?.stale && result.state) {
      // Наша копия устарела (другой браузер записал новее) — принимаем
      // актуальное состояние с сервера и применяем его настройки.
      knownUpdatedAt = result.state.updatedAt ?? knownUpdatedAt;
      if (result.state.settings) {
        Object.assign(State.settings, result.state.settings);
        applyVisualSettings();
        syncSettingsUI();
      }
    } else if (result?.ok) {
      // Запись прошла — запоминаем новый штамп из локальной копии
      // (saveState уже обновил его в localStorage ответом сервера)
      const saved = loadState();
      knownUpdatedAt = saved?.updatedAt ?? knownUpdatedAt;
    }
  });
}

function captureCurrentAnchor() {
  return buildPositionAnchor(document.getElementById('book'), {
    top: 0,
    bottom: window.innerHeight,
  });
}

/** Точечное сохранение прогресса/закладок текущей книги в её meta.json.
    positionUpdatedAt — штамп позиции: сервер принимает позицию только
    от того клиента, который видел самую свежую (последний листал — тот и прав).
    После сохранения принимаем merge-результат сервера (другой браузер мог
    параллельно добавить свою закладку — она не должна потеряться). */
function persistCurrentBookMeta() {
  if (!State.currentBook?.id) return;
  const book = State.currentBook;
  saveBookMeta(book.id, {
    progress: book.progress ?? 0,
    bookmarks: book.bookmarks ?? [],
    anchor: book.anchor ?? null,
    positionUpdatedAt: book.positionUpdatedAt ?? 0,
    deletedBookmarksIds: book.deletedBookmarksIds ?? [],
  }).then((result) => {
    if (result?.ok && result.meta && book === State.currentBook) {
      // Сервер вернул merge-итог: обновляем штампы и список закладок,
      // если он изменился (чужая закладка добавилась / наша удалена)
      book.positionUpdatedAt = result.meta.positionUpdatedAt ?? book.positionUpdatedAt;
      if (Array.isArray(result.meta.bookmarks)) {
        const changed = JSON.stringify(result.meta.bookmarks) !== JSON.stringify(book.bookmarks);
        if (changed) {
          book.bookmarks = result.meta.bookmarks;
          book.deletedBookmarksIds = result.meta.deletedBookmarksIds ?? [];
          // Обновляем панель закладок, если она открыта
          const panel = document.getElementById('bookmarksPanel');
          if (panel?.classList.contains('open')) {
            const evt = new CustomEvent('bookmarks-updated');
            window.dispatchEvent(evt);
          }
        }
      }
    }
  });
}

function restoreBookPosition(reader, book) {
  if (!book || !reader) return;

  const savedAnchor = book.anchor;
  const savedProgress = typeof book.progress === 'number' && Number.isFinite(book.progress)
    ? book.progress
    : 0;

  /* Вёрстка должна быть построена с булавкой СОХРАНЁННОГО якоря — тогда
     якорная буква возглавляет страницу (pinPage) в любой конфигурации.
     Если кэш уже построен с этим якорем (например, applySettings только что
     перестроил с ним) — перестроения не будет, просто переход на pinPage. */
  const ensurePinnedLayout = () => {
    const cached = getPagesForBook(book, State.settings); // текущий кэш, без перестроения
    if (cached?.pin?.blockId === savedAnchor?.blockId &&
        cached?.pin?.previewText === savedAnchor?.previewText) {
      return cached;
    }
    const fresh = getPagesForBook(book, State.settings, savedAnchor);
    reader.setPages(fresh.pages, true, fresh.pageBlocks);
    if (fresh.toc) State.toc?.setItems(fresh.toc);
    State.notes?.setNotePages(fresh.notePages);
    return fresh;
  };

  const tryRestore = (attempt) => {
    if (!reader.pages.length) return;

    if (savedAnchor?.blockId) {
      const cached = ensurePinnedLayout();
      const pageBlocks = cached?.pageBlocks || null;
      const page = cached?.pinPage >= 0
        ? cached.pinPage
        : resolveAnchorPage(savedAnchor, reader.pages, pageBlocks);
      if (page >= 0) {
        reader.goTo(page);
        return;
      }
    }

    if (savedProgress > 0 && attempt >= 2) {
      const targetSpread = Math.max(0, Math.min(reader.pages.length - 2, Math.round(savedProgress * reader.pages.length)));
      reader.goTo(targetSpread);
    }
  };

  tryRestore(0);
  requestAnimationFrame(() => tryRestore(1));
  window.setTimeout(() => tryRestore(2), 80);
  window.setTimeout(() => tryRestore(3), 220);
}

/* ---------- Инициализация ---------- */

async function init() {
  const reader = new Reader();
  let bookmarks = null;

  // Смена режима (одна/две страницы) при изменении размера окна.
  // Якорь приходит ДО переключения режима (снятым со старой вёрстки) —
  // вёрстка перестраивается с булавкой на той же первой букве.
  reader.onCaptureAnchor = () => (reader.pages.length > 0 ? captureCurrentAnchor() : null);
  reader.onLayoutChange = (anchorBefore) => {
    if (State.currentBook) {
      applySettings(reader, anchorBefore ?? undefined);
      restoreBookPosition(reader, State.currentBook);
    }
  };

  // Восстановление из localStorage и сервера
  const saved = loadState();
  const serverState = await loadStateFromServer();
  const initialState = serverState ?? saved;
  if (initialState?.settings) Object.assign(State.settings, initialState.settings);
  knownUpdatedAt = initialState?.updatedAt ?? 0;

  // Синхронизируем ВСЕ контролы настроек с восстановленными значениями
  // (в HTML у слайдеров жёсткие value по умолчанию — без этого панель
  // показывала бы 18/1.6/60 при фактических 28/2.5/…)
  syncSettingsUI();

  // Синхронизируем переключатель анимации с восстановленными настройками
  const flipToggle = document.getElementById('setPageFlipAnimation');
  if (flipToggle) {
    flipToggle.checked = State.settings.pageFlipAnimation;
    reader.setPageFlipAnimation(State.settings.pageFlipAnimation);
  }

  // Переключатель переноса слов
  const hyphToggle = document.getElementById('setHyphenation');
  if (hyphToggle) {
    hyphToggle.checked = State.settings.hyphenation !== false;
    hyphToggle.addEventListener('change', () => {
      State.settings.hyphenation = hyphToggle.checked;
      applyVisualSettings();
      scheduleReflow(reader);
      schedulePersist(library);
    });
  }

  // Библиотека
  const library = new Library(async (book) => {
    State.currentBook = book;
    State.lastOpenedBookId = book.id;
    library.close();
    bookmarks.setBook(book);
    bookmarks.close();
    State.toc.close();
    State.restoringPosition = true;
    showLoading(true);

    // Если текста нет — загружаем с сервера (FB2 приходит блоками)
    if (!book.text && !book.blocks) {
      const data = await loadBookText(book.id);
      if (data?.text) {
        book.text = data.text;
      } else if (data?.blocks) {
        book.blocks = data.blocks;
      }
    }

    // Сбрасываем состояние сносок и заполняем их тексты (для тултипа)
    State.notes?.reset();
    if (Array.isArray(book.blocks)) {
      const noteTexts = {};
      for (const b of book.blocks) {
        if (b.type === 'note' && b.noteId) noteTexts[b.noteId] = b.text;
      }
      State.notes?.setNoteTexts(noteTexts);
    }
     // Предзагружаем картинки из FB2 (обложка/иллюстрации) и запоминаем их
     // размеры — иначе пагинатор измерит <img> как 0px (загрузка асинхронная).
    if (Array.isArray(book.blocks)) {
      const hadNew = book.blocks.some((b) => b.type === 'image' && b.src && !imageSizeCache.has(imgCacheKey(book.id, b.src)));
      await preloadBookImages(book.blocks, book.id);
      // Если размеры получены впервые — сбрасываем кэш страниц: в нём
      // картинки могли быть «схлопнуты» в 0px (измерение до загрузки).
      if (hadNew) State.pageCache.clear();
     }
    // Даём браузеру отрисовать индикатор, затем строим страницы
    // Даём браузеру отрисовать индикатор, затем строим страницы.
    // Передаём сохранённый якорь книги: вёрстка сразу строится с булавкой —
    // якорная буква возглавит страницу, restoreBookPosition лишь перейдёт
    // на неё (без повторного перестроения).
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        applySettings(reader, book.anchor);
        restoreBookPosition(reader, book);
        showLoading(false);
        window.setTimeout(() => {
          State.restoringPosition = false;
          if (State.currentBook && reader.pages.length > 0) {
            State.currentBook.progress = reader.progress.ratio;
            State.currentBook.anchor = captureCurrentAnchor();
            debouncedSave(() => persistCurrentBookMeta());
          }
        }, 140);
      });
    });
  });

  // Загружаем книги с сервера (из папки books/)
  let serverBooks = await loadBooksFromServer();

  // Сеть могла подвести (таймаут/обрыв) — при этом возвращается null.
  // Пробуем ещё раз: иначе миграция ниже решит, что books/ пуста,
  // и скопирует книги из state.json заново → дубликаты.
  if (serverBooks === null) {
    console.warn('[main] Сервер не ответил со списком книг — повторяю запрос через 1.5с...');
    await new Promise((r) => setTimeout(r, 1500));
    serverBooks = await loadBooksFromServer();
  }

  if (serverBooks?.length) {
    console.log(`[main] При старте книг на сервере: ${serverBooks.length}`);
  } else if (serverBooks === null) {
    // Сервер так и не ответил — НЕ мигрируем (это создало бы дубликаты)
    console.warn('[main] Сервер недоступен — миграция из state.json отменена (books/ может быть не пуста!)');
    serverBooks = [];
  } else if (initialState?.books?.length) {
    // Миграция ТОЛЬКО когда сервер ТОЧНО ответил, что books/ пуста
    console.log(`[main] Миграция: books/ пуста, копирую ${initialState.books.length} книг(и) из state.json...`);
    for (const b of initialState.books) {
      // Сохраняем под ИСХОДНЫМ именем файла (id книги = имя файла без расширения).
      // Без originalName сервер назвал бы файл по title → «Республика Ночь.fb2»
      // вместо «Зотов - Республика Ночь.fb2» → дубликат.
      const ext = b.format === 'fb2' ? '.fb2' : b.format === 'epub' ? '.epub' : '.txt';
      const baseName = b.id || b.title || 'book';
      const originalName = baseName.toLowerCase().endsWith(ext) ? baseName : baseName + ext;
      const bookWithText = {
        ...b,
        originalName,
        // Если текста нет — используем демо-текст
        text: b.text || DEMO_TEXT,
      };
      console.log(`[main] Миграция: сохраняю «${originalName}»`);
      await saveBookToServer(bookWithText);
    }
    serverBooks = await loadBooksFromServer();
    console.log(`[main] После миграции книг на сервере: ${serverBooks?.length ?? 'нет ответа'}`);
  }

  if (serverBooks?.length) {
    // Диагностика: книги с одинаковым названием — возможные дубликаты
    const byTitle = new Map();
    for (const b of serverBooks) {
      const key = (b.title || '').trim().toLowerCase();
      if (!key) continue;
      if (byTitle.has(key)) {
        console.warn(`[main] ВНИМАНИЕ: дубликат по названию «${b.title}» (id: "${byTitle.get(key)}" и "${b.id}")`);
      } else {
        byTitle.set(key, b.id);
      }
    }
    for (const b of serverBooks) {
      library.addBook(b);
    }
  } else {
    const demoBook = {
      id: 'demo',
      title: 'Тихий вечер',
      author: 'Демо-книга',
      text: DEMO_TEXT,
      progress: 0,
      palette: ['#8d6e63', '#5d4037'],
    };
    library.addBook(demoBook);
  }
  bookmarks = new Bookmarks(reader, () => {
    debouncedSave(() => persistCurrentBookMeta());
  });
  State.toc = new TOC(reader);
  State.notes = new Notes(reader);

  // Открытие одной правой панели закрывает другую
  const origBmOpen = bookmarks.open.bind(bookmarks);
  bookmarks.open = () => { State.toc.close(); origBmOpen(); };
  const origTocOpen = State.toc.open.bind(State.toc);
  State.toc.open = () => { bookmarks.close(); origTocOpen(); };

  State.currentBook = null;
  bookmarks.setBook({ bookmarks: [] });

  // Сохраняем прогресс при перелистывании
  reader.onPageChange = () => {
    bookmarks.onPageChange();
    // Пока открыт текст сноски (перешли по ссылке, но не вернулись «Назад»),
    // позицию и прогресс НЕ сохраняем: при случайном закрытии книги останется
    // место чтения со ссылкой на сноску, а не конец книги у примечаний.
    const viewingNote = State.notes?.viewingNote === true;
    if (State.currentBook && reader.pages.length > 0 && !State.restoringPosition && !viewingNote) {
      State.currentBook.progress = reader.progress.ratio;
      State.currentBook.anchor = captureCurrentAnchor();
      // Штамп позиции: «я видел позицию сейчас» — сервер примет её,
      // даже если другой браузер параллельно сохранил свою (более старую)
      State.currentBook.positionUpdatedAt = Date.now();
      debouncedSave(() => persistCurrentBookMeta());
    }
  };

  // Кнопка «Библиотека» в тулбаре
  document.getElementById('btnLibrary').addEventListener('click', () => {
    if (library.isOpen) library.close(); else library.open();
  });

  // Стартовый экран — библиотека
  library.open();
  requestAnimationFrame(() => {
    applyVisualSettings();
    reader.setPages([], true);
  });

  // Тулбар: показ при движении мыши / скрытие
  const toolbar = document.getElementById('toolbar');
  let hideTimer;
  const showToolbar = () => {
    toolbar.classList.add('visible');
    clearTimeout(hideTimer);
    hideTimer = setTimeout(() => toolbar.classList.remove('visible'), 2500);
  };
  document.addEventListener('mousemove', showToolbar);
  document.addEventListener('touchstart', showToolbar, { passive: true });
  showToolbar(); // показываем сразу при загрузке

  // Панель настроек
  const panel = document.getElementById('settingsPanel');
  const toggleSettings = (force) => {
    const shouldOpen = typeof force === 'boolean' ? force : !panel.classList.contains('open');
    panel.classList.toggle('open', shouldOpen);
  };
  document.getElementById('btnSettings').addEventListener('click', () => toggleSettings());
  document.getElementById('settingsClose').addEventListener('click', () => toggleSettings(false));
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && panel.classList.contains('open')) toggleSettings(false);
  });

  // Слайдеры
  document.getElementById('setFontSize').addEventListener('input', (e) => {
    State.settings.fontSize = +e.target.value;
    applyVisualSettings();
    scheduleReflow(reader);
    schedulePersist(library);
  });
  document.getElementById('setLineHeight').addEventListener('input', (e) => {
    State.settings.lineHeight = +e.target.value;
    applyVisualSettings();
    scheduleReflow(reader);
    schedulePersist(library);
  });
  document.getElementById('setMargins').addEventListener('input', (e) => {
    State.settings.margins = +e.target.value;
    applyVisualSettings();
    scheduleReflow(reader);
    schedulePersist(library);
  });
  document.getElementById('setVMargins').addEventListener('input', (e) => {
    State.settings.vmargins = +e.target.value;
    applyVisualSettings();
    scheduleReflow(reader);
    schedulePersist(library);
  });

  // Темы
  document.getElementById('themePicker').addEventListener('click', (e) => {
    const dot = e.target.closest('.theme-dot');
    if (!dot) return;
    State.settings.theme = dot.dataset.themeName;
    applyVisualSettings();
    scheduleReflow(reader);
    schedulePersist(library);
  });

  // Переключатель анимации перелистывания
  if (flipToggle) {
    flipToggle.addEventListener('change', () => {
      State.settings.pageFlipAnimation = flipToggle.checked;
      reader.setPageFlipAnimation(flipToggle.checked);
      schedulePersist(library);
    });
  }

  // Режим погружения: клик по центру
  document.getElementById('scene').addEventListener('click', (e) => {
    const r = e.currentTarget.getBoundingClientRect();
    const cx = (e.clientX - r.left) / r.width;
    if (cx > 0.35 && cx < 0.65) {
      document.body.classList.toggle('immersive');
    }
  });

  // Пересчёт при ресайзе
  let resizeTimer;
  window.addEventListener('resize', () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => applySettings(reader), 200);
  });

  // Сохранение при закрытии вкладки
  window.addEventListener('beforeunload', () => persist(library));

  // Синхронизация при возврате в окно: другой браузер мог изменить настройки,
  // пока эта вкладка была в фоне. Подтягиваем свежее состояние с сервера.
  let syncing = false;
  const syncFromServer = async () => {
    if (syncing || document.hidden) return;
    syncing = true;
    try {
      const fresh = await loadStateFromServer();
      if (fresh?.settings && (fresh.updatedAt ?? 0) > knownUpdatedAt) {
        knownUpdatedAt = fresh.updatedAt;
        Object.assign(State.settings, fresh.settings);
        applyVisualSettings();
        syncSettingsUI();
        // Восстановление по якорю-булавке. restoringPosition блокирует
        // persist ПРОМЕЖУТОЧНЫХ позиций (пересъём якоря во время
        // восстановления «уводил» букву — якоря скакали между
        // вкладками/браузерами). Снимаем по таймеру: tryRestore растянут
        // на ~220мс, 500мс — с запасом.
        State.restoringPosition = true;
        try {
          applySettings(reader);
          restoreBookPosition(reader, State.currentBook);
        } finally {
          window.setTimeout(() => { State.restoringPosition = false; }, 500);
        }
      }
      // Meta текущей книги: другой браузер мог добавить/удалить закладку
      // или уйти дальше по тексту — подтягиваем и обновляем панель.
      // syncing=true: мы в цикле синхронизации (restoringPosition поднят
      // нами для блокировки persist) — meta обработать НАДО, это не открытие
      // книги. Позиция ниже применяется только если серверная свежее.
      if (State.currentBook?.id) {
        const meta = await loadBookMeta(State.currentBook.id);
        if (meta && (!State.restoringPosition || syncing)) {
          const serverPos = meta.positionUpdatedAt ?? 0;
          const localPos = State.currentBook.positionUpdatedAt ?? 0;
          // Позиция: серверная свежее — принимаем её (без пересохранения).
          // restoringPosition поднят на время restore: onPageChange во время
          // восстановления не должен переснимать якорь с промежуточной
          // позиции (иначе буква «уезжала» и якоря скакали между
          // вкладками/браузерами).
          if (serverPos > localPos && typeof meta.progress === 'number') {
            State.currentBook.progress = meta.progress;
            State.currentBook.anchor = meta.anchor ?? null;
            State.currentBook.positionUpdatedAt = serverPos;
            State.restoringPosition = true;
            try {
              restoreBookPosition(reader, State.currentBook);
            } finally {
              window.setTimeout(() => { State.restoringPosition = false; }, 500);
            }
          }
          // Закладки: merge уже сделан на сервере — берём итоговый список
          if (Array.isArray(meta.bookmarks)) {
            const hadCount = (State.currentBook.bookmarks ?? []).length;
            State.currentBook.bookmarks = meta.bookmarks;
            State.currentBook.deletedBookmarksIds = meta.deletedBookmarksIds ?? [];
            if (meta.bookmarks.length !== hadCount) {
              bookmarks._render();
              bookmarks._updateMarker();
            }
          }
        }
      }
    } finally {
      syncing = false;
    }
  };
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) syncFromServer();
  });
  window.addEventListener('focus', syncFromServer);
}

init();
