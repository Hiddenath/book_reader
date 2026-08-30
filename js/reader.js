/* ===== BookHaven 3D — логика читалки: флип-анимация, drag, клавиатура ===== */

import { resolveAnchorPage } from './position.js?v=20260830a';

const FLIP_DURATION = 750; // мс

function easeInOutCubic(t) {
  return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
}

export class Reader {
  constructor() {
    this.book = document.getElementById('book');
    this.flipLayer = document.getElementById('flipLayer');
    this.underLeft = document.getElementById('contentUnderLeft');
    this.underRight = document.getElementById('contentUnderRight');

    this.pages = [];          // массив HTML-строк страниц
    this.currentSpread = 0;   // индекс левой страницы разворота (чётный)
    this.isAnimating = false;
    this.isDragging = false;
    this.pageFlipAnimation = true; // включена ли анимация перелистывания
    this.castLeft = this._makeCastShadow('on-left');
    this.castRight = this._makeCastShadow('on-right');

    this._bindEvents();
    this._bindTouch();
    this._bindVolumeKeys();

    // Одностраничный режим для вытянутых экранов (портрет / узкие окна)
    this.singlePage = false;
    this._singleQuery = window.matchMedia('(max-aspect-ratio: 4/5), (max-width: 768px)');
    this._applySingleMode(this._singleQuery.matches);
    this._singleQuery.addEventListener('change', (e) => {
      this._applySingleMode(e.matches);
      this.onLayoutChange?.();
    });
  }

  /** Включает/выключает одностраничный режим и вешает класс на книгу. */
  _applySingleMode(single) {
    this.singlePage = single;
    this.book.classList.toggle('single-page', single);
    // Нормализуем позицию при переключении режима
    this.goTo(this.currentSpread);
  }

  /* ---------- Публичное API ---------- */

  setPages(pages, keepSpread = false, pageBlocks = null) {
    const step = this.singlePage ? 1 : 2;
    const maxIdx = Math.max(0, this.pages.length - step);
    const prevRatio = this.pages.length > step ? this.currentSpread / (this.pages.length - step) : 0;
    this.pages = pages;
    this.pageBlocks = pageBlocks;
    const newMax = Math.max(0, pages.length - step);
    this.currentSpread = keepSpread
      ? Math.min(Math.round(prevRatio * newMax), newMax)
      : 0;
    if (!this.singlePage) this.currentSpread &= ~1; // чётный для разворота
    this._renderSpread();
  }

  next() {
    const step = this.singlePage ? 1 : 2;
    if (this.isAnimating || this.currentSpread + step >= this.pages.length) return;
    if (!this.pageFlipAnimation) {
      this.currentSpread += step;
      this._renderSpread();
      return;
    }
    this._flip('forward');
  }

  prev() {
    const step = this.singlePage ? 1 : 2;
    if (this.isAnimating || this.currentSpread < step) return;
    if (!this.pageFlipAnimation) {
      this.currentSpread -= step;
      this._renderSpread();
      return;
    }
    this._flip('backward');
  }

  goTo(pageIndex) {
    // Во время анимации перелистывания переход «вперёд» запрещён:
    // завершающий кадр анимации сам сдвинет разворот на ±2, и прыжок
    // по оглавлению/закладке был бы перезаписан (получалась не та страница).
    if (this.isAnimating) return;
    const idx = Math.max(0, Math.min(pageIndex, this.pages.length - 1));
    let target;
    if (this.singlePage) {
      target = idx;
    } else {
      target = Math.min(idx - (idx % 2), Math.max(0, this.pages.length - 2));
    }
    if (target === this.currentSpread) return;
    this.currentSpread = target;
    this._renderSpread();
  }

  goToAnchor(anchor) {
    if (!anchor?.blockId) return;
    const index = resolveAnchorPage(anchor, this.pages, this.pageBlocks);
    if (index < 0) return;
    this.goTo(index);
  }

  /** Включает/выключает анимацию перелистывания страниц. */
  setPageFlipAnimation(enabled) {
    this.pageFlipAnimation = enabled;
  }

