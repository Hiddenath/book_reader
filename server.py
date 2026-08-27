#!/usr/bin/env python3
"""
BookHaven 3D — единый сервер для разработки.

Запускает:
- Статический файловый сервер на порту 8080 (для HTML/CSS/JS)
- API-сервер состояния на порту 8001 (для сохранения прогресса)

Использование:
    python3 server.py          # запустить оба сервера
    python3 server.py --static # только статический сервер
    python3 server.py --api    # только API-сервер
"""

import argparse
import json
import os
import re
import threading
from datetime import datetime
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer, SimpleHTTPRequestHandler
from pathlib import Path

ROOT = Path(__file__).parent
DATA_FILE = ROOT / 'data' / 'state.json'
BOOKS_DIR = ROOT / 'books'

QUIET = False  # --quiet отключает логирование


def now_str():
    return datetime.now().strftime('%Y-%m-%d %H:%M:%S')


def log(msg):
    """Единая точка вывода логов в терминал."""
    if not QUIET:
        print(f'[{now_str()}] {msg}', flush=True)


def ensure_store():
    DATA_FILE.parent.mkdir(parents=True, exist_ok=True)
    if not DATA_FILE.exists():
        DATA_FILE.write_text(json.dumps({'books': []}, ensure_ascii=False), encoding='utf-8')


def ensure_books_dir():
    BOOKS_DIR.mkdir(parents=True, exist_ok=True)


def load_state():
    ensure_store()
    return json.loads(DATA_FILE.read_text(encoding='utf-8'))


def save_state(state):
    ensure_store()
    DATA_FILE.write_text(json.dumps(state, ensure_ascii=False, indent=2), encoding='utf-8')


# ---------- Утилиты для FB2 ----------

def parse_fb2_meta(fb2_text):
    """Извлекает title/author из XML FB2 (без внешних зависимостей)."""
    import xml.etree.ElementTree as ET
    try:
        root = ET.fromstring(fb2_text)
    except ET.ParseError:
        return {'title': 'Без названия', 'author': 'Неизвестный автор'}

    # Определяем namespace (если есть) для корректного поиска
    ns = ''
    if root.tag.startswith('{'):
        ns = root.tag.split('}')[0] + '}'

    def find_text(path):
        # С namespace префикс нужен на каждом уровне пути
        if ns:
            path = '/'.join(f'{ns}{part}' for part in path.split('/'))
        el = root.find(path)
        if el is not None and el.text:
            return el.text.strip()
        return ''

    title = find_text('description/title-info/book-title')
    first = find_text('description/title-info/author/first-name')
    last = find_text('description/title-info/author/last-name')
    author = ' '.join(filter(None, [last, first])) or 'Неизвестный автор'

    return {
        'title': title or 'Без названия',
        'author': author,
    }


