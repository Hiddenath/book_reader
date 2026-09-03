/* ===== BookHaven 3D — диктор (чтение вслух) =====
   Архитектура: класс Narrator управляет ЧТО читать (страницы, порядок,
   автоперелистывание), а движок SpeechEngine — КАК читать (голос).

   Движки:
   - WebSpeechEngine — Web Speech API браузера (офлайн, Milena/Yuri на
     macOS, Google TTS на Android). Работает сразу, без зависимостей.
   - EdgeTTSEngine — каркас под серверный edge-tts (голоса Microsoft
     Dmitry/Svetlana): фронтенд запрашивает /tts, сервер отдаёт mp3.
     Включается настройкой engine: 'edgetts', когда сервер будет готов.

   Диктор читает текущую страницу → мини-пауза → перелистывание
   (с анимацией и звуком, если включены) → следующая страница. */

const API_PORT = 8001;
const API_URL = `${location.protocol}//${location.hostname}:${API_PORT}`;

// Кэш разметки ударений: предложение -> текст с U+0301. Абзацы
// повторяются между книгами редко, но кэш всё равно экономит запросы.
const stressCache = new Map();

/** Запрашивает с сервера разметку ударений (U+0301 после ударной
    гласной). Сервер недоступен / словаря нет — возвращаем как есть. */
async function fetchStressed(text) {
  if (!text || stressCache.has(text)) return stressCache.get(text) ?? text;
  try {
    const res = await fetch(`${API_URL}/tts/stress`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text }),
    });
    if (res.ok) {
      const data = await res.json();
      if (typeof data.text === 'string') {
        stressCache.set(text, data.text);
        return data.text;
      }
    }
  } catch {
    // офлайн/нет API — читаем без разметки
  }
  stressCache.set(text, text);
  return text;
}

/* ---------- Движок: Web Speech API ---------- */

class WebSpeechEngine {
  get name() { return 'webspeech'; }

  get available() {
    return typeof speechSynthesis !== 'undefined';
  }

  /** Список голосов (грузятся асинхронно — ждём voiceschanged). */
  async init() {
    if (!this.available) return;
    if (this._voices) return;
    this._voices = await new Promise((resolve) => {
      const got = speechSynthesis.getVoices();
      if (got.length) { resolve(got); return; }
      // Chrome отдаёт голоса только после события (или с задержкой)
      const t = setTimeout(() => resolve(speechSynthesis.getVoices()), 1500);
      speechSynthesis.addEventListener('voiceschanged', () => {
        clearTimeout(t);
        resolve(speechSynthesis.getVoices());
      }, { once: true });
    });
  }

  /** Читает текст. Возвращает Promise, который резолвится по окончании
      чтения (или отмене). onboundary — позиция читаемого слова. */
  speak(text, { rate = 1, pitch = 1, voiceURI = null, onboundary } = {}) {
    return new Promise((resolve) => {
      if (!this.available || !text) { resolve(); return; }
      // Снимаем прошлую фразу: иначе на некоторых платформах очередь
      // копится и голоса накладываются друг на друга
      speechSynthesis.cancel();

      const u = new SpeechSynthesisUtterance(text);
      u.lang = 'ru-RU';
      u.rate = rate;
      u.pitch = pitch;
      if (voiceURI) {
        const v = (this._voices || []).find((x) => x.voiceURI === voiceURI);
        if (v) { u.voice = v; u.lang = v.lang; }
      }
      if (onboundary) u.onboundary = onboundary;

      let done = false;
      const finish = () => {
        if (done) return;
        done = true;
        clearTimeout(guard);
        u.onend = u.onerror = u.onboundary = null;
        resolve();
      };
      u.onend = finish;
      u.onerror = finish;
      // Страховка: если движок молчит (нет голосов в ОС) — не висим вечно
      const guard = setTimeout(finish, 1000 + text.length * 120);
      speechSynthesis.speak(u);
    });
  }

  pause() { if (this.available) speechSynthesis.pause(); }
  resume() { if (this.available) speechSynthesis.resume(); }
  stop() { if (this.available) speechSynthesis.cancel(); }
}

/* ---------- Движок: edge-tts (каркас под сервер) ---------- */

class EdgeTTSEngine {
  get name() { return 'edgetts'; }

  get available() {
    return true; // проверка реальной доступности — при первом запросе
  }

  async init() {
    // Сервер пока не реализован: при speak() будет фолбэк на Web Speech
    this._ok = false;
  }

  /** Читает текст через сервер /tts (mp3). Пока сервер не готов —
      фолбэк на Web Speech, чтобы кнопка диктора работала уже сегодня. */
  async speak(text, opts = {}) {
    try {
      const res = await fetch(`${API_URL}/tts`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text, voice: opts.voice || 'ru-RU-DmitryNeural' }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const blob = await res.blob();
      this._audio = new Audio(URL.createObjectURL(blob));
      this._audio.volume = opts.volume ?? 1;
      await new Promise((resolve) => {
        this._audio.onended = resolve;
        this._audio.onerror = resolve;
        this._audio.play().catch(resolve);
      });
    } catch {
      // Сервер TTS недоступен — молча остаёмся без звука
    }
  }

