/* ===== BookHaven 3D — парсеры форматов книг =====
   TXT и EPUB разбираются в браузере.
   FB2 обрабатывается на сервере: там хранится оригинальный файл,
   а текст и метаданные извлекаются на лету. */

/**
 * Парсер EPUB через epub.js (загружается из /lib/).
 * Возвращает Promise с текстом книги.
 */
export async function parseEPUB(arrayBuffer) {
  if (typeof ePub === 'undefined') {
    throw new Error('epub.js не загружен');
  }

  const book = ePub(arrayBuffer);
  await book.ready;

  const metadata = await book.loaded.metadata;
  const title = metadata?.title || 'Без названия';
  const author = metadata?.creator || 'Неизвестный автор';

  // Собираем текст из всех секций
  const sections = [];
  const spine = book.spine?.spineItems || [];

  for (const item of spine) {
    try {
      const doc = await book.load(item.href);
      const text = extractTextFromHTML(doc);
      if (text.trim()) {
        sections.push(text.trim());
      }
    } catch {
      // Пропускаем проблемные секции
    }
  }

  return {
    title,
    author,
    text: sections.join('\n\n'),
  };
}

/**
 * Извлекает чистый текст из HTML-документа EPUB.
 */
function extractTextFromHTML(doc) {
  if (!doc?.body) return '';

  // Удаляем скрипты и стили
  const scripts = doc.querySelectorAll('script, style');
  for (const el of scripts) el.remove();

  // Собираем текст из параграфов и заголовков
  const blocks = doc.body.querySelectorAll('p, h1, h2, h3, h4, h5, h6, blockquote, li');
  const texts = [];

  for (const block of blocks) {
    const text = block.textContent?.trim();
    if (text) texts.push(text);
  }

  return texts.join('\n\n');
}

/**
 * Универсальный парсер книги (TXT и EPUB; FB2 обрабатывает сервер).
 */
export async function parseBook(file) {
  const filename = file.name;
  const ext = filename.toLowerCase().split('.').pop();

  if (ext === 'epub') {
    const buffer = await file.arrayBuffer();
    return parseEPUB(buffer);
  }

  const text = await file.text();

  // TXT
  return {
    title: filename.replace(/\.txt$/i, ''),
    author: 'Неизвестный автор',
    text,
  };
}