  get progress() {
    if (this.pages.length === 0) return { page: 0, total: 0, ratio: 0 };
    const page = this.singlePage
      ? Math.min(this.currentSpread + 1, this.pages.length)
      : Math.min(this.currentSpread + 2, this.pages.length);
    return { page, total: this.pages.length, ratio: page / this.pages.length };
  }

  /* ---------- Рендер разворота ---------- */

  _renderSpread() {
    if (this.singlePage) {
      // В одностраничном режиме: текст только на правой странице,
      // левая остаётся пустой подложкой (чтобы лист не появлялся из ниоткуда)
      this.underLeft.innerHTML = '';
      this.underRight.innerHTML = this.pages[this.currentSpread] ?? '';
    } else {
      this.underLeft.innerHTML = this.pages[this.currentSpread] ?? '';
      this.underRight.innerHTML = this.pages[this.currentSpread + 1] ?? '';
    }
    this._updateProgress();
    this.onPageChange?.(this.currentSpread);
  }

  _updateProgress() {
    const { page, total, ratio } = this.progress;
    document.getElementById('progressText').textContent = `стр. ${page} / ${total}`;
    document.getElementById('progressFill').style.width = `${ratio * 100}%`;
  }

  /* ---------- Создание листа ---------- */

  _makeSheet(frontHTML, backHTML) {
    const sheet = document.createElement('div');
    sheet.className = 'flip-sheet';
    sheet.innerHTML = `
      <div class="flip-face flip-front">
        <div class="page-content">${frontHTML}</div>
        <div class="flip-shade-front"></div>
      </div>
      <div class="flip-face flip-back">
        <div class="page-content">${backHTML}</div>
        <div class="flip-shade-back"></div>
      </div>`;
    this.flipLayer.appendChild(sheet);
    return sheet;
  }

  _makeCastShadow(cls) {
    const el = document.createElement('div');
    el.className = `cast-shadow ${cls}`;
    this.book.appendChild(el);
    return el;
  }

  /* ---------- Анимация перелистывания ---------- */

  _flip(direction, dragAngle = null) {
    if (this.singlePage) return this._flipSingle(direction, dragAngle);

    const forward = direction === 'forward';
    const frontHTML = forward
      ? this.pages[this.currentSpread + 1] ?? ''
      : this.pages[this.currentSpread - 1] ?? '';
    const backHTML = forward
      ? this.pages[this.currentSpread + 2] ?? ''
      // Назад: оборот листа = ТЕКУЩАЯ левая страница — старый текст
      // остаётся на листе, пока лист не пройдёт 90°
      : this.pages[this.currentSpread] ?? '';

    const sheet = this._makeSheet(frontHTML, backHTML);
    const shadeFront = sheet.querySelector('.flip-shade-front');
    const shadeBack = sheet.querySelector('.flip-shade-back');
    const backContent = sheet.querySelector('.flip-back .page-content');

    // Под листом показываем страницу, которая откроется после флипа.
    // При флипе назад лист стартует слева (угол 180°) и сразу закрывает
    // левую страницу, меняем срузу.
    if (forward) {
      this.underRight.innerHTML = this.pages[this.currentSpread + 3] ?? '';
    } else if (dragAngle >= 0) { // !== null
      // Drag назад: лист появляется уже повёрнутым — подложку меняем сразу
      this.underLeft.innerHTML = this.pages[this.currentSpread - 2] ?? '';
    }

    const from = dragAngle ?? (forward ? 0 : 180);
    const to = forward ? 180 : 0;
    // Порог, после которого лист перестаёт закрывать левую страницу
    // (только для флипа назад): тогда подкладываем новую страницу.
    let underSwapped = forward || dragAngle !== null;

    // ВАЖНО: в цикле анимации пишем ТОЛЬКО transform и opacity —
    // это свойства, которые браузер композитит на GPU без layout/paint.
    // filter/marginTop здесь вызывали перерисовку текста каждый кадр (рывки),
    // а filter к тому же ломал preserve-3d (зеркальный текст на обороте листа).
    const applyAngle = (deg) => {
      sheet.style.transform = `rotateY(${-deg}deg)`;
      if (!underSwapped && deg < 90) {
        underSwapped = true;
        this.underLeft.innerHTML = this.pages[this.currentSpread - 2] ?? '';
      }
      // Назад: после 90° оборот листа становится новой правой страницей
      if (!forward && deg < 90 && backContent.dataset.swapped !== '1') {
        backContent.innerHTML = this.pages[this.currentSpread - 1] ?? '';
        backContent.dataset.swapped = '1';
      }
      const rad = (deg * Math.PI) / 180;
      // Тень на самом листе: максимум в середине поворота
      const selfShade = Math.sin(rad) * 0.55;
      shadeFront.style.opacity = deg < 90 ? selfShade : 0;
      shadeBack.style.opacity = deg >= 90 ? selfShade : 0;
      // Тень на лежащей странице
      const cast = Math.sin(rad) * 0.5;
      this.castLeft.style.opacity = forward ? cast : 0;
      this.castRight.style.opacity = forward ? 0 : cast;
    };

    if (dragAngle !== null) {
      applyAngle(from);
      return { sheet, applyAngle };
    }

    this.isAnimating = true;
    const start = performance.now();

    const step = (now) => {
      const t = Math.min((now - start) / FLIP_DURATION, 1);
      const deg = from + (to - from) * easeInOutCubic(t);
      applyAngle(deg);

      if (t < 1) {
        requestAnimationFrame(step);
      } else {
        sheet.remove();
        this.castLeft.style.opacity = 0;
        this.castRight.style.opacity = 0;
        this.currentSpread += forward ? 2 : -2;
        this._renderSpread();
        this.isAnimating = false;
      }
    };
    requestAnimationFrame(step);
  }