  pause() { this._audio?.pause(); }
  resume() { this._audio?.play?.().catch(() => {}); }
  stop() { if (this._audio) { this._audio.pause(); this._audio.currentTime = 0; } }
}

/* ---------- Диктор: что и когда читать ---------- */

class Narrator {
  constructor() {
    this.engine = new WebSpeechEngine();
    this.enabled = false;        // идёт ли чтение
    this.paused = false;
    this.autoFlip = true;        // автоперелистывание после страницы
    this.rate = 1;              // скорость речи
    this.voiceURI = null;        // выбранный голос (null = системный)
    this._stopFlag = false;      // мягкая остановка цикла чтения
    this._speaking = false;      // движок сейчас занят фразой
    // Колбэки, которые выставляет main.js
    this.onStateChange = null;   // (state) — обновить иконку FAB
    this.getPages = null;        // () => HTML-строки страниц
    this.getCurrentPage = null; // () => индекс текущей страницы
    this.goToPage = null;        // (idx) => перелистнуть на страницу
    this.nextPage = null;        // () => перелистнуть вперёд (анимация+звук)
  }

  setEngine(name) {
    this.engine = name === 'edgetts' ? new EdgeTTSEngine() : new WebSpeechEngine();
    this.engine.init();
  }

  _emitState() {
    this.onStateChange?.({
      enabled: this.enabled,
      paused: this.paused,
      autoFlip: this.autoFlip,
    });
  }

