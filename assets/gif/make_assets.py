#!/usr/bin/env python3
"""Пересоздание ассетов для README: скриншоты и GIF-анимации.

Скриншоты и GIF снимаются headless-браузером Chrome с живого сервера
(должен быть запущен: python3 server.py). Анимации перелистывания
записываются через CDP (Chrome DevTools Protocol) — headless Chrome
начинает запись экрана (Page.startScreencast) и кадры складываются
в GIF через ffmpeg.

Использование:
    python3 assets/gif/make_assets.py            # всё
    python3 assets/gif/make_assets.py --shots   # только скриншоты
    python3 assets/gif/make_assets.py --gifs    # только GIF
"""

import argparse
import base64
import json
import os
import shutil
import socket
import subprocess
import sys
import tempfile
import time
import urllib.request

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
SHOTS = os.path.join(ROOT, 'assets', 'screenshots')
GIF_DIR = os.path.join(ROOT, 'assets', 'gif')
CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
BASE = 'http://127.0.0.1:8080'

W, H = 1440, 900          # размер окна для скриншотов
MOBILE_W, MOBILE_H = 480, 850   # «телефон» для одностраничного режима


def log(msg):
    print(msg, flush=True)


def wait_server(timeout=10):
    """Ждёт, пока статический сервер ответит."""
    deadline = time.time() + timeout
    while time.time() < deadline:
        try:
            urllib.request.urlopen(f'{BASE}/', timeout=1)
            return True
        except Exception:
            time.sleep(0.3)
    return False


def chrome_screenshot(url, out, width=W, height=H, wait_ms=6000, extra_args=None):
    """Скриншот страницы headless-браузером."""
    args = [
        CHROME,
        '--headless=new',
        '--disable-gpu',
        f'--window-size={width},{height}',
        '--hide-scrollbars',
        '--force-device-scale-factor=2',   # retina-качество
        f'--virtual-time-budget={wait_ms}',
        f'--screenshot={out}',
    ]
    if extra_args:
        args += extra_args
    args.append(url)
    subprocess.run(args, capture_output=True, timeout=60)
    return os.path.exists(out) and os.path.getsize(out) > 10000


def js_url(path, js):
    """URL с внедрённым JS: скрипт выполняется до загрузки страницы
    через data:URL нельзя (CSP), поэтому используем фрагмент #eval:
    читалка его не знает — вместо этого JS подмешиваем через
    query-параметр и выполняем через --run-all-compositor-stages-before-draw.
    Проще: скриншотим страницу, потом дергаем её API через CDP.
    """
    raise NotImplementedError


def find_free_port():
    s = socket.socket()
    s.bind(('', 0))
    port = s.getsockname()[1]
    s.close()
    return port


class CDP:
    """Минимальный CDP-клиент через websocket к headless Chrome.

    Используется для записи GIF: Page.startScreencast отдаёт кадры,
    мы пишем их в PNG и склеиваем в GIF через ffmpeg.
    """

    def __init__(self, port):
        import http.client
        self.port = port
        self.conn = http.client.HTTPConnection('127.0.0.1', port)

    def send(self, method, params=None):
        self.conn.request('GET', f'/json/list')
        return json.loads(self.conn.getresponse().read())


