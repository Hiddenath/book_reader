/* ===== BookHaven 3D — оглавление (панель справа, как закладки) ===== */

export class TOC {
  constructor(reader) {
    this.reader = reader;
    this.panel = document.getElementById('tocPanel');
    this.list = document.getElementById('tocList');
    this.items = []; // [{ title, page }]

    document.getElementById('btnToc').addEventListener('click', () => this.toggle());
    document.getElementById('tocClose').addEventListener('click', () => this.close());

    this.list.addEventListener('click', (e) => {
      const item = e.target.closest('.toc-item');
      if (!item) return;
      const idx = +item.dataset.index;
      const target = this.items[idx];
      if (target && this.reader.pages.length) {
        // Переход к странице главы (чётный индекс разворота)
        const pageIndex = Math.min(target.page, this.reader.pages.length - 1);
        this.reader.goTo(pageIndex);
      }
      this.close();
    });
  }

  get isOpen() { return this.panel.classList.contains('open'); }
  toggle() { this.isOpen ? this.close() : this.open(); }
  open() {
    this._render();
    this.panel.classList.add('open');
  }
  close() { this.panel.classList.remove('open'); }

  /** Устанавливает список глав: [{ title, page }] — страница где начинается глава. */
  setItems(items) {
    this.items = items || [];
  }

  _render() {
    if (!this.items.length) {
      this.list.innerHTML = '<div class="bookmarks-empty">Оглавление пусто.<br>В этой книге нет глав.</div>';
      return;
    }

    this.list.innerHTML = '';
    this.items.forEach((item, i) => {
      const el = document.createElement('div');
      el.className = 'toc-item';
      el.dataset.index = i;
      el.innerHTML = `
        <div class="toc-info">
          <span class="toc-title">${escapeHtml(item.title)}</span>
          <span class="toc-page">стр. ${item.page + 1}</span>
        </div>`;
      this.list.appendChild(el);
    });
  }
}

function escapeHtml(s) {
  const value = s == null ? '' : String(s);
  return value.replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}
