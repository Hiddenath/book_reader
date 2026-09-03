/* ===== BookHaven 3D — звуки перелистывания страниц =====
   Файлы лежат в папке sounds/ (mp3/ogg/wav/m4a). Список имён берётся
   с API-сервера (GET /sounds) — новые файлы подхватываются автоматически,
   без правок кода. Если API недоступен, используется список по умолчанию.
   При каждом перелистывании играется СЛУЧАЙНЫЙ звук, не совпадающий
   с предыдущим (когда файлов больше одного). */

// API-сервер: хост страницы, порт фиксирован (как в storage.js)
const API_PORT = 8001;
const API_URL = `${location.protocol}//${location.hostname}:${API_PORT}`;

// Fallback, пока список с сервера не загрузился (или API недоступен)
const DEFAULT_SOUNDS = ['page-flip-sound.mp3'];

// Громкость шуршания — не должно заглушать чтение
const VOLUME = 0.55;

function fetchWithTimeout(url, timeoutMs = 1200) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  return fetch(url, { signal: controller.signal })
    .finally(() => clearTimeout(timer));
}

class PageSounds {
  constructor() {
    this.enabled = true;
    // URL звуков: сразу fallback, init() заменит на список с сервера
    this.urls = DEFAULT_SOUNDS.map((name) => `sounds/${encodeURIComponent(name)}`);
    this.lastIndex = -1;   // прошлый проигранный звук (не повторяем подряд)
    this.loading = null;   // промис загрузки списка (защита от повторов)
  }

  /** Загружает список звуковых файлов с API-сервера. */
  init() {
    if (this.loading) return this.loading;
    this.loading = this._loadList();
    return this.loading;
  }

  async _loadList() {
    let names = null;
    try {
      const res = await fetchWithTimeout(`${API_URL}/sounds`);
      if (res.ok) {
        const data = await res.json();
        if (Array.isArray(data.sounds) && data.sounds.length > 0) {
          names = data.sounds;
        }
      }
    } catch {
      // API недоступен — остаёмся на fallback-списке
    }
    if (names) {
      this.urls = names.map((n) => `sounds/${encodeURIComponent(n)}`);
      this.lastIndex = -1;
    }
    // Предзагрузка: браузер положит файлы в кэш — первый флип без задержки
    for (const url of this.urls) {
      const a = new Audio();
      a.preload = 'auto';
      a.src = url;
    }
  }

  /** Включает/выключает звуки перелистывания. */
  setEnabled(enabled) {
    this.enabled = enabled === true;
  }

  /** Играет случайный звук перелистывания. */
  play() {
    if (!this.enabled || this.urls.length === 0) return;
    let i = Math.floor(Math.random() * this.urls.length);
    // Один и тот же звук не играет дважды подряд (если есть выбор)
    if (this.urls.length > 1 && i === this.lastIndex) {
      i = (i + 1) % this.urls.length;
    }
    this.lastIndex = i;
    // Новый Audio на каждое воспроизведение: файл уже в кэше браузера,
    // а быстрые перелистывания дают реалистичное «перекрытие» шуршаний
    const audio = new Audio(this.urls[i]);
    audio.volume = VOLUME;
    audio.play().catch(() => {}); // блокировка autoplay — молча игнорируем
  }
}

export const pageSounds = new PageSounds();