  /* Перелистывание в одностраничном режиме: лист = вся правая страница,
     вращается вокруг левого края, шаг ±1 вместо ±2. */
  _flipSingle(direction, dragAngle = null) {
    const forward = direction === 'forward';
    const frontHTML = forward
      ? this.pages[this.currentSpread] ?? ''           // старое лицо листа
      : this.pages[this.currentSpread - 1] ?? '';      // новое лицо (для назад)
    // Обратная сторона листа в одностраничном режиме всегда пустая:
    // текст только на видимой стороне, чтобы не было «зеркального» текста.
    const backHTML = '';

    // ВПЕРЁД: под лист СРАЗУ подкладываем новую страницу, чтобы она не
    // «выскакивала» после завершения поворота.
    // НАЗАД: подложка НЕ меняется — старый текст остаётся под листом,
    // а новый текст лежит на листе (как в обычном развороте).
    if (forward) {
      this.underRight.innerHTML = this.pages[this.currentSpread + 1] ?? '';
    }

    const sheet = this._makeSheet(frontHTML, backHTML);
    const shadeFront = sheet.querySelector('.flip-shade-front');
    const shadeBack = sheet.querySelector('.flip-shade-back');

    const from = dragAngle ?? (forward ? 0 : 180);
    const to = forward ? 180 : 0;

    const applyAngle = (deg) => {
      sheet.style.transform = `rotateY(${-deg}deg)`;
      const rad = (deg * Math.PI) / 180;
      // Тень на самом листе
      const selfShade = Math.sin(rad) * 0.55;
      shadeFront.style.opacity = deg < 90 ? selfShade : 0;
      shadeBack.style.opacity = deg >= 90 ? selfShade : 0;
      // Тень на лежащей странице (в single-режиме только правая)
      const cast = Math.sin(rad) * 0.5;
      this.castRight.style.opacity = forward ? cast : 0;
      this.castLeft.style.opacity = 0;
    };

    if (dragAngle !== null) {
      applyAngle(from);
      return { sheet, applyAngle };
    }

    this.isAnimating = true;
    const start = performance.now();

    const step = (now) => {
      const t = Math.min((now - start) / FLIP_DURATION, 1);
      const deg = from + (to - from) * easeInOutCubic(t);
      applyAngle(deg);

      if (t < 1) {
        requestAnimationFrame(step);
      } else {
        sheet.remove();
        this.castLeft.style.opacity = 0;
        this.castRight.style.opacity = 0;
        this.currentSpread += forward ? 1 : -1;
        this._renderSpread();
        this.isAnimating = false;
      }
    };
    requestAnimationFrame(step);
  }

  /* ---------- Drag углом ---------- */