def record_gif(out, duration=6, width=W, height=H, actions=None):
    """Записывает GIF: скринкаст headless Chrome → кадры → ffmpeg.

    out — путь итогового GIF. actions — список (delay_sec, js_expression):
    JS выполняется в странице через CDP Runtime.evaluate.
    """
    port = find_free_port()
    profile = tempfile.mkdtemp(prefix='bh-chrome-')
    proc = subprocess.Popen([
        CHROME,
        f'--remote-debugging-port={port}',
        f'--user-data-dir={profile}',
        '--headless=new',
        '--disable-gpu',
        f'--window-size={width},{height}',
        '--hide-scrollbars',
        '--force-device-scale-factor=1',
        BASE + '/',
    ], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)

    try:
        # Подключаемся к СТРАНИЦЕ (type=page) через проверенный CDPSession
        cdp = cdp_connect(port)
        if not cdp:
            log('  ! CDP не поднялся')
            return False
        cdp.call('Page.enable')
        cdp.call('Runtime.enable')
        time.sleep(0.5)

        # ЕДИНООБРАЗИЕ ГАММЫ: все GIF начинаются с темы paper.
        # Прошлый прогон settings-themes.gif переключал тему на sky и
        # СОХРАНЯЛ её на сервер — следующие GIF грузили sky с сервера
        # и получались в другой гамме. Принудительно ставим paper
        # (и в DOM, и в localStorage, чтобы не «откатилось»).
        cdp.call('Runtime.evaluate', {
            'expression': (
                "document.documentElement.dataset.theme='paper';"
                "try{const s=JSON.parse(localStorage.getItem('bookhaven3d')||'{}');"
                "s.settings=s.settings||{};s.settings.theme='paper';"
                "localStorage.setItem('bookhaven3d',JSON.stringify(s));}catch(e){}"
            ),
            'awaitPromise': False,
        })
        time.sleep(0.3)

        frames_dir = tempfile.mkdtemp(prefix='bh-frames-')
        frame_count = [0]

        # Покадровая съёмка: Page.captureScreenshot в цикле 15 раз/сек.
        # Надёжнее скринкаста: headless Chrome рендерит по требованию,
        # и screencast отдаёт кадры только при «заметных» изменениях.
        FPS = 15
        interval = 1.0 / FPS

        schedule = actions or []
        start = time.time()
        next_action = 0
        end = start + duration
        next_frame = start

        while time.time() < end:
            now = time.time()
            # Выполняем запланированные действия
            while next_action < len(schedule) and now - start >= schedule[next_action][0]:
                cdp.call('Runtime.evaluate', {'expression': schedule[next_action][1], 'awaitPromise': False})
                next_action += 1
            # Кадр по расписанию
            if now >= next_frame:
                res = cdp.call('Page.captureScreenshot', {'format': 'jpeg', 'quality': 80})
                if res and 'result' in res and 'data' in res['result']:
                    fn = os.path.join(frames_dir, f'f{frame_count[0]:04d}.jpg')
                    with open(fn, 'wb') as f:
                        f.write(base64.b64decode(res['result']['data']))
                    frame_count[0] += 1
                next_frame += interval
            time.sleep(0.01)

        if frame_count[0] < 4:
            log(f'  ! Слишком мало кадров: {frame_count[0]}')
            return False

        # Склеиваем кадры в GIF через ffmpeg: 15 fps, палитра 256
        palette = os.path.join(frames_dir, 'palette.png')
        subprocess.run([
            'ffmpeg', '-y', '-v', 'error',
            '-framerate', '15', '-i', os.path.join(frames_dir, 'f%04d.jpg'),
            '-vf', 'palettegen=max_colors=256:stats_mode=diff',
            palette,
        ], check=False)
        subprocess.run([
            'ffmpeg', '-y', '-v', 'error',
            '-framerate', '15', '-i', os.path.join(frames_dir, 'f%04d.jpg'),
            '-i', palette,
            '-lavfi', 'paletteuse=dither=bayer:bayer_scale=4',
            '-loop', '0',
            out,
        ], check=False)
        ok = os.path.exists(out) and os.path.getsize(out) > 50000
        log(f'  кадров: {frame_count[0]}, GIF: {os.path.getsize(out)/1024/1024:.1f} МБ' if ok else '  ! GIF не собрался')
        shutil.rmtree(frames_dir, ignore_errors=True)
        return ok
    finally:
        proc.terminate()
        try:
            proc.wait(timeout=5)
        except Exception:
            proc.kill()
        shutil.rmtree(profile, ignore_errors=True)


