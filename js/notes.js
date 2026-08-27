/* ===== BookHaven 3D — сноски (примечания) =====
   Механика аналогична оглавлению: клик по ссылке-сноске ведёт на страницу
   с текстом примечания, кнопка «Назад» возвращает к месту чтения.
   При наведении на ссылку появляется всплывающая подсказка с текстом сноски.
   Бокового меню нет — только переходы туда-обратно и тултип. */

import { buildPositionAnchor } from './position.js?v=20260809c';

export class Notes {
  constructor(reader) {
    this.reader = reader;
    this.notePages = {};   // noteId -> индекс страницы с текстом сноски
    this.noteTexts = {};   // noteId -> текст сноски (для тултипа)
    this.stack = [];       // стек якорей для возврата (вложенные сноски)

    this._createTooltip();
    this._createBackButton();
    this._bindEvents();
  }

  /* ---------- Публичное API ---------- */

  /** Устанавливает карту noteId -> страница (строится в пагинаторе). */
  setNotePages(map) {
    this.notePages = map || {};
  }

  /** Устанавливает тексты сносок (из блоков книги). */
  setNoteTexts(map) {
    this.noteTexts = map || {};
  }

  /** Сброс при смене книги. */
  reset() {
    this.stack = [];
    this.notePages = {};
    this.noteTexts = {};
    this._hideBackButton();
    this._hideTooltip();
  }

  /** Идёт ли сейчас просмотр сноски (есть несовершённые переходы «назад»).
      Пока true — позиция чтения НЕ сохраняется, чтобы при случайном закрытии
      книги не запомнилось место в конце (у примечаний), а осталась позиция
      сноски в тексте. */
  get viewingNote() {
    return this.stack.length > 0;
  }

  /* ---------- Создание DOM-элементов ---------- */

  _createTooltip() {
    this.tooltip = document.createElement('div');
    this.tooltip.className = 'note-tooltip';
    this.tooltip.setAttribute('role', 'tooltip');
    document.body.appendChild(this.tooltip);
  }

  _createBackButton() {
    this.backBtn = document.createElement('button');
    this.backBtn.className = 'note-back-btn';
    this.backBtn.innerHTML = '← Назад к тексту';
    this.backBtn.title = 'Вернуться к месту чтения';
    this.backBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      this.goBack();
    });
    document.body.appendChild(this.backBtn);
  }

  /* ---------- События ---------- */

  _bindEvents() {
    const book = document.getElementById('book');
    if (!book) return;

    // Клик по ссылке-сноске (делегирование)
    book.addEventListener('click', (e) => {
      const ref = e.target.closest('.note-ref');
      if (!ref) return;
      e.stopPropagation();
      e.preventDefault();
      this.openNote(ref.dataset.noteId);
    });

    // Наведение — подсказка
    book.addEventListener('mouseover', (e) => {
      const ref = e.target.closest('.note-ref');
      if (ref) this._showTooltip(ref);
    });
    book.addEventListener('mouseout', (e) => {
      const ref = e.target.closest('.note-ref');
      if (ref && !ref.contains(e.relatedTarget)) this._hideTooltip();
    });

    // Тач: показываем тултип при долгом нажатии не нужен — клик сразу открывает.
    // Скрываем тултип при начале перелистывания.
    document.getElementById('scene')?.addEventListener('pointerdown', () => {
      this._hideTooltip();
    });
  }

  /* ---------- Переход к сноске ---------- */

  openNote(noteId) {
    if (!noteId) return;
    const page = this.notePages[noteId];
    if (page == null || !this.reader.pages.length) return;

    // Запоминаем текущее место чтения, чтобы вернуться
    const anchor = this._captureAnchor();
    if (anchor) this.stack.push(anchor);

    this._hideTooltip();
    this.reader.goTo(page);
    this._showBackButton();
    this._highlightNote(noteId);
  }

  /* ---------- Возврат к тексту ---------- */

  goBack() {
    const anchor = this.stack.pop();
    if (!anchor) {
      this._hideBackButton();
      return;
    }
    this.reader.goToAnchor(anchor);
    if (this.stack.length === 0) this._hideBackButton();
  }

  /* ---------- Подсветка текста сноски после перехода ---------- */

  _highlightNote(noteId) {
    // Даём читалке отрисовать страницу, затем подсвечиваем блок сноски
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        const el = document.querySelector(`[data-note-anchor="${CSS.escape(noteId)}"]`);
        if (!el) return;
        el.classList.add('note-highlight');
        window.setTimeout(() => el.classList.remove('note-highlight'), 2200);
      });
    });
  }

  /* ---------- Якорь текущей позиции ---------- */

  _captureAnchor() {
    const book = document.getElementById('book');
    if (!book) return null;
    return buildPositionAnchor(book, { top: 0, bottom: window.innerHeight });
  }

  /* ---------- Тултип ---------- */

  _showTooltip(refEl) {
    const noteId = refEl.dataset.noteId;
    const text = this.noteTexts[noteId];
    if (!text) return;

    this.tooltip.textContent = text;
    this.tooltip.classList.add('visible');

    // Позиционируем над ссылкой, не выходя за края экрана
    const rect = refEl.getBoundingClientRect();
    const tipW = Math.min(320, window.innerWidth - 24);
    this.tooltip.style.maxWidth = `${tipW}px`;

    // Сначала измеряем высоту при заданной ширине
    this.tooltip.style.left = '0px';
    this.tooltip.style.top = '0px';
    const tipH = this.tooltip.offsetHeight;

    let left = rect.left + rect.width / 2 - tipW / 2;
    left = Math.max(12, Math.min(left, window.innerWidth - tipW - 12));

    let top = rect.top - tipH - 10;
    if (top < 12) top = rect.bottom + 10; // не хватает места сверху — показываем снизу

    this.tooltip.style.left = `${left}px`;
    this.tooltip.style.top = `${top}px`;
  }

  _hideTooltip() {
    this.tooltip.classList.remove('visible');
  }

  /* ---------- Кнопка «Назад» ---------- */

  _showBackButton() {
    this.backBtn.classList.add('visible');
  }

  _hideBackButton() {
    this.backBtn.classList.remove('visible');
  }
}