def parse_fb2_blocks(fb2_text):
    """Извлекает блоки текста из FB2.
    Правила форматирования:
    - <section> начинает новую страницу (блок 'pagebreak')
    - <title> → заголовок (тип 'chapter'), текст берётся ОДИН раз
    - <p> внутри <title> не дублируется
    - <p> → абзац, <subtitle>/<epigraph>/<poem>/<cite> → свои типы
    """
    import xml.etree.ElementTree as ET
    try:
        root = ET.fromstring(fb2_text)
    except ET.ParseError:
        return []

    def tag(el):
        return el.tag.split('}')[-1]

    def text_of(el):
        return ' '.join(t for t in el.itertext() if t and t.strip()).strip()

    XLINK_HREF = '{http://www.w3.org/1999/xlink}href'

    def inline_text(el):
        """Текст с сохранением сносок: <a type="note" href="#id">[1]</a>
        заменяется маркером \\uE000id\\uE001[1]\\uE002 — фронтенд сделает его
        кликабельной ссылкой с подсказкой. Обычный текст — как в text_of."""
        parts = []

        def walk(node):
            if tag(node) == 'a' and node.attrib.get('type') == 'note':
                href = node.attrib.get(XLINK_HREF, '')
                note_id = href[1:] if href.startswith('#') else ''
                inner = ' '.join(t for t in node.itertext() if t and t.strip()).strip()
                if note_id:
                    parts.append(f'\uE000{note_id}\uE001{inner}\uE002')
                elif inner:
                    parts.append(inner)
                return
            if node.text and node.text.strip():
                parts.append(node.text.strip())
            for child in node:
                walk(child)
                if child.tail and child.tail.strip():
                    parts.append(child.tail.strip())

        walk(el)
        # Склеиваем: маркер сноски приклеивается к предыдущему слову без
        # пробела («…Сигишоары…[1]»), остальное — через пробел.
        result = ''
        for p in parts:
            if p.startswith('\uE000'):
                result += p
            elif result:
                result += ' ' + p
            else:
                result = p
        return result

    def poem_text(poem_el):
        """Собирает текст стихотворения: <v> = строка, <stanza> = строфа.
        Строки внутри строфы соединяются переносом, строфы — пустой строкой.
        Если <stanza> нет — прямые <v> дети считаются строками."""
        lines = []
        stanzas = [c for c in poem_el if tag(c) == 'stanza']
        if stanzas:
            for stanza in stanzas:
                stanza_lines = [inline_text(v) for v in stanza if tag(v) == 'v']
                stanza_lines = [s for s in stanza_lines if s]
                if stanza_lines:
                    lines.append('\n'.join(stanza_lines))
            return '\n\n'.join(lines)
        # Нет <stanza> — прямые <v> дети
        for v in poem_el:
            if tag(v) == 'v':
                txt = inline_text(v)
                if txt:
                    lines.append(txt)
        return '\n'.join(lines)

    def rich_text_of(el):
        """Текст с сохранением переносов строк (для poem/epigraph/cite).
        <poem> разбирается по строкам; <epigraph>/<cite> — по детям,
        где <poem>/<epigraph>/<cite> рекурсивны, остальное — text_of."""
        t = tag(el)
        if t == 'poem':
            return poem_text(el)
        if t in ('epigraph', 'cite'):
            parts = []
            for child in el:
                ct = tag(child)
                if ct in ('poem', 'epigraph', 'cite'):
                    txt = rich_text_of(child)
                else:
                    txt = inline_text(child)
                if txt:
                    parts.append(txt)
            return '\n\n'.join(parts)
        return text_of(el)

    blocks = []

    def add_child(child):
        """Разбирает один элемент секции и возвращает True, если он обработан."""
        t = tag(child)
        if t == 'title':
            txt = text_of(child)
            if txt:
                blocks.append({'type': 'chapter', 'text': txt})
            return True
        if t == 'p':
            txt = inline_text(child)
            if txt:
                blocks.append({'type': 'paragraph', 'text': txt})
            return True
        if t == 'subtitle':
            txt = text_of(child)
            if txt:
                blocks.append({'type': 'subtitle', 'text': txt})
            return True
        if t == 'epigraph':
            txt = rich_text_of(child)
            if txt:
                blocks.append({'type': 'epigraph', 'text': txt})
            return True
        if t == 'poem':
            txt = poem_text(child)
            if txt:
                blocks.append({'type': 'poem', 'text': txt})
            return True
        if t == 'cite':
            txt = rich_text_of(child)
            if txt:
                blocks.append({'type': 'cite', 'text': txt})
            return True
        if t == 'image':
            # Картинка в теле книги: <image xlink:href="#name"/>
            href = child.attrib.get('{http://www.w3.org/1999/xlink}href', '')
            if href.startswith('#'):
                blocks.append({'type': 'image', 'src': href[1:]})
            return True
        return False

    def walk_container(container, start_new_page):
        """Проходит по детям контейнера (body/section)."""
        for child in container:
            if tag(child) == 'section':
                blocks.append({'type': 'pagebreak'})
                walk_container(child, False)
            elif tag(child) == 'empty-line':
                continue
            elif not add_child(child):
                # Неизвестный тег с вложенными элементами — обходим рекурсивно
                walk_container(child, False)

    # Берём основное тело книги (первый <body> с учётом namespace)
    body = next((el for el in root.iter() if tag(el) == 'body'), None)
    if body is None:
        return blocks

    walk_container(body, True)

    # ---- Примечания (сноски) ----
    # Стандартно лежат в отдельном <body name="notes">: заголовок + секции
    # <section id="n_1">. Добавляем их блоками в конец книги, чтобы на них
    # можно было перейти по клику на сноску (как по оглавлению).
    notes_body = next(
        (el for el in root.iter() if tag(el) == 'body' and el.attrib.get('name') == 'notes'),
        None,
    )
    if notes_body is not None:
        def collect_paras(el, out):
            """Собирает абзацы секции, пропуская поддерево <title> (номер
            сноски уже извлечён отдельно)."""
            for c in el:
                ct = tag(c)
                if ct == 'title' or ct == 'empty-line':
                    continue
                if ct == 'p':
                    t = inline_text(c)
                    if t:
                        out.append(t)
                elif ct in ('subtitle', 'v'):
                    t = text_of(c)
                    if t:
                        out.append(t)
                else:
                    collect_paras(c, out)

        for child in notes_body:
            ct = tag(child)
            if ct == 'title':
                # Заголовок раздела «Примечания» — как глава (попадёт в оглавление)
                txt = text_of(child)
                if txt:
                    blocks.append({'type': 'chapter', 'text': txt})
            elif ct == 'section':
                note_id = child.attrib.get('id', '')
                title_el = next((c for c in child if tag(c) == 'title'), None)
                title_txt = text_of(title_el) if title_el is not None else ''
                paras = []
                collect_paras(child, paras)
                body_txt = '\n\n'.join(paras)
                if title_txt and body_txt:
                    sep = '' if title_txt.endswith(('.', '!', '?', ':')) else '.'
                    full = f'{title_txt}{sep} {body_txt}'
                else:
                    full = body_txt or title_txt
                if full:
                    block = {'type': 'note', 'text': full}
                    if note_id:
                        block['noteId'] = note_id
                    blocks.append(block)
            elif ct == 'p':
                txt = inline_text(child)
                if txt:
                    blocks.append({'type': 'paragraph', 'text': txt})

    return blocks


