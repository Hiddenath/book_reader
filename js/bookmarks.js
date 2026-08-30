/* ===== BookHaven 3D — закладки и заметки ===== */

import { buildPositionAnchor } from './position.js?v=20260830a';

export class Bookmarks {
  constructor(reader, onChange = null) {
    this.reader = reader;
    this.onChange = onChange;
    this.panel = document.getElementById('bookmarksPanel');
    this.list = document.getElementById('bookmarksList');
    this.marker = document.getElementById('bookmarkMarker');
    this.book = null;

    document.getElementById('btnBookmark').addEventListener('click', () => this.toggle());
    document.getElementById('btnAddBookmark').addEventListener('click', () => this.add());
    document.getElementById('bookmarksClose').addEventListener('click', () => this.close());

    this.list.addEventListener('click', (e) => {
      const del = e.target.closest('.bookmark-del');
      const item = e.target.closest('.bookmark-item');
      if (del && item) {
        e.stopPropagation();
        this.remove(item.dataset.bookmarkId);
        return;
      }
      if (item) {
        const bookmark = this.book.bookmarks.find((b) => b.id === item.dataset.bookmarkId);
        if (bookmark?.anchor) {
          this.reader.goToAnchor(bookmark.anchor);
        }
        this.close();
      }
    });

    // Сервер смержил закладки с другим браузером — обновить панель,
    // если она открыта (событие из persistCurrentBookMeta).
    window.addEventListener('bookmarks-updated', () => {
      if (this.isOpen) this._render();
    });
  }

  setBook(book) {
    this.book = book;
    if (!book.bookmarks) book.bookmarks = [];
    this._render();
    this._updateMarker();
  }

  get isOpen() { return this.panel.classList.contains('open'); }

  toggle() { this.isOpen ? this.close() : this.open(); }
  open() { this._render(); this.panel.classList.add('open'); }
  close() { this.panel.classList.remove('open'); }

  add() {
    if (!this.book) return;
    const anchor = buildPositionAnchor(document.getElementById('book'), {
      top: 0,
      bottom: window.innerHeight,
    });
    if (!anchor) return;
    const id = `${anchor.blockId}-${Date.now()}`;
    if (this.book.bookmarks.some((b) => b.anchor?.blockId === anchor.blockId)) return;
    this.book.bookmarks.push({ id, anchor, note: '', created: new Date().toISOString() });
    this.book.bookmarks.sort((a, b) => (a.anchor?.blockId || '').localeCompare(b.anchor?.blockId || ''));
    this._render();
    this._updateMarker();
    this.onChange?.();
  }

  remove(id) {
    this.book.bookmarks = this.book.bookmarks.filter((b) => b.id !== id);
    // Надгробие: id удалённой закладки. Сервер не даст другому браузеру
    // (с устаревшей копией списка) воскресить её при merge.
    if (!Array.isArray(this.book.deletedBookmarksIds)) this.book.deletedBookmarksIds = [];
    this.book.deletedBookmarksIds.push(String(id));
    this._render();
    this._updateMarker();
    this.onChange?.();
  }

  onPageChange() { this._updateMarker(); }

  _updateMarker() {
    if (!this.book) { this.marker.classList.remove('visible'); return; }
    const currentAnchor = buildPositionAnchor(document.getElementById('book'), {
      top: 0,
      bottom: window.innerHeight,
    });
    const has = this.book.bookmarks.some((b) => b.anchor?.blockId === currentAnchor?.blockId);
    this.marker.classList.toggle('visible', has);
  }

  _render() {
    if (!this.book || this.book.bookmarks.length === 0) {
      this.list.innerHTML = '<div class="bookmarks-empty">Закладок пока нет.<br>Нажмите «+ Закладка», чтобы добавить.</div>';
      return;
    }
    this.list.innerHTML = '';
    for (const b of this.book.bookmarks) {
      const item = document.createElement('div');
      item.className = 'bookmark-item';
      item.dataset.bookmarkId = b.id;
      // Дату показываем только если она корректная
      let dateStr = '';
      if (b.created) {
        const d = new Date(b.created);
        if (!isNaN(d.getTime())) {
          dateStr = d.toLocaleDateString('ru-RU', { day: 'numeric', month: 'short' });
        }
      }
      const preview = (b.anchor?.previewText || 'Текст закладки').replace(/\s+/g, ' ');
      const previewText = preview.length > 88 ? `${preview.slice(0, 85)}…` : preview;
      item.innerHTML = `
        <div class="bookmark-info">
          <div class="bookmark-copy">
            <span class="bookmark-page">${previewText}</span>
            ${dateStr ? `<span class="bookmark-date">${dateStr}</span>` : ''}
          </div>
        </div>
        <button class="bookmark-del" title="Удалить">×</button>`;
      this.list.appendChild(item);
    }
  }
}
