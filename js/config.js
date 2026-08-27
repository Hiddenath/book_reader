/* ===== BookHaven 3D — конфигурация API =====
   По умолчанию читалка работает с локальным сервером (API на порту 8001).

   В hosted-версии (personal account) страница ДО загрузки модулей задаёт
   глобальный объект window.BOOKHAVEN_CONFIG:
       window.BOOKHAVEN_CONFIG = {
         apiUrl: 'http://host:8090/api',  // базовый URL API
         getToken: () => 'jwt-токен',      // функция, возвращающая токен (или null)
       };
   Тогда все запросы идут на apiUrl с заголовком Authorization, а к URL
   картинок (<img src>, куда заголовок передать нельзя) токен добавляется
   параметром ?token=.

   Если BOOKHAVEN_CONFIG не задан — поведение бесплатной версии не меняется. */

const DEFAULT_API_PORT = 8001;

const cfg = (typeof window !== 'undefined' && window.BOOKHAVEN_CONFIG) || {};

/** Базовый URL API (без завершающего слеша). */
export const SERVER_URL =
  cfg.apiUrl || `${location.protocol}//${location.hostname}:${DEFAULT_API_PORT}`;

function currentToken() {
  try {
    return typeof cfg.getToken === 'function' ? cfg.getToken() : null;
  } catch {
    return null;
  }
}

/** Заголовки авторизации для fetch-запросов (пустой объект в бесплатной версии). */
export function authHeaders() {
  const token = currentToken();
  return token ? { Authorization: `Bearer ${token}` } : {};
}

/** Добавляет токен к URL — для <img src>, куда нельзя передать заголовок. */
export function withAuth(url) {
  const token = currentToken();
  if (!token) return url;
  const sep = url.includes('?') ? '&' : '?';
  return `${url}${sep}token=${encodeURIComponent(token)}`;
}
