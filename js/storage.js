/* ===== BookHaven 3D — серверное автосохранение с дебаунсом =====
   Глобальные настройки — в localStorage + data/state.json на сервере.
   Прогресс и закладки книги — точечно в books/<id>/meta.json. */

const LS_KEY = 'bookhaven3d';

// API-сервер: используем хост страницы (чтобы работало и с телефона по сети),
// порт API фиксирован — 8001.
const API_PORT = 8001;
const SERVER_URL = `${location.protocol}//${location.hostname}:${API_PORT}`;

function buildStateSnapshot(settings, books, lastOpenedBookId = null) {
  return {
    settings,
    lastOpenedBookId,
    books: books.map((b) => ({
      id: b.id,
      title: b.title,
      author: b.author,
      format: b.format,
      progress: b.progress,
      palette: b.palette,
      bookmarks: b.bookmarks ?? [],
      anchor: b.anchor ?? null,
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
    await fetchWithTimeout(SERVER_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(state),
    }, 700);
  } catch {
    // молча игнорируем ошибки сети
  }
}

export async function loadStateFromServer() {
  try {
    const res = await fetchWithTimeout(SERVER_URL, {}, 700);
    if (!res.ok) return null;
    const data = await res.json();
    if (data?.books) {
      localStorage.setItem(LS_KEY, JSON.stringify(data));
    }
    return data;
  } catch {
    return null;
  }
}

export async function loadBooksFromServer() {
  try {
    const res = await fetchWithTimeout(`${SERVER_URL}/books`, {}, 700);
    if (!res.ok) return null;
    const data = await res.json();
    return data?.books || [];
  } catch {
    return null;
  }
}

export async function loadBookText(bookId) {
  try {
    const res = await fetchWithTimeout(`${SERVER_URL}/books/${bookId}/text`, {}, 30000);
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
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

export async function deleteBookFromServer(bookId) {
  try {
    const res = await fetchWithTimeout(`${SERVER_URL}/books/${bookId}`, {
      method: 'DELETE',
    }, 700);
    return res.ok;
  } catch {
    return false;
  }
}

/** Сохраняет прогресс/закладки книги в её meta.json на сервере. */
export async function saveBookMeta(bookId, meta) {
  try {
    const res = await fetchWithTimeout(
      `${SERVER_URL}/books/${encodeURIComponent(bookId)}/meta`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(meta),
      },
      700
    );
    return res.ok;
  } catch {
    return false;
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

export function persistSnapshot(settings, books, lastOpenedBookId = null) {
  return buildStateSnapshot(settings, books, lastOpenedBookId);
}