  _bindEvents() {
    // Клавиатура
    window.addEventListener('keydown', (e) => {
      if (e.key === 'ArrowRight' || e.key === ' ') this.next();
      if (e.key === 'ArrowLeft') this.prev();
      if (e.key === 'Home') this.goTo(0);
      if (e.key === 'End') this.goTo(this.pages.length - 1);
    });

    // Боковые зоны
    document.getElementById('navRight').addEventListener('click', () => this.next());
    document.getElementById('navLeft').addEventListener('click', () => this.prev());

    // Drag за угол страницы
    this.book.addEventListener('pointerdown', (e) => {
      if (this.isAnimating) return;
      const rect = this.book.getBoundingClientRect();
      const x = e.clientX - rect.left;
      const y = e.clientY - rect.top;
      const nearRight = x > rect.width * 0.82;
      const nearLeft = x < rect.width * 0.18;
      const nearBottom = y > rect.height * 0.6;
      const step = this.singlePage ? 1 : 2;

      if (nearRight && nearBottom && this.currentSpread + step < this.pages.length) {
        this._startDrag(e, 'forward');
      } else if (nearLeft && nearBottom && this.currentSpread >= step) {
        this._startDrag(e, 'backward');
      }
    });
  }

  _startDrag(e, direction) {
    this.isDragging = true;
    this._dragDeg = null;   // сброс прошлого перетаскивания: без этого
                            // «тап без движения» завершал прошлый флип
    const forward = direction === 'forward';
    const rect = this.book.getBoundingClientRect();

    const drag = this._flip(direction, forward ? 0 : 180);
    const { sheet, applyAngle } = drag;

    const onMove = (ev) => {
      const x = ev.clientX - rect.left;
      let deg;
      if (forward) {
        // Тянем справа налево: 0° у правого края, 180° у левого
        deg = Math.max(0, Math.min(180, ((rect.width - x) / rect.width) * 180));
      } else {
        // Тянем слева направо: 180° у левого края, 0° у правого
        deg = Math.max(0, Math.min(180, (x / rect.width) * 180));
      }
      applyAngle(deg);
      this._dragDeg = deg;
    };

    const onUp = () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      this.isDragging = false;

      const deg = this._dragDeg ?? (forward ? 0 : 180);
      const complete = forward ? deg > 90 : deg < 90;

      // Доводка: анимация от текущего угла до конца/начала
      sheet.remove();
      this.castLeft.style.opacity = 0;
      this.castRight.style.opacity = 0;

      if (complete) {
        this._flip(direction);
      } else {
        // Откат: флип в обратную сторону без смены разворота
        this._rollback(direction, deg);
      }
    };

    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
  }

  _rollback(direction, fromDeg) {
    if (this.singlePage) return this._rollbackSingle(direction, fromDeg);

    const forward = direction === 'forward';
    const frontHTML = forward
      ? this.pages[this.currentSpread + 1] ?? ''
      : this.pages[this.currentSpread - 1] ?? '';
    const backHTML = forward
      ? this.pages[this.currentSpread + 2] ?? ''
      : this.pages[this.currentSpread] ?? '';

    const sheet = this._makeSheet(frontHTML, backHTML);
    const shadeFront = sheet.querySelector('.flip-shade-front');
    const shadeBack = sheet.querySelector('.flip-shade-back');
    const backContent = sheet.querySelector('.flip-back .page-content');

    this.isAnimating = true;
    const to = forward ? 0 : 180;
    const start = performance.now();
    const dur = FLIP_DURATION * Math.abs(to - fromDeg) / 180;

    const step = (now) => {
      const t = Math.min((now - start) / dur, 1);
      const deg = fromDeg + (to - fromDeg) * easeInOutCubic(t);
      sheet.style.transform = `rotateY(${-deg}deg)`;
      // Назад: после 90° оборот листа становится новой правой страницей
      if (!forward && deg < 90 && backContent.dataset.swapped !== '1') {
        backContent.innerHTML = this.pages[this.currentSpread - 1] ?? '';
        backContent.dataset.swapped = '1';
      }
      const rad = (deg * Math.PI) / 180;
      const selfShade = Math.sin(rad) * 0.55;
      shadeFront.style.opacity = deg < 90 ? selfShade : 0;
      shadeBack.style.opacity = deg >= 90 ? selfShade : 0;

      if (t < 1) {
        requestAnimationFrame(step);
      } else {
        sheet.remove();
        this._renderSpread();
        this.isAnimating = false;
      }
    };
    requestAnimationFrame(step);
  }

  /* Откат перелистывания в одностраничном режиме (без смены страницы). */
  _rollbackSingle(direction, fromDeg) {
    const forward = direction === 'forward';
    const frontHTML = forward
      ? this.pages[this.currentSpread] ?? ''
      : this.pages[this.currentSpread - 1] ?? '';
    // Обратная сторона листа в одностраничном режиме всегда пустая
    const backHTML = '';

    // Откат: возвращаем подложку на текущую страницу
    this.underRight.innerHTML = this.pages[this.currentSpread] ?? '';

    const sheet = this._makeSheet(frontHTML, backHTML);
    const shadeFront = sheet.querySelector('.flip-shade-front');
    const shadeBack = sheet.querySelector('.flip-shade-back');

    this.isAnimating = true;
    const to = forward ? 0 : 180;
    const start = performance.now();
    const dur = FLIP_DURATION * Math.abs(to - fromDeg) / 180;

    const step = (now) => {
      const t = Math.min((now - start) / dur, 1);
      const deg = fromDeg + (to - fromDeg) * easeInOutCubic(t);
      sheet.style.transform = `rotateY(${-deg}deg)`;
      const rad = (deg * Math.PI) / 180;
      const selfShade = Math.sin(rad) * 0.55;
      shadeFront.style.opacity = deg < 90 ? selfShade : 0;
      shadeBack.style.opacity = deg >= 90 ? selfShade : 0;

      if (t < 1) {
        requestAnimationFrame(step);
      } else {
        sheet.remove();
        this._renderSpread();
        this.isAnimating = false;
      }
    };
    requestAnimationFrame(step);
  }

  /* ---------- Сенсорное управление (тач-экраны) ---------- */

  /* Свайпы по сцене: влево — следующая страница, вправо — предыдущая.
     Не конфликтует с захватом угла: если начат drag (isDragging), свайп игнорируется. */
  _bindTouch() {
    const scene = document.getElementById('scene');
    let start = null;

    scene.addEventListener('pointerdown', (e) => {
      if (this.isDragging || this.isAnimating) { start = null; return; }
      start = { x: e.clientX, y: e.clientY };
    });

    scene.addEventListener('pointerup', (e) => {
      if (!start) return;
      const dx = e.clientX - start.x;
      const dy = e.clientY - start.y;
      start = null;
      // Горизонтальный свайп длиннее порога и заметно горизонтальнее вертикали
      const threshold = Math.max(48, window.innerWidth * 0.06);
      if (Math.abs(dx) < threshold || Math.abs(dx) <= Math.abs(dy) * 1.5) return;
      if (dx < 0) this.next();
      else this.prev();
    });

    // Браузер перехватил жест (например, скролл) — сбрасываем отслеживание
    scene.addEventListener('pointercancel', () => { start = null; });
  }

  /* ---------- Клавиши громкости ---------- */

  /* Обычный браузер не отдаёт странице клавиши громкости (их перехватывает ОС),
     поэтому листание работает внутри Android WebView-обёртки, которая:
       1) пересылает keydown с keyCode 175 (VOLUME_UP) / 174 (VOLUME_DOWN);
       2) вызывает window.BookHavenNative.volumeUp()/volumeDown() (evaluateJavascript);
       3) шлёт события window «volumeup» / «volumedown». */
  _bindVolumeKeys() {
    window.addEventListener('keydown', (e) => {
      if (e.keyCode === 175 || e.key === 'AudioVolumeUp') this.next();
      else if (e.keyCode === 174 || e.key === 'AudioVolumeDown') this.prev();
    });

    window.addEventListener('volumeup', () => this.next());
    window.addEventListener('volumedown', () => this.prev());

    window.BookHavenNative = window.BookHavenNative || {};
    window.BookHavenNative.volumeUp = () => this.next();
    window.BookHavenNative.volumeDown = () => this.prev();
  }
}