  /** Чистит текст для речи: убирает символы, которые движок читает
      вслух (кавычки, звёздочки…), тире превращает в запятую (пауза). */
  _cleanSpeechText(text) {
    return String(text || '')
      // Кавычки всех видов — не читаются вслух
      .replace(/[«»“”„‟"'\u2018\u2019]/g, '')
      // Тире внутри предложения → запятая: движок сделает паузу
      .replace(/\s+[—–]\s+/g, ', ')
      // Тире в начале строки (реплики диалога) — просто убираем
      .replace(/^[—–]\s*/gm, '')
      .replace(/[—–]/g, ' ')
      // Символы разметки/типографики, которые голос может озвучить
      .replace(/[*#~|\\/@$%^&<>+=]/g, ' ')
      // Мусор после замен: двойные запятые, запятая перед знаком
      .replace(/,\s*,/g, ',')
      .replace(/\s+,/g, ',')
      .replace(/,{2,}/g, ',')
      // Схлопываем пробелы, знак приклеиваем к слову
      .replace(/\s+/g, ' ')
      .replace(/\s+([,.!?;:…])/g, '$1')
      .trim();
  }

  /** Делит текст на предложения — после каждого движок получает паузу. */
  _splitSentences(text) {
    return String(text ?? '')
      .split(/(?<=[.!?…])\s+/)
      .map((s) => s.trim())
      .filter(Boolean);
  }

  /** Пауза после блока — по типу: заголовок дольше, абзац короче. */
  _pauseAfter(type) {
    switch (type) {
      case 'chapter': return 800;   // название главы — большая пауза
      case 'subtitle': return 600;  // подзаголовок
      case 'epigraph': return 500;  // эпиграф/цитата
      case 'verse': return 350;     // строка стиха — ритм
      case 'stanza': return 700;    // пустая строка между строфами
      default: return 400;          // абзац
    }
  }

  /** Разбирает HTML страницы в блоки для чтения: { type, text }.
      Заголовки, абзацы, эпиграфы и стихи — отдельные блоки со своими
      паузами; сноски и картинки не читаются. */
  _pageToBlocks(html) {
    const div = document.createElement('div');
    div.innerHTML = html;
    // Сноски-маркеры и служебные элементы не читаем
    div.querySelectorAll('.note-ref, .note-link, sup, .footnote').forEach((el) => el.remove());

    const blocks = [];
    const push = (type, text) => {
      const clean = this._cleanSpeechText(text);
      if (clean) blocks.push({ type, text: clean });
    };

    for (const el of div.children) {
      const tag = el.tagName;
      const cls = String(el.className || '');
      if (tag === 'FIGURE') continue;                    // картинки молчат
      if (tag === 'H2' || cls.includes('chapter-title')) {
        push('chapter', el.textContent);                 // заголовок главы
      } else if (tag === 'H3' || cls.includes('subtitle')) {
        push('subtitle', el.textContent);                // подзаголовок
      } else if (tag === 'PRE' || cls.includes('poem')) {
        // Стихи: построчно — сохраняем ритм; пустая строка = строфа
        for (const line of el.textContent.split('\n')) {
          if (!line.trim()) { blocks.push({ type: 'stanza', text: '' }); continue; }
          push('verse', line);
        }
      } else if (tag === 'BLOCKQUOTE') {
        push('epigraph', el.textContent);                // эпиграф/цитата
      } else {
        push('paragraph', el.textContent);              // обычный абзац
      }
    }
    return blocks;
  }

  /** Блоки чтения текущего разворота: в широком режиме — левая и
      правая страницы подряд, в вертикальном (single) — одна. */
  _spreadToBlocks() {
    const pages = this.getPages?.() ?? [];
    const idx = this.getCurrentPage?.() ?? 0;
    const single = this.isSinglePage?.() ?? false;
    const htmls = single ? [pages[idx]] : [pages[idx], pages[idx + 1]];
    const out = [];
    for (const h of htmls) {
      if (h) out.push(...this._pageToBlocks(h));
    }
    return out;
  }

  /** Запуск чтения с текущей страницы. */
  async start() {
    if (this.enabled) return;
    await this.engine.init();
    this.enabled = true;
    this.paused = false;
    this._stopFlag = false;
    this._emitState();
    this._loop();
  }

  /** Главный цикл: блоки разворота → пауза → перелистывание → …
      Каждый блок читается ПРЕДЛОЖЕНИЕ ЗА ПРЕДЛОЖЕНИЕМ — после каждой
      точки/вопроса/восклицания движок получает паузу, после заголовков
      и строф паузы длиннее. */
  async _loop() {
    const PAUSE_SENTENCE = 220;   // пауза после предложения внутри абзаца
    while (this.enabled && !this._stopFlag) {
      const pages = this.getPages?.() ?? [];
      const idx = this.getCurrentPage?.() ?? 0;
      if (idx >= pages.length) break;

      // Читаем все блоки текущего разворота (в single — одной страницы)
      const blocks = this._spreadToBlocks();
      for (const block of blocks) {
        if (this._stopFlag || !this.enabled) break;

        // Пустая строка между строфами — просто пауза
        if (!block.text) {
          await this._sleep(this._pauseAfter(block.type));
          continue;
        }

        // Заголовки читаем чуть медленнее — «объявляем» главу
        const isHeading = block.type === 'chapter' || block.type === 'subtitle';
        const sentences = this._splitSentences(block.text);

        for (let s = 0; s < sentences.length; s++) {
          if (this._stopFlag || !this.enabled) break;
          // Ударения: сервер размечает словоформы (U+0301 после
          // ударной гласной) — голос ставит ударения правильно
          const spoken = await fetchStressed(sentences[s]);
          this._speaking = true;
          await this.engine.speak(spoken, {
            rate: isHeading ? this.rate * 0.92 : this.rate,
            voiceURI: this.voiceURI,
          });
          this._speaking = false;
          if (this._stopFlag || !this.enabled) break;
          // Последнее предложение блока → пауза по типу блока,
          // остальные → короткая пауза после точки
          const last = s === sentences.length - 1;
          await this._sleep(last ? this._pauseAfter(block.type) : PAUSE_SENTENCE);
        }
      }
      if (this._stopFlag || !this.enabled) break;

      // Конец книги
      const single = this.isSinglePage?.() ?? false;
      const step = single ? 1 : 2;
      if (idx + step >= pages.length) break;

      // Мини-пауза между разворотами (как чтец переводит дыхание)
      await this._sleep(600);
      if (this._stopFlag || !this.enabled) break;

      // Автоперелистывание: с анимацией и звуком — как ручное
      if (this.autoFlip) {
        const flipped = this.nextPage?.();
        if (flipped === false) break;   // дальше некуда
        // Даём анимации (750 мс) завершиться — иначе чтение начнётся
        // раньше, чем страница ляжет
        await this._sleep(900);
      } else {
        // Без автолиста — останавливаемся в конце разворота
        break;
      }
    }
    this.enabled = false;
    this._speaking = false;
    this._emitState();
  }

  _sleep(ms) {
    return new Promise((r) => setTimeout(r, ms));
  }

  /** Пауза/продолжение. */
  togglePause() {
    if (!this.enabled) return;
    this.paused = !this.paused;
    if (this.paused) this.engine.pause();
    else this.engine.resume();
    this._emitState();
  }

  /** Полная остановка чтения. */
  stop() {
    this._stopFlag = true;
    this.enabled = false;
    this.paused = false;
    this.engine.stop();
    this._emitState();
  }

  /** Перечитать страницу заново (после смены настроек чтения). */
  restart() {
    if (!this.enabled) return;
    this.engine.stop();
    // _loop сам завершится по _stopFlag и перезапустится
    this._stopFlag = true;
    const relaunch = async () => {
      await this._sleep(150);
      this._stopFlag = false;
      this.enabled = true;
      this._loop();
    };
    relaunch();
  }
}

export const narrator = new Narrator();