def parse_fb2_cover(fb2_text):
    """Возвращает имя (id) бинарного файла обложки из <coverpage>, или None.

    Обложка в FB2: <coverpage><image xlink:href="#respub.jpg"/></coverpage>,
    а сами данные — в <binary id="respub.jpg" content-type="image/jpeg">base64</binary>.
    """
    import xml.etree.ElementTree as ET
    try:
        root = ET.fromstring(fb2_text)
    except ET.ParseError:
        return None

    def tag(el):
        return el.tag.split('}')[-1]

    for el in root.iter():
        if tag(el) == 'coverpage':
            for child in el:
                if tag(child) == 'image':
                    href = child.attrib.get('{http://www.w3.org/1999/xlink}href', '')
                    if href.startswith('#'):
                        return href[1:]
    return None


def find_fb2_binary(fb2_text, name):
    """Находит <binary id="name"> в FB2 и возвращает (bytes, content_type) или None.

    Данные в FB2 хранятся в base64 внутри <binary>.
    """
    import xml.etree.ElementTree as ET
    import base64
    try:
        root = ET.fromstring(fb2_text)
    except ET.ParseError:
        return None

    def tag(el):
        return el.tag.split('}')[-1]

    for el in root.iter():
        if tag(el) == 'binary' and el.attrib.get('id') == name:
            content_type = el.attrib.get('content-type', 'application/octet-stream')
            data = el.text or ''
            try:
                return base64.b64decode(data), content_type
            except Exception:
                return None
    return None


