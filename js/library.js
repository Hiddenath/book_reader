/* ===== BookHaven 3D — библиотека: grid книг, добавление TXT/EPUB/FB2 =====
   Книги хранятся на сервере в папке books/, при добавлении файл копируется туда.
   Метаданные (название, автор, прогресс, закладки) — в meta.json книги. */

import { parseBook } from './parsers.js?v=20260806d';
import { saveBookToServer, deleteBookFromServer } from './storage.js?v=20260830b';

// API-сервер (для загрузки обложек из FB2)
const API_PORT = 8001;
const SERVER_URL = `${location.protocol}//${location.hostname}:${API_PORT}`;

// Палитры обложек: выбираются по порядковому номеру книги в библиотеке
const COVER_PALETTES = [
  ['#8d6e63', '#5d4037'],
  ['#7b1fa2', '#4a148c'],
  ['#0277bd', '#01579b'],
  ['#2e7d32', '#1b5e20'],
  ['#c62828', '#8e0000'],
  ['#f9a825', '#f57f17'],
  ['#00838f', '#006064'],
  ['#6a3d9a', '#3b1f5e'],
];

/* Читает FB2-файл с УЧЁТОМ КОДИРОВКИ. Многие классические FB2 (особенно
   с royallib и старых библиотек) сохранены в windows-1251 — XML-декларация
   в первых байтах файла это объявляет: <?xml ... encoding="windows-1251"?>.
   file.text() всегда читает как UTF-8 → кракозябры во всём тексте.
   Здесь: читаем сырые байты, находим кодировку в декларации, декодируем
   через TextDecoder (поддерживает windows-1251, koi8-r, utf-8 и др.).
   Если кодировка не указана или не поддерживается — UTF-8 (стандарт FB2). */