class WS:
    """Минимальный WebSocket-клиент (только текстовые фреймы, без фрагментации)."""

    def __init__(self, sock):
        self.sock = sock
        self.buf = b''

    def send(self, text):
        # RFC 6455: КЛИЕНТСКИЕ фреймы обязаны быть маскированы —
        # Chrome закрывает соединение на немаскированный фрейм
        data = text.encode()
        mask = os.urandom(4)
        masked = bytes(b ^ mask[i % 4] for i, b in enumerate(data))
        ln = len(data)
        header = b'\x81'
        if ln < 126:
            header += bytes([0x80 | ln])
        elif ln < 65536:
            header += bytes([0x80 | 126]) + ln.to_bytes(2, 'big')
        else:
            header += bytes([0x80 | 127]) + ln.to_bytes(8, 'big')
        self.sock.sendall(header + mask + masked)

    def _read(self, n):
        while len(self.buf) < n:
            chunk = self.sock.recv(65536)
            if not chunk:
                raise ConnectionError('ws closed')
            self.buf += chunk
        out, self.buf = self.buf[:n], self.buf[n:]
        return out

    def recv(self):
        """Читает один текстовый фрейм (маскированные не приходят от сервера)."""
        b1, b2 = self._read(2)
        opcode = b1 & 0x0F
        ln = b2 & 0x7F
        if ln == 126:
            ln = int.from_bytes(self._read(2), 'big')
        elif ln == 127:
            ln = int.from_bytes(self._read(8), 'big')
        payload = self._read(ln) if ln else b''
        if opcode == 0x9:      # ping → pong
            self.sock.sendall(bytes([0x8A, 0]))
            return self.recv()
        if opcode == 0x8:      # close
            raise ConnectionError('ws close')
        return payload.decode('utf-8', 'replace')


# ---------- Сценарии ----------