class APIHandler(BaseHTTPRequestHandler):
    """Обработчик API для сохранения/загрузки состояния и управления книгами."""

    def _read_json_body(self):
        """Читает тело POST-запроса целиком и парсит JSON.

        Возвращает (payload_dict, None) при успехе или (None, error_dict).
        read(n) может вернуть МЕНЬШЕ n байт, если соединение оборвалось
        (таймаут на клиенте, обрыв сети) — поэтому читаем циклом до конца.
        """
        length = int(self.headers.get('Content-Length', '0'))
        if length <= 0:
            return {}, None

        try:
            data = b''
            remaining = length
            while remaining > 0:
                chunk = self.rfile.read(remaining)
                if not chunk:
                    # Соединение оборвано раньше, чем пришли все байты
                    return None, {'error': 'Тело запроса оборвано (не хватает данных)'}
                data += chunk
                remaining -= len(chunk)
        except OSError:
            # Клиент разорвал соединение (таймаут, обрыв сети)
            return None, {'error': 'Соединение разорвано'}

        try:
            text = data.decode('utf-8')
        except UnicodeDecodeError:
            return None, {'error': 'Тело запроса повреждено (не UTF-8)'}

        try:
            return json.loads(text), None
        except json.JSONDecodeError:
            return None, {'error': 'Invalid JSON'}

    def do_OPTIONS(self):
        self.send_response(200)
        self.send_header('Access-Control-Allow-Origin', '*')
        self.send_header('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS')
        self.send_header('Access-Control-Allow-Headers', 'Content-Type')
        self.end_headers()

    def do_GET(self):
        from urllib.parse import unquote
        
        if self.path == '/books':
            self._list_books()
        elif self.path.startswith('/books/') and self.path.endswith('/text'):
            book_id = unquote(self.path.split('/')[-2])
            self._get_book_text(book_id)
        elif self.path.startswith('/books/') and self.path.endswith('/meta'):
            book_id = unquote(self.path.split('/')[-2])
            self._get_book_meta(book_id)
        elif self.path.startswith('/books/') and self.path.endswith('/cover'):
            book_id = unquote(self.path.split('/')[-2])
            self._get_book_cover(book_id)
        elif self.path.startswith('/books/') and '/image/' in self.path:
            # /books/<id>/image/<name> — картинка из тела книги
            parts = self.path.split('/')
            book_id = unquote(parts[2])
            img_name = unquote(parts[4])
            self._get_book_image(book_id, img_name)
        else:
            self._send_json(load_state())

    def do_POST(self):
        from urllib.parse import unquote

        if self.path == '/books':
            self._save_book()
        elif self.path.startswith('/books/') and self.path.endswith('/meta'):
            book_id = unquote(self.path.split('/')[-2])
            self._update_book_meta(book_id)
        else:
            payload, err = self._read_json_body()
            if err:
                self._send_json(err, status=400)
                return
            try:
                save_state(payload)
            except OSError as e:
                self._send_json({'error': 'Не удалось сохранить состояние', 'detail': str(e)}, status=500)
                return
            self._send_json({'ok': True})

    def do_DELETE(self):
        from urllib.parse import unquote
        if self.path.startswith('/books/'):
            book_id = unquote(self.path.split('/')[-1])
            self._delete_book(book_id)
        else:
            self._send_json({'error': 'Not found'}, status=404)

    def _list_books(self):
        """Возвращает список книг из папки books/ (без текста — только метаданные)."""
        ensure_books_dir()
        books = []
        BOOK_EXTS = ('.fb2', '.txt', '.epub')

        for item in sorted(BOOKS_DIR.iterdir()):
            if not item.is_file() or item.suffix.lower() not in BOOK_EXTS:
                continue

            stem = item.stem
            # Метаданные — из sidecar <stem>.meta.json (если есть), иначе из файла
            sidecar = BOOKS_DIR / f"{stem}.meta.json"
            if sidecar.exists():
                try:
                    meta = json.loads(sidecar.read_text(encoding='utf-8'))
                    meta['id'] = stem
                    meta['format'] = meta.get('format', item.suffix.lstrip('.'))
                    meta.setdefault('progress', 0)
                    meta.setdefault('bookmarks', [])
                    meta.setdefault('palette', [])
                     # hasCover: если в meta.json нет — вычисляем из FB2 (старые книги)
                    if 'hasCover' not in meta and item.suffix.lower() == '.fb2':
                        meta['hasCover'] = parse_fb2_cover(item.read_text(encoding='utf-8')) is not None
                    books.append(meta)
                    continue
                except Exception:
                    pass

            # Нет sidecar — формируем базовые метаданные из файла
            try:
                if item.suffix.lower() == '.fb2':
                    fb2_text = item.read_text(encoding='utf-8')
                    fb2_meta = parse_fb2_meta(fb2_text)
                    meta = {
                         'id': stem, 'format': 'fb2',
                         'title': fb2_meta['title'], 'author': fb2_meta['author'],
                         'progress': 0, 'bookmarks': [], 'palette': [],
                         'hasCover': parse_fb2_cover(fb2_text) is not None,
                    }
                else:
                    meta = {
                        'id': stem, 'format': item.suffix.lstrip('.'),
                        'title': stem, 'author': 'Неизвестный автор',
                        'progress': 0, 'bookmarks': [], 'palette': [],
                    }
                books.append(meta)
            except Exception as e:
                log(f'ERROR GET /books: не удалось разобрать книгу {item.name}: {e}')

        # Диагностика: имена с суффиксом « (N)» — вероятные дубликаты
        dup_ids = [b['id'] for b in books if re.search(r' \(\d+\)$', b['id'])]
        if dup_ids:
            log(f'WARN GET /books: возможные дубликаты книг: {", ".join(dup_ids)}')
        log(f'GET /books: найдено книг — {len(books)}')
        self._send_json({'books': books})

    def _get_book_meta(self, book_id):
        """Возвращает метаданные книги (из sidecar meta.json)."""
        meta_file = self._find_book_meta_file(book_id)

        if not meta_file or not meta_file.exists():
            self._send_json({'error': 'Book not found'}, status=404)
            return

        meta = json.loads(meta_file.read_text(encoding='utf-8'))
        meta['id'] = book_id
        self._send_json(meta)

    def _get_book_text(self, book_id):
        """Возвращает полный текст книги (FB2 парсится на лету)."""
        content_file = self._find_book_content_file(book_id)

        if content_file is None:
            self._send_json({'error': 'Book not found'}, status=404)
            return

        if content_file.suffix.lower() == '.fb2':
            # Парсим FB2 на лету — отдаём структурированные блоки
            blocks = parse_fb2_blocks(content_file.read_text(encoding='utf-8'))
            self._send_json({'blocks': blocks, 'format': 'fb2'})
        else:
            # TXT / EPUB — обычный текст
            text = content_file.read_text(encoding='utf-8')
            self._send_json({'text': text})

    def _get_book_cover(self, book_id):
        """Отдаёт обложку книги (из <coverpage> FB2) как картинку."""
        content_file = self._find_book_content_file(book_id)
        if content_file is None or content_file.suffix.lower() != '.fb2':
            self._send_json({'error': 'No cover'}, status=404)
            return

        fb2_text = content_file.read_text(encoding='utf-8')
        cover_name = parse_fb2_cover(fb2_text)
        if not cover_name:
            self._send_json({'error': 'No cover'}, status=404)
            return

        result = find_fb2_binary(fb2_text, cover_name)
        if not result:
            self._send_json({'error': 'No cover data'}, status=404)
            return

        data, content_type = result
        self._send_binary(data, content_type)

    def _get_book_image(self, book_id, img_name):
        """Отдаёт картинку из тела книги (по id <binary>)."""
        content_file = self._find_book_content_file(book_id)
        if content_file is None or content_file.suffix.lower() != '.fb2':
            self._send_json({'error': 'Not found'}, status=404)
            return

        fb2_text = content_file.read_text(encoding='utf-8')
        result = find_fb2_binary(fb2_text, img_name)
        if not result:
            self._send_json({'error': 'Image not found'}, status=404)
            return

        data, content_type = result
        self._send_binary(data, content_type)

    def _send_binary(self, data, content_type):
        """Отдаёт бинарные данные (картинку) с правильным Content-Type."""
        try:
            self.send_response(200)
            self.send_header('Content-Type', content_type)
            self.send_header('Content-Length', str(len(data)))
            self.send_header('Access-Control-Allow-Origin', '*')
            self.send_header('Cache-Control', 'public, max-age=86400')
            self.end_headers()
            self.wfile.write(data)
        except OSError:
            pass    # Клиент уже закрыл соединение
    def _save_book(self):
        """Сохраняет книгу в папку books/ (сохраняем оригинальный FB2)."""
        book, err = self._read_json_body()
        if err:
            self._send_json(err, status=400)
            return

        format_ = book.get('format', 'txt')
        ext = '.fb2' if format_ == 'fb2' else '.txt'

         # Имя файла = оригинальное имя книги (без потери), при конфликте — суффикс
        original_name = book.get('originalName') or f"{book.get('title', 'book')}{ext}"

         # Запрос без originalName — подозрительно: такую книгу могла отправить
         # миграция из state.json, а имя файла построено из title → возможный дубликат
        if not book.get('originalName'):
            log(f'WARN POST /books: запрос БЕЗ originalName, имя «{original_name}» построено из title — возможен дубликат!')

        if not original_name.lower().endswith(ext):
            original_name += ext

        content_file, stem = self._unique_file(BOOKS_DIR, original_name)

         # Логируем конфликт имён — так видно момент создания дубликата
        ip = self.client_address[0] if self.client_address else '?'
        if content_file.name != original_name:
            log(f'WARN POST /books {ip}: имя «{original_name}» уже занято — создан дубликат «{content_file.name}»')
        else:
            log(f'POST /books {ip}: сохраняю «{content_file.name}»')

         # Сохраняем контент прямо в books/ (без подпапок)
        if format_ == 'fb2' and book.get('fb2_content'):
            content_file.write_text(book['fb2_content'], encoding='utf-8')
        else:
            content_file.write_text(book.get('text', ''), encoding='utf-8')

        book_id = stem   # id книги = имя файла без расширения

         # Базовые метаданные — сервер сам извлекает title/author из FB2,
         # для остальных форматов берём из payload
        meta = {
             'title': book.get('title', 'Без названия'),
             'author': book.get('author', 'Неизвестный автор'),
             'format': format_,
             'progress': book.get('progress', 0),
             'palette': book.get('palette', []),
             'bookmarks': book.get('bookmarks', []),
             'anchor': book.get('anchor'),
        }

        if format_ == 'fb2' and book.get('fb2_content'):
             # Метаданные извлекаем на сервере из оригинального файла
            fb2_meta = parse_fb2_meta(book['fb2_content'])
            meta['title'] = fb2_meta['title']
            meta['author'] = fb2_meta['author']
             # Есть ли обложка в файле — чтобы библиотека показывала картинку
            meta['hasCover'] = parse_fb2_cover(book['fb2_content']) is not None

         # Метаданные — sidecar файл рядом с книгой: <stem>.meta.json
        meta_file = BOOKS_DIR / f"{book_id}.meta.json"
        meta_file.write_text(json.dumps(meta, ensure_ascii=False, indent=2), encoding='utf-8')

        self._send_json({'ok': True, 'id': book_id, 'meta': meta, 'fileName': content_file.name})

    def _unique_file(self, directory, filename):
        """Возвращает (путь_файла, stem) с уникальным именем:
        если файл уже есть — добавляет ' (2)', ' (3)' и т.д."""
        stem = Path(filename).stem
        ext = Path(filename).suffix
        candidate = directory / filename
        i = 2
        while candidate.exists():
            candidate = directory / f"{stem} ({i}){ext}"
            i += 1
        return candidate, candidate.stem

    def _update_book_meta(self, book_id):
        """Обновляет прогресс/закладки книги в её meta.json."""
        from urllib.parse import unquote
        book_id = unquote(book_id)

        payload, err = self._read_json_body()
        if err:
            self._send_json(err, status=400)
            return

        # Ищем meta.json книги — папка или рядом с прямым .fb2 файлом
        meta_file = self._find_book_meta_file(book_id)

        if not meta_file or not meta_file.exists():
            self._send_json({'error': 'Book not found'}, status=404)
            return

        # Читаем текущие метаданные и обновляем только переданные поля
        try:
            meta = json.loads(meta_file.read_text(encoding='utf-8'))
        except Exception:
            meta = {}

        for key in ('progress', 'bookmarks', 'anchor', 'title', 'author'):
            if key in payload:
                meta[key] = payload[key]

        meta_file.write_text(json.dumps(meta, ensure_ascii=False, indent=2), encoding='utf-8')
        self._send_json({'ok': True, 'meta': meta})

    def _find_book_content_file(self, book_id):
        """Находит файл книги в books/ по id (имени без расширения)."""
        for ext in ('.fb2', '.txt', '.epub'):
            f = BOOKS_DIR / f"{book_id}{ext}"
            if f.exists():
                return f
        return None

    def _find_book_meta_file(self, book_id):
        """Находит sidecar <id>.meta.json рядом с файлом книги.
           Если его нет — создаёт базовый из содержимого книги."""
        content_file = self._find_book_content_file(book_id)
        if content_file is None:
            return None

        meta_file = BOOKS_DIR / f"{book_id}.meta.json"
        if meta_file.exists():
            return meta_file

        # Создаём базовый meta.json
        base = {'format': content_file.suffix.lstrip('.'), 'progress': 0,
                'bookmarks': [], 'anchor': None}
        if content_file.suffix.lower() == '.fb2':
            fb2_meta = parse_fb2_meta(content_file.read_text(encoding='utf-8'))
            base.update({'title': fb2_meta['title'], 'author': fb2_meta['author']})
        else:
            base.update({'title': book_id, 'author': 'Неизвестный автор'})
        meta_file.write_text(json.dumps(base, ensure_ascii=False, indent=2), encoding='utf-8')
        return meta_file

    def _delete_book(self, book_id):
        """Удаляет файл книги и sidecar meta.json из папки books/."""
        content_file = self._find_book_content_file(book_id)
        if content_file is None:
            self._send_json({'error': 'Book not found'}, status=404)
            return

        content_file.unlink()
        sidecar = BOOKS_DIR / f"{book_id}.meta.json"
        if sidecar.exists():
            sidecar.unlink()
        ip = self.client_address[0] if self.client_address else '?'
        log(f'DELETE /books {ip}: удалена книга «{book_id}» ({content_file.name})')
        self._send_json({'ok': True})

    def _send_json(self, data, status=200):
        try:
            self.send_response(status)
            self.send_header('Content-Type', 'application/json; charset=utf-8')
            self.send_header('Access-Control-Allow-Origin', '*')
            self.end_headers()
            self.wfile.write(json.dumps(data, ensure_ascii=False).encode('utf-8'))
        except OSError:
            pass  # Клиент уже закрыл соединение — отвечать некому

    def log_message(self, format, *args):
        """Печатаем каждый запрос к API в терминал (метод, путь, код, IP)."""
        if QUIET:
            return
        ip = self.client_address[0] if self.client_address else '?'
        try:
            line = format % args if args else format
        except Exception:
            line = format
        print(f'[{now_str()}] {ip} {line}', flush=True)