async function readFb2WithEncoding(file) {
  const buf = await file.arrayBuffer();
  const bytes = new Uint8Array(buf);
  // XML-декларация — в первых ~300 байтах; ищем encoding="..."
  const head = new TextDecoder('utf-8').decode(bytes.subarray(0, 300));
  const m = head.match(/encoding\s*=\s*["']([\w-]+)["']/i);
  let enc = 'utf-8';
  if (m) {
    const declared = m[1].toLowerCase();
    // Нормализуем синонимы
    const aliases = { 'windows-1251': 'windows-1251', 'cp1251': 'windows-1251', 'cp-1251': 'windows-1251', 'koi8-r': 'koi8-r', 'koi8r': 'koi8-r', 'utf-8': 'utf-8', 'utf8': 'utf-8' };
    enc = aliases[declared] || 'utf-8';
  }
  try {
    return new TextDecoder(enc).decode(bytes);
  } catch {
    // Неизвестная кодировка — UTF-8 как фолбэк (стандарт FB2)
    return new TextDecoder('utf-8').decode(bytes);
  }
}

export class Library {
  constructor(onOpenBook) {
    this.el = document.getElementById('library');
    this.grid = document.getElementById('bookGrid');
    this.countEl = document.getElementById('libraryCount');
    this.onOpenBook = onOpenBook;
    this.books = [];

    const fabAdd = document.getElementById('fabAdd');
    const fileInput = document.getElementById('fileInput');
    const overlay = document.getElementById('dropOverlay');

    if (fabAdd && fileInput) {
      fabAdd.addEventListener('click', () => {
        // Книга открыта: FAB управляет диктором, а не добавлением книг.
        // Библиотека открыта → классическое добавление книги.
        // __narratorFabAction возвращает false, если это не режим диктора.
        if (typeof window.__narratorFabAction === 'function') {
          if (window.__narratorFabAction() !== false) return;
        }
        fileInput.click();
      });
      fileInput.addEventListener('change', (e) => {
        for (const f of e.target.files || []) this._importFile(f);
        e.target.value = '';
      });
    }

    // Drag & drop
    let dragDepth = 0;
    if (overlay) {
      window.addEventListener('dragenter', (e) => {
        if (e.dataTransfer?.types.includes('Files')) {
          dragDepth++;
          overlay.classList.add('active');
        }
      });
      window.addEventListener('dragleave', () => {
        if (--dragDepth <= 0) { dragDepth = 0; overlay.classList.remove('active'); }
      });
      window.addEventListener('dragover', (e) => e.preventDefault());
      window.addEventListener('drop', (e) => {
        e.preventDefault();
        dragDepth = 0;
        overlay.classList.remove('active');
        for (const f of e.dataTransfer?.files || []) this._importFile(f);
      });
    }
  }

  addBook(book) {
    const normalizedBook = {
      ...book,
      palette: Array.isArray(book?.palette) && book.palette.length >= 2
        ? book.palette
        : COVER_PALETTES[this.books.length % COVER_PALETTES.length],
    };
    this.books.push(normalizedBook);
    this._render();
  }

  open() { this.el.classList.add('open'); }
  close() { this.el.classList.remove('open'); }
  get isOpen() { return this.el.classList.contains('open'); }

  async _importFile(file) {
    if (!/\.(txt|epub|fb2)$/i.test(file.name)) return;

    try {
      // Определяем формат
      const format = file.name.toLowerCase().endsWith('.fb2') ? 'fb2' : 
                    file.name.toLowerCase().endsWith('.epub') ? 'epub' : 'txt';
      
      let book;
      
      if (format === 'fb2') {
        // FB2: отправляем оригинальный файл на сервер,
        // сервер сохранит его под исходным именем и извлечёт метаданные.
        // Читаем С УЧЁТОМ КОДИРОВКИ из XML-декларации (windows-1251 и др.)
        const fb2Content = await readFb2WithEncoding(file);
        book = {
          originalName: file.name,   // Исходное имя файла — сервер сохранит его
          title: file.name.replace(/\.fb2$/i, ''),
          author: 'Неизвестный автор',
          format: 'fb2',
          fb2_content: fb2Content,   // Оригинальный файл (декодированный)
          progress: 0,
          palette: COVER_PALETTES[this.books.length % COVER_PALETTES.length],
        };
      } else {
        // Для TXT/EPUB используем парсер в браузере
        const parsed = await parseBook(file);
        book = {
          originalName: file.name,
          title: parsed.title || 'Без названия',
          author: parsed.author || 'Неизвестный автор',
          format: format,
          text: parsed.text,
          progress: 0,
          palette: COVER_PALETTES[this.books.length % COVER_PALETTES.length],
        };
      }

      // Сохраняем на сервер (копируем в папку books/ под исходным именем)
      const result = await saveBookToServer(book);
      if (!result) {
        console.warn('[library] Не удалось сохранить книгу на сервер, работаем локально');
      } else {
        console.log(`[library] Книга сохранена: id="${result.id}", файл="${result.fileName}"`);
        if (result.fileName && result.fileName !== file.name) {
          console.warn(`[library] ВНИМАНИЕ: файл сохранён под другим именем «${result.fileName}» вместо «${file.name}» — на сервере мог появиться дубликат`);
        }
        // Сервер вернул id (имя файла) и метаданные — используем их
        book.id = result.id || book.id;
        if (result.meta) {
          book.title = result.meta.title || book.title;
          book.author = result.meta.author || book.author;
          book.format = result.meta.format || book.format;
          book.hasCover = result.meta.hasCover === true;
        }
      }

      this.addBook(book);
    } catch (err) {
      console.error('Ошибка импорта книги:', err);
      alert(`Не удалось открыть файл: ${err.message}`);
    }
  }

  async removeBook(bookId) {
    const index = this.books.findIndex((b) => b.id === bookId);
    if (index < 0) return;

    // Удаляем с сервера
    await deleteBookFromServer(bookId);

    // Удаляем локально
    this.books.splice(index, 1);
    this._render();
  }

  _render() {
    if (this.countEl) {
      this.countEl.textContent = `${this.books.length} ${plural(this.books.length)}`;
    }
    if (this.grid) {
      this.grid.innerHTML = '';
    }
    for (const book of this.books) {
      const card = document.createElement('div');
      card.className = 'book-card';
      const palette = Array.isArray(book?.palette) && book.palette.length >= 2
        ? book.palette
        : COVER_PALETTES[0];
      const titleText = typeof book?.title === 'string' && book.title.trim()
        ? book.title
        : 'Без названия';
      const authorText = typeof book?.author === 'string' && book.author.trim()
        ? book.author
        : 'Неизвестный автор';
      const title = escapeHtml(titleText);
      const author = escapeHtml(authorText);
      const progressText = typeof book?.progress === 'number' && Number.isFinite(book.progress) && book.progress > 0
        ? `${Math.round(book.progress * 100)}%`
        : 'Не начата';
      const coverA = Array.isArray(palette) && typeof palette[0] === 'string' ? palette[0] : COVER_PALETTES[0][0];
      const coverB = Array.isArray(palette) && typeof palette[1] === 'string' ? palette[1] : COVER_PALETTES[0][1];
       // Обложка из FB2 (если есть) — картинка поверх градиента
      const hasCover = book?.hasCover === true;
      const coverImg = hasCover
         ? `<img class="book-cover-img" src="${SERVER_URL}/books/${encodeURIComponent(book.id)}/cover" alt="" loading="lazy" />`
         : '';
      card.innerHTML = `
         <div class="book-cover${hasCover ? ' has-image' : ''}" style="--cover-a:${coverA};--cover-b:${coverB}">
           ${coverImg}
        </div>
        <div class="book-meta">
          <div class="book-meta-title">${title}</div>
          <div class="book-meta-progress">${progressText}</div>
        </div>
        <button class="book-delete" title="Удалить книгу">
          <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M19 6.41 17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z"/></svg>
        </button>`;

      card.addEventListener('click', (e) => {
        // closest: клик может прийти по SVG-иконке внутри кнопки удаления
        if (e.target.closest('.book-delete')) return;
        this.onOpenBook?.(book);
      });

      const deleteBtn = card.querySelector('.book-delete');
      deleteBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        if (confirm(`Удалить книгу «${titleText}»?`)) {
          this.removeBook(book.id);
        }
      });

      if (this.grid) {
        this.grid.appendChild(card);
      }
    }
  }
}

function plural(n) {
  const mod10 = n % 10, mod100 = n % 100;
  if (mod10 === 1 && mod100 !== 11) return 'книга';
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) return 'книги';
  return 'книг';
}

function escapeHtml(s) {
  const value = s == null ? '' : String(s);
  return value.replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}
