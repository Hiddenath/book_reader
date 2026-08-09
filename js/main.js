/* ===== BookHaven 3D — инициализация, состояние, демо-контент ===== */

import { Reader } from './reader.js?v=20260809b';
import { Library } from './library.js?v=20260810b';
import { Bookmarks } from './bookmarks.js?v=20260806d';
import { TOC } from './toc.js?v=20260806d';
import { loadState, loadStateFromServer, loadBooksFromServer, loadBookText, saveBookToServer, saveBookMeta, persistSnapshot, debouncedSave, saveState } from './storage.js?v=20260810b';
import { buildPositionAnchor, resolveAnchorPage } from './position.js?v=20260809c';

const State = {
  currentBook: null,
  lastOpenedBookId: null,
  restoringPosition: false,
  pageCache: new Map(),
  toc: null,   // экземпляр класса TOC
  settings: {
    fontSize: 18,
    lineHeight: 1.6,
    margins: 60,
    theme: 'paper',
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
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function renderBlocks(blocks) {
  return blocks.map(({ text, blockId, type = 'paragraph', level = 0 }) => {
    const escaped = escapeHtml(text);
    switch (type) {
      case 'chapter':
        return `<h2 class="chapter-title" data-block-id="${blockId}" data-level="${level}">${escaped}</h2>`;
      case 'subtitle':
        return `<h3 class="subtitle" data-block-id="${blockId}">${escaped}</h3>`;
      case 'epigraph':
        return `<blockquote class="epigraph" data-block-id="${blockId}">${escaped}</blockquote>`;
      case 'cite':
        return `<blockquote class="cite" data-block-id="${blockId}">${escaped}</blockquote>`;
      case 'poem':
        return `<pre class="poem" data-block-id="${blockId}">${escaped}</pre>`;
      default:
        return `<p data-block-id="${blockId}">${escaped}</p>`;
    }
  }).join('');
}

function paginate(content, settings, bookId = 'book') {
  const measurer = document.createElement('div');
  measurer.className = 'page-content';
  measurer.style.cssText = `
    position: absolute; visibility: hidden; pointer-events: none;
    height: auto; inset: auto;
    font-size: ${settings.fontSize}px;
    line-height: ${settings.lineHeight};
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

  // Отступы текста на странице: в single-режиме верхний 40px и нижний увеличен,
  // в двойном — стандартные 48/48 (должны совпадать с CSS padding страницы).
  const single = book.classList.contains('single-page');
  const padTop = single ? 40 : 48;
  const padBottom = single ? 90 : 48;

  const contentW = pageW - settings.margins * 2;
  const contentH = pageH - padTop - padBottom;
  const lineH = settings.fontSize * settings.lineHeight;

  measurer.style.width = `${contentW}px`;

  // Поддержка блоков (новый формат) или plain text (старый)
  const blocks = Array.isArray(content)
    ? content
    : (content || '').trim().split(/\n\s*\n/).map(p => ({ type: 'paragraph', text: p.trim() })).filter(b => b.text);

  const pages = [];
  const pageBlocks = [];   // метаданные блоков: pageBlocks[i] = [{ blockId, text }]
  const toc = [];           // оглавление: [{ title, page }]
  let currentPage = [];
  let currentBlocks = [];
  let currentH = 0;
  let sourceIndex = 0;      // стабильный номер ИСХОДНОГО блока (не чанка!)

  for (const block of blocks) {
    // Разрыв страницы: принудительно завершаем текущую страницу
    if (block.type === 'pagebreak') {
      if (currentPage.length > 0) {
        pages.push(renderBlocks(currentPage));
        pageBlocks.push(currentBlocks);
        currentPage = [];
        currentBlocks = [];
        currentH = 0;
      }
      continue;
    }

    // Заголовок главы — фиксируем номер страницы для оглавления
    if (block.type === 'chapter') {
      toc.push({ title: block.text, page: pages.length });
    }

    const blockHtml = renderBlocks([{ ...block, blockId: 'temp' }]);

    // Измеряем с невидимым префиксом: так абзац НЕ является first-child,
    // и к нему не применяется ::first-letter (буквица), которая завышала высоту.
    // margin-bottom уже включён в измерение — отдельный gap не нужен.
    measurer.innerHTML = `<span style="display:block;height:0"></span>${blockHtml}`;
    const blockH = measurer.getBoundingClientRect().height;
    const blockTotal = blockH;

    if (currentH + blockTotal > contentH && currentPage.length > 0) {
      pages.push(renderBlocks(currentPage));
      pageBlocks.push(currentBlocks);
      currentPage = [];
      currentBlocks = [];
      currentH = 0;
    }

    // ВАЖНО: один стабильный id на ИСХОДНЫЙ блок текста.
    // Длинный абзац, разрезанный на несколько страниц, сохраняет ОДИН id,
    // чтобы закладки не «съезжали» при смене размера шрифта/окна.
    const blockId = makeStableBlockId(bookId, sourceIndex++);

    // Блок длиннее целой страницы — делим его
    if (blockH > contentH && currentPage.length === 0) {
      const chunks = splitParagraph(measurer, block.text, contentH, lineH);
      for (let i = 0; i < chunks.length; i++) {
        const chunkBlock = {
          text: chunks[i],
          type: block.type,
          level: block.level,
          blockId,
        };
        if (i < chunks.length - 1) {
          pages.push(renderBlocks([chunkBlock]));
          pageBlocks.push([{ blockId, text: chunks[i] }]);
        } else {
          currentPage.push(chunkBlock);
          currentBlocks.push({ blockId, text: chunks[i] });
          currentH = measurerLastH;
        }
      }
      continue;
    }

    currentPage.push({
      text: block.text,
      type: block.type,
      level: block.level,
      blockId,
    });
    currentBlocks.push({ blockId, text: block.text });
    currentH += blockTotal;
  }

  if (currentPage.length > 0) {
    pages.push(renderBlocks(currentPage));
    pageBlocks.push(currentBlocks);
  }

  measurer.remove();

  if (pages.length % 2 !== 0) {
    pages.push('');
    pageBlocks.push([]);
  }
  return { pages, toc, pageBlocks };
}

// Высота последнего измеренного чанка (заполняется в splitParagraph)
let measurerLastH = 0;

/* Делит длинный абзац на куски, каждый из которых помещается в contentH.
   Бинарным поиском по словам находит максимальный влезающий префикс. */
function splitParagraph(measurer, para, contentH, lineH) {
  const words = para.split(/\s+/);
  const chunks = [];
  let rest = words;

  const PREFIX = '<span style="display:block;height:0"></span>';

  while (rest.length > 0) {
    let lo = 1, hi = rest.length, fit = 1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      measurer.innerHTML = `${PREFIX}<p>${rest.slice(0, mid).join(' ')}</p>`;
      if (measurer.getBoundingClientRect().height <= contentH) {
        fit = mid;
        lo = mid + 1;
      } else {
        hi = mid - 1;
      }
    }
    chunks.push(rest.slice(0, fit).join(' '));
    rest = rest.slice(fit);
  }

  // Высота последнего чанка — для продолжения накопления страницы
  measurer.innerHTML = `${PREFIX}<p>${chunks[chunks.length - 1]}</p>`;
  measurerLastH = measurer.getBoundingClientRect().height;
  return chunks;
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
  document.documentElement.dataset.theme = s.theme;

  document.querySelectorAll('.theme-dot').forEach(d =>
    d.classList.toggle('active', d.dataset.themeName === s.theme));
}

function getPageCacheKey(book, settings) {
  const bookId = book?.id ?? 'demo';
  const bookEl = document.getElementById('book');
  const mode = bookEl?.classList.contains('single-page') ? 'single' : 'double';
  // Размер книги в ключе: при изменении ширины окна макет должен перестраиваться,
  // иначе закэшированные страницы (старой ширины) выходят за нижнюю грань.
  const size = bookEl ? `${bookEl.offsetWidth}x${bookEl.offsetHeight}` : '0x0';
  return `${bookId}|${settings.fontSize}|${settings.lineHeight}|${settings.margins}|${mode}|${size}`;
}

function getPagesForBook(book, settings) {
  const key = getPageCacheKey(book, settings);
  if (State.pageCache.has(key)) return State.pageCache.get(key);

  const content = book?.blocks || book?.text || DEMO_TEXT;
  const { pages, toc, pageBlocks } = paginate(content, settings, book?.id ?? 'demo');
  State.pageCache.set(key, { pages, toc, pageBlocks });
  return { pages, toc, pageBlocks };
}

function showLoading(show) {
  const overlay = document.getElementById('loadingOverlay');
  if (overlay) overlay.classList.toggle('visible', show);
}

function applySettings(reader) {
  applyVisualSettings();

  // Пересчёт страниц с сохранением позиции
  const { pages, toc, pageBlocks } = getPagesForBook(State.currentBook, State.settings);
  const sameBook = reader._bookId === State.currentBook?.id && reader._bookId !== undefined;
  reader._bookId = State.currentBook?.id;
  reader.setPages(pages, sameBook, pageBlocks);

  // Обновляем оглавление книги
  if (toc) State.toc?.setItems(toc);
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

function persist(library) {
  // Настройки и последняя открытая книга — в state.json (глобально)
  saveState(persistSnapshot(State.settings, library.books, State.lastOpenedBookId));
}

function captureCurrentAnchor() {
  return buildPositionAnchor(document.getElementById('book'), {
    top: 0,
    bottom: window.innerHeight,
  });
}

/** Точечное сохранение прогресса/закладок текущей книги в её meta.json. */
function persistCurrentBookMeta() {
  if (!State.currentBook?.id) return;
  saveBookMeta(State.currentBook.id, {
    progress: State.currentBook.progress ?? 0,
    bookmarks: State.currentBook.bookmarks ?? [],
    anchor: State.currentBook.anchor ?? null,
  });
}

function restoreBookPosition(reader, book) {
  if (!book || !reader) return;

  const savedAnchor = book.anchor;
  const savedProgress = typeof book.progress === 'number' && Number.isFinite(book.progress)
    ? book.progress
    : 0;

  // Метаданные блоков текущей пагинации — для поиска по тексту закладки
  const cached = getPagesForBook(book, State.settings);
  const pageBlocks = cached?.pageBlocks || null;

  const tryRestore = (attempt) => {
    if (!reader.pages.length) return;

    if (savedAnchor?.blockId) {
      // Точный поиск: по стабильному id, с текстовой проверкой и фолбэком
      const page = resolveAnchorPage(savedAnchor, reader.pages, pageBlocks);
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

  // Смена режима (одна/две страницы) при изменении размера окна
  reader.onLayoutChange = () => {
    if (State.currentBook) {
      applySettings(reader);
      restoreBookPosition(reader, State.currentBook);
    }
  };

  // Восстановление из localStorage и сервера
  const saved = loadState();
  const serverState = await loadStateFromServer();
  const initialState = serverState ?? saved;
  if (initialState?.settings) Object.assign(State.settings, initialState.settings);

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

    // Даём браузеру отрисовать индикатор, затем строим страницы
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        applySettings(reader);
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
    if (State.currentBook && reader.pages.length > 0 && !State.restoringPosition) {
      State.currentBook.progress = reader.progress.ratio;
      State.currentBook.anchor = captureCurrentAnchor();
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

  // Темы
  document.getElementById('themePicker').addEventListener('click', (e) => {
    const dot = e.target.closest('.theme-dot');
    if (!dot) return;
    State.settings.theme = dot.dataset.themeName;
    applyVisualSettings();
    scheduleReflow(reader);
    schedulePersist(library);
  });

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
}

init();