class StaticHandler(SimpleHTTPRequestHandler):
    """Статический файловый сервер с правильными MIME-типами."""

    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(ROOT), **kwargs)

    def end_headers(self):
        # Кэширование для статики
        if self.path.endswith(('.css', '.js', '.woff2', '.png', '.jpg')):
            self.send_header('Cache-Control', 'public, max-age=3600')
        else:
            self.send_header('Cache-Control', 'no-cache')
        super().end_headers()

    def log_message(self, format, *args):
        # Статика шумная — логируем только ошибки (404 и т.п.)
        if QUIET:
            return
        try:
            status = int(args[1]) if len(args) > 1 else 0
        except Exception:
            status = 0
        if status >= 400:
            ip = self.client_address[0] if self.client_address else '?'
            try:
                line = format % args if args else format
            except Exception:
                line = format
            print(f'[{now_str()}] {ip} {line}', flush=True)


def run_server(handler_class, port, name):
    """Запускает сервер в отдельном потоке.
       Слушает на 0.0.0.0 — доступен с других устройств в сети.
       URL для печати: подставляем актуальный IP компьютера."""
    server = ThreadingHTTPServer(('0.0.0.0', port), handler_class)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()

    # Определяем локальный IP для подсказки в консоли
    local_ip = '127.0.0.1'
    try:
        import socket
        s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        s.connect(('8.8.8.8', 80))
        local_ip = s.getsockname()[0]
        s.close()
    except Exception:
        pass

    log(f'  {name}: http://{local_ip}:{port}  (локально: http://127.0.0.1:{port})')
    return server


def main():
    parser = argparse.ArgumentParser(description='BookHaven 3D — сервер разработки')
    parser.add_argument('--static', action='store_true', help='Только статический сервер (8080)')
    parser.add_argument('--api', action='store_true', help='Только API-сервер (8001)')
    parser.add_argument('--quiet', action='store_true', help='Не выводить логи запросов в терминал')
    args = parser.parse_args()

    global QUIET
    QUIET = args.quiet

    # Если не указаны флаги — запускаем оба
    run_static = args.static or not args.api
    run_api = args.api or not args.static

    log(f'BookHaven 3D — запуск серверов (pid {os.getpid()})')
    servers = []

    if run_static:
        servers.append(run_server(StaticHandler, 8080, 'Статика'))

    if run_api:
        servers.append(run_server(APIHandler, 8001, 'API'))

    log('Готово. Нажмите Ctrl+C для остановки.')

    try:
        # Держим главный поток живым
        while True:
            threading.Event().wait(1)
    except KeyboardInterrupt:
        log('Остановка серверов...')
        for s in servers:
            s.shutdown()
        log('Готово.')


if __name__ == '__main__':
    main()