def take_screenshots():
    """Все скриншоты для README: библиотека, читалка, темы, панели."""
    os.makedirs(SHOTS, exist_ok=True)
    ok = 0
    total = 0

    def shot(name, url, **kw):
        nonlocal ok, total
        total += 1
        out = os.path.join(SHOTS, name)
        if chrome_screenshot(url, out, **kw):
            log(f'  ✓ {name} ({os.path.getsize(out)//1024} КБ)')
            ok += 1
        else:
            log(f'  ✗ {name}')

    log('Скриншоты…')
    shot('library.png', f'{BASE}/')
    # Читалка: книга открывается кликом по карточке — снимаем через CDP
    log('Скриншоты читалки (CDP-сценарии)…')
    cdp_shots = [
        # (имя, JS-подготовка, пауза после JS)
        ('reader.png', [
            # Обычная книга без картинок — «Печать луны», дефолтная тема.
            # Совпадает с theme-paper.png — это нормально: reader показывает
            # общий вид, theme-paper — ту же тему в таблице тем README.
            ("[...document.querySelectorAll('.book-card')].find(c=>c.querySelector('.book-meta-title')?.textContent.includes('Печать луны'))?.click()", 4.0),
        ]),
        ('theme-paper.png', [
            ("[...document.querySelectorAll('.book-card')].find(c=>c.querySelector('.book-meta-title')?.textContent.includes('Печать луны'))?.click()", 4.0),
            ("document.documentElement.dataset.theme='paper'", 1.0),
        ]),
        ('theme-sepia.png', [
            ("[...document.querySelectorAll('.book-card')].find(c=>c.querySelector('.book-meta-title')?.textContent.includes('Печать луны'))?.click()", 4.0),
            ("document.documentElement.dataset.theme='sepia'", 1.0),
        ]),
        ('theme-night.png', [
            ("[...document.querySelectorAll('.book-card')].find(c=>c.querySelector('.book-meta-title')?.textContent.includes('Печать луны'))?.click()", 4.0),
            ("document.documentElement.dataset.theme='night'", 1.0),
        ]),
        ('theme-forest.png', [
            ("[...document.querySelectorAll('.book-card')].find(c=>c.querySelector('.book-meta-title')?.textContent.includes('Печать луны'))?.click()", 4.0),
            ("document.documentElement.dataset.theme='forest'", 1.0),
        ]),
        ('theme-sky.png', [
            ("[...document.querySelectorAll('.book-card')].find(c=>c.querySelector('.book-meta-title')?.textContent.includes('Печать луны'))?.click()", 4.0),
            ("document.documentElement.dataset.theme='sky'", 1.0),
        ]),
        ('settings.png', [
            ("[...document.querySelectorAll('.book-card')].find(c=>c.querySelector('.book-meta-title')?.textContent.includes('Печать луны'))?.click()", 4.0),
            ("document.getElementById('btnSettings').click()", 1.5),
        ]),
        ('bookmarks.png', [
            ("[...document.querySelectorAll('.book-card')].find(c=>c.querySelector('.book-meta-title')?.textContent.includes('Печать луны'))?.click()", 4.0),
            ("document.getElementById('btnBookmark').click()", 1.5),
        ]),
        ('toc.png', [
            ("[...document.querySelectorAll('.book-card')].find(c=>c.querySelector('.book-meta-title')?.textContent.includes('Печать луны'))?.click()", 4.0),
            ("document.getElementById('btnToc').click()", 1.5),
        ]),
        ('footnote-tooltip.png', [
            # «Отцы и дети»: первая сноска на ~2-й странице
            ("[...document.querySelectorAll('.book-card')].find(c=>c.textContent.includes('Отцы и дети'))?.click()", 4.0),
            # Листаем вперёд, пока не появится сноска (до 10 страниц)
            ("(async()=>{for(let i=0;i<10;i++){if(document.querySelector('.note-ref'))return true;document.getElementById('navRight').click();await new Promise(r=>setTimeout(r,900));}return false;})()", 0.5),
            # Наводим на сноску (mouseover + mouseenter — тултип слушает оба)
            ("(()=>{const n=document.querySelector('.note-ref'); if(n){n.dispatchEvent(new MouseEvent('mouseover',{bubbles:true})); n.dispatchEvent(new MouseEvent('mouseenter',{bubbles:true}));}})()", 2.0),
        ]),
        ('footnote-target.png', [
            ("[...document.querySelectorAll('.book-card')].find(c=>c.textContent.includes('Отцы и дети'))?.click()", 4.0),
            ("(async()=>{for(let i=0;i<10;i++){if(document.querySelector('.note-ref'))return true;document.getElementById('navRight').click();await new Promise(r=>setTimeout(r,900));}return false;})()", 0.5),
            ("document.querySelector('.note-ref')?.click()", 2.5),
        ]),
        ('images.png', [
            # Книга с картинками: «Иррациональный модернизм» (дада, арт-бук).
            # Ищем по слову «модернизм» в названии карточки.
            ("[...document.querySelectorAll('.book-card')].find(c=>c.querySelector('.book-meta-title')?.textContent.includes('модернизм'))?.click()", 4.0),
            # Ждём загрузки картинок (они грузятся с сервера асинхронно)
            ("(async()=>{for(let i=0;i<20;i++){const imgs=[...document.querySelectorAll('img')];if(imgs.length&&imgs.every(i=>i.complete))return true;await new Promise(r=>setTimeout(r,500));}return false;})()", 0.5),
        ]),
    ]
    for name, steps in cdp_shots:
        total += 1
        out = os.path.join(SHOTS, name)
        if cdp_screenshot(out, steps):
            log(f'  ✓ {name} ({os.path.getsize(out)//1024} КБ)')
            ok += 1
        else:
            log(f'  ✗ {name}')
    return ok, total


