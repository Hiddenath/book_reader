/* ===== BookHaven 3D — серверное автосохранение с дебаунсом =====
   Глобальные настройки — в localStorage + data/state.json на сервере.
   Прогресс и закладки книги — точечно в books/<id>/meta.json. */

const LS_KEY = 'bookhaven3d';

// API-сервер: используем хост страницы (чтобы работало и с телефона по сети),
// порт API фиксирован — 8001.
const API_PORT = 8001;
const SERVER_URL = `${location.protocol}//${location.hostname}:${API_PORT}`;

function buildStateSnapshot(settings, books, lastOpenedBookId = null, updatedAt = null) {
  return {
    settings,
    lastOpenedBookId,
    // Штамп последнего известного клиенту состояния: сервер сравнит его
    // со своим и отвергнет запись, если на сервере уже новее (другой браузер).
    updatedAt: updatedAt ?? 0,
    books: books.map((b) => ({
      id: b.id,
      title: b.title,
      author: b.author,
      format: b.format,
      progress: b.progress,
      palette: b.palette,
      bookmarks: b.bookmarks ?? [],
      anchor: b.anchor ?? null,
      hasCover: b.hasCover === true,
    })),
  };
}

export function loadState() {
  try {
    const raw = localStorage.getItem(LS_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

function fetchWithTimeout(url, options = {}, timeoutMs = 500) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  return fetch(url, { ...options, signal: controller.signal })
    .finally(() => clearTimeout(timer));
}

export async function saveState(state) {
  try {
    localStorage.setItem(LS_KEY, JSON.stringify(state));
    const res = await fetchWithTimeout(SERVER_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(state),
    }, 700);
    // Сервер отверг запись как устаревшую (на сервере уже новее — его
    // записал другой браузер). Подтягиваем актуальное состояние и
    // обновляем локальный штамп, чтобы наши следующие сохранения прошли.
    if (res?.ok) {
      const data = await res.json().catch(() => null);
      if (data?.stale && data.state) {
        localStorage.setItem(LS_KEY, JSON.stringify(data.state));
        return { stale: true, state: data.state };
      }
    }
    return { ok: true };
  } catch {
    // молча игнорируем ошибки сети
    return { ok: false };
  }
}

export async function loadStateFromServer() {
  try {
    // Таймаут 3000мс: на удалённом сервере 700мс мало, и это приводило
    // к ложной «пустой» библиотеке и запуску миграции с дубликатами
    const res = await fetchWithTimeout(SERVER_URL, {}, 3000);
    if (!res.ok) return null;
    const data = await res.json();
    if (data?.books) {
      localStorage.setItem(LS_KEY, JSON.stringify(data));
    }
    console.log(`[storage] Состояние с сервера (state.json): книг — ${data?.books?.length ?? 0}`);
    return data;
  } catch {
    return null;
  }
}

export async function loadBooksFromServer() {
  try {
    // Таймаут 5000мс: 700мс на удалённом сервере обрывали запрос,
    // возвращался null, и main.js запускал миграцию из state.json,
    // которая создавала дубликаты уже существующих книг
    const res = await fetchWithTimeout(`${SERVER_URL}/books`, {}, 5000);
    if (!res.ok) return null;
    const data = await res.json();
    const books = data?.books || [];
    console.log(`[storage] Книг на сервере (папка books/): ${books.length}`);
    return books;
  } catch (err) {
    console.warn('[storage] Не удалось получить список книг с сервера:', err);
    return null;
  }
}

export async function loadBookText(bookId) {
  try {
    const res = await fetchWithTimeout(`${SERVER_URL}/books/${encodeURIComponent(bookId)}/text`, {}, 30000);
    if (!res.ok) return null;
    const data = await res.json();
    return data; // { text, format? }
  } catch {
    return null;
  }
}

export async function saveBookToServer(book) {
  try {
    const res = await fetchWithTimeout(`${SERVER_URL}/books`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(book),
    }, 60000);
    if (!res.ok) {
      console.warn(`[storage] Сервер отклонил сохранение книги (HTTP ${res.status})`);
      return null;
    }
    const data = await res.json();
    console.log(`[storage] Книга сохранена на сервер: id="${data.id}", файл="${data.fileName}"`);
    return data;
  } catch (err) {
    console.warn('[storage] Ошибка сети/таймаут при сохранении книги — сервер мог успеть создать дубликат:', err);
    return null;
  }
}

export async function deleteBookFromServer(bookId) {
  try {
    // Таймаут 5000мс (как у списка книг): 700мс на удалённом сервере
    // обрывали запрос — книга исчезала локально, но оставалась на сервере
    // и возвращалась после перезагрузки.
    const res = await fetchWithTimeout(`${SERVER_URL}/books/${encodeURIComponent(bookId)}`, {
      method: 'DELETE',
    }, 5000);
    return res.ok;
  } catch {
    return false;
  }
}

/** Сохраняет прогресс/закладки книги в её meta.json на сервере.
    Возвращает { ok, meta } — meta с сервера (после merge закладок). */
export async function saveBookMeta(bookId, meta) {
  try {
    const res = await fetchWithTimeout(
      `${SERVER_URL}/books/${encodeURIComponent(bookId)}/meta`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(meta),
      },
      5000
    );
    if (!res.ok) return { ok: false };
    const data = await res.json().catch(() => null);
    return { ok: !!data?.ok, meta: data?.meta ?? null };
  } catch {
    return { ok: false };
  }
}

/** Загружает meta книги (закладки/позиция) с сервера. */
export async function loadBookMeta(bookId) {
  try {
    const res = await fetchWithTimeout(
      `${SERVER_URL}/books/${encodeURIComponent(bookId)}/meta`,
      {},
      5000
    );
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

export function debouncedSave(payload, ms = 350) {
  clearTimeout(debouncedSave._t);
  debouncedSave._t = setTimeout(() => {
    if (typeof payload === 'function') {
      payload(); // колбэк — например, сохранение meta книги
    } else {
      saveState(payload);
    }
  }, ms);
}

export function persistSnapshot(settings, books, lastOpenedBookId = null, updatedAt = null) {
  return buildStateSnapshot(settings, books, lastOpenedBookId, updatedAt);
}