def cdp_screenshot(out, steps, width=W, height=H):
    """Скриншот с подготовкой через JS (CDP Runtime.evaluate):
    открываем книгу, меняем тему, дергаем панели — потом Page.captureScreenshot.
    steps: список (js, пауза_после)."""
    port = find_free_port()
    profile = tempfile.mkdtemp(prefix='bh-chrome-')
    proc = subprocess.Popen([
        CHROME,
        f'--remote-debugging-port={port}',
        f'--user-data-dir={profile}',
        '--headless=new',
        '--disable-gpu',
        f'--window-size={width},{height}',
        '--hide-scrollbars',
        '--force-device-scale-factor=2',
        BASE + '/',
    ], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    try:
        ws = cdp_connect(port)
        if not ws:
            return False
        ws.call('Page.enable')
        ws.call('Runtime.enable')
        time.sleep(1.5)

        for js, pause in steps:
            # awaitPromise: шаги с async IIFE должны дожидаться результата
            ws.call('Runtime.evaluate', {'expression': js, 'awaitPromise': True, 'returnByValue': True})
            time.sleep(pause)

        # Ждём, пока книга откроется и текст ляжет на страницы:
        # до 15 сек, проверяем каждые 0.5 с (загрузка FB2 с сервера)
        ws.call('Runtime.evaluate', {
            'expression': (
                "(async()=>{"
                "for(let i=0;i<30;i++){"
                "const t=document.getElementById('contentUnderRight')?.textContent||'';"
                "if(t.length>50) return true;"
                "await new Promise(r=>setTimeout(r,500));"
                "}return false;})()"
            ),
            'awaitPromise': True,
            'returnByValue': True,
        })

        # Кадр
        res = ws.call('Page.captureScreenshot', {'format': 'png'})
        if not res or 'result' not in res or 'data' not in res['result']:
            return False
        with open(out, 'wb') as f:
            f.write(base64.b64decode(res['result']['data']))
        return os.path.getsize(out) > 10000
    finally:
        proc.terminate()
        try:
            proc.wait(timeout=5)
        except Exception:
            proc.kill()
        shutil.rmtree(profile, ignore_errors=True)


class CDPSession:
    """CDP поверх WebSocket: call() шлёт команду и ждёт ответ по id."""

    def __init__(self, ws):
        self.ws = ws
        self.id = 0
        self.pending = {}      # id -> результат
        self.events = []

    def call(self, method, params=None, timeout=15):
        self.id += 1
        mid = self.id
        self.ws.send(json.dumps({'id': mid, 'method': method, 'params': params or {}}))
        deadline = time.time() + timeout
        # Таймаут на сокете: иначе recv() блокируется навсегда
        self.ws.sock.settimeout(0.5)
        while time.time() < deadline:
            if mid in self.pending:
                return self.pending.pop(mid)
            try:
                msg = self.ws.recv()
                if not msg:
                    continue
                data = json.loads(msg)
                if 'id' in data:
                    self.pending[data['id']] = data
                else:
                    self.events.append(data)
            except (socket.timeout, TimeoutError):
                continue
            except ConnectionError:
                return None
        return None


def cdp_connect(port, timeout=10):
    """Поднимает WebSocket-сессию со СТРАНИЦЕЙ (type=page) headless Chrome.
    В /json/list есть и служебные таргеты (browser_ui, service_worker) —
    их нужно отфильтровать, иначе WebSocket закрывается сразу."""
    import http.client
    ws_url = None
    for _ in range(40):
        try:
            c = http.client.HTTPConnection('127.0.0.1', port, timeout=1)
            c.request('GET', '/json/list')
            pages = json.loads(c.getresponse().read())
            # Только настоящая страница с нашим URL
            page = next((p for p in pages if p.get('type') == 'page' and '127.0.0.1:8080' in p.get('url', '')), None)
            if page:
                ws_url = page['webSocketDebuggerUrl']
                break
        except Exception:
            pass
        time.sleep(0.25)
    if not ws_url:
        return None
    from urllib.parse import urlparse
    u = urlparse(ws_url)
    sock = socket.create_connection((u.hostname, u.port), timeout=5)
    key = base64.b64encode(os.urandom(16)).decode()
    sock.sendall((
        f'GET {u.path} HTTP/1.1\r\n'
        f'Host: {u.hostname}:{u.port}\r\n'
        'Upgrade: websocket\r\nConnection: Upgrade\r\n'
        f'Sec-WebSocket-Key: {key}\r\n'
        'Sec-WebSocket-Version: 13\r\n\r\n'
    ).encode())
    buf = b''
    while b'\r\n\r\n' not in buf:
        buf += sock.recv(4096)
    return CDPSession(WS(sock))


def take_gifs():
    """GIF-анимации для README: перелистывание, мобильный режим, темы."""
    os.makedirs(GIF_DIR, exist_ok=True)
    ok = 0
    total = 0

    log('GIF-анимации…')

    # 1. Перелистывание в читалке: серия листаний подряд
    total += 1
    if record_gif(
        os.path.join(GIF_DIR, 'reader-flip.gif'),
        duration=12,
        actions=[
            # (время, JS): открываем книгу, потом листаем серию
            (1.0, "[...document.querySelectorAll('.book-card')].find(c=>c.querySelector('.book-meta-title')?.textContent.includes('Печать луны'))?.click()"),
            (6.0, "document.getElementById('navRight').click()"),
            (8.0, "document.getElementById('navRight').click()"),
            (10.0, "document.getElementById('navRight').click()"),
        ],
    ):
        log('  ✓ reader-flip.gif')
        ok += 1
    else:
        log('  ✗ reader-flip.gif')

    # 2. Мобильный одностраничный режим: узкое окно
    total += 1
    if record_gif(
        os.path.join(GIF_DIR, 'reader-flip-mobile.gif'),
        duration=10,
        width=MOBILE_W, height=MOBILE_H,
        actions=[
            (1.0, "[...document.querySelectorAll('.book-card')].find(c=>c.querySelector('.book-meta-title')?.textContent.includes('Печать луны'))?.click()"),
            (6.0, "document.getElementById('navRight').click()"),
            (8.0, "document.getElementById('navRight').click()"),
        ],
    ):
        log('  ✓ reader-flip-mobile.gif')
        ok += 1
    else:
        log('  ✗ reader-flip-mobile.gif')

    # 3. Темы и настройки: открываем панель, листаем темы.
    #    Снимается ПОСЛЕДНИМ: переключение тем сохраняется на сервер,
    #    и следующие GIF-записи подхватили бы чужую тему.
    #    В конце возвращаем paper, чтобы сервер остался в дефолте.
    total += 1
    if record_gif(
        os.path.join(GIF_DIR, 'settings-themes.gif'),
        duration=12,
        actions=[
            (1.0, "[...document.querySelectorAll('.book-card')].find(c=>c.querySelector('.book-meta-title')?.textContent.includes('Печать луны'))?.click()"),
            (5.0, "document.getElementById('btnSettings').click()"),
            (7.0, "[...document.querySelectorAll('.theme-dot')][1].click()"),
            (9.0, "[...document.querySelectorAll('.theme-dot')][2].click()"),
            (11.0, "[...document.querySelectorAll('.theme-dot')][4].click()"),
            # Возвращаем paper КЛИКОМ по первой точке — так State.settings
            # обновится и persist сохранит на сервер дефолтную тему
            (11.8, "[...document.querySelectorAll('.theme-dot')][0].click()"),
        ],
    ):
        log('  ✓ settings-themes.gif')
        ok += 1
    else:
        log('  ✗ settings-themes.gif')

    return ok, total


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--shots', action='store_true')
    parser.add_argument('--gifs', action='store_true')
    args = parser.parse_args()

    if not wait_server():
        log(f'! Сервер {BASE} не отвечает — запустите: python3 server.py')
        sys.exit(1)

    if not os.path.exists(CHROME):
        log('! Chrome не найден')
        sys.exit(1)

    do_shots = args.shots or not args.gifs
    do_gifs = args.gifs or not args.shots

    if do_shots:
        take_screenshots()
    if do_gifs:
        take_gifs()


if __name__ == '__main__':
    main()
