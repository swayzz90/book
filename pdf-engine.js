// The PDF.js library is loaded when first needed. Only its code comes from
// a CDN; the actual PDF file is parsed locally in the user's browser.
if (!Promise.withResolvers) {
  Promise.withResolvers = function () {
    let resolve, reject;
    const promise = new Promise((res, rej) => {resolve = res; reject = rej;});
    return {promise, resolve, reject};
  };
}
const VERSION = '4.10.38';
const CDN = `https://cdn.jsdelivr.net/npm/pdfjs-dist@${VERSION}/build/`;
let libraryPromise;

export function getPDFLibrary() {
  if (!libraryPromise) {
    libraryPromise = import(/* @vite-ignore */ `${CDN}pdf.min.mjs`).then((library) => {
      library.GlobalWorkerOptions.workerSrc = `${CDN}pdf.worker.min.mjs`;
      return library;
    }).catch((error) => {
      libraryPromise = null;
      throw error;
    });
  }
  return libraryPromise;
}

export async function loadDocument(blob) {
  const pdfjs = await getPDFLibrary();
  const bytes = new Uint8Array(await blob.arrayBuffer());
  return pdfjs.getDocument({ data: bytes, useSystemFonts: true }).promise;
}

export async function makeCover(document) {
  try {
    const page = await document.getPage(1);
    const first = page.getViewport({ scale: 1 });
    const view = page.getViewport({ scale: 230 / first.width });
    const canvas = window.document.createElement('canvas');
    canvas.width = Math.ceil(view.width);
    canvas.height = Math.ceil(view.height);
    await page.render({ canvasContext: canvas.getContext('2d'), viewport: view }).promise;
    return canvas.toDataURL('image/jpeg', .83);
  } catch (error) {
    console.warn('Keine Vorschau verfügbar:', error);
    return null;
  }
}

// PDF has positioned glyphs instead of semantic paragraphs. This is a
// best-effort text reflow; complex multi-column layouts can differ.
export async function extractPage(document, pageNumber) {
  const page = await document.getPage(pageNumber);
  const content = await page.getTextContent();
  const items = content.items.filter(item => typeof item.str === 'string' && item.str.length);
  if (!items.length) return [];
  const lines = [];
  let current = null;
  for (const item of items) {
    const x = item.transform?.[4] ?? 0;
    const y = item.transform?.[5] ?? 0;
    const size = Math.max(6, Math.hypot(item.transform?.[2] ?? 0, item.transform?.[3] ?? 11));
    if (!current || Math.abs(y - current.y) > Math.max(2.6, size * .32) || x < current.x - 7) {
      current = { text: '', x, y, size, count: 0, right: x };
      lines.push(current);
    }
    const needsSpace = current.text && !/\s$/.test(current.text) && !/^\s/.test(item.str)
      && x > current.right + size * .2;
    current.text += (needsSpace ? ' ' : '') + item.str;
    current.right = x + (item.width ?? 0);
    current.size = (current.size * current.count + size) / (current.count + 1);
    current.count++;
    if (item.hasEOL) current = null;
  }
  const cleaned = lines.map(l => ({ ...l, text: l.text.trim() })).filter(l => l.text);
  const sizes = cleaned.map(l => l.size).sort((a,b) => a-b);
  const typicalSize = sizes[Math.floor(sizes.length / 2)] || 11;
  const gaps = [];
  for (let i = 1; i < cleaned.length; i++) {
    const dy = Math.abs(cleaned[i].y - cleaned[i-1].y);
    if (dy > 2 && dy < typicalSize * 2.8) gaps.push(dy);
  }
  gaps.sort((a,b) => a-b);
  const typicalGap = gaps[Math.floor(gaps.length / 2)] || typicalSize * 1.35;
  const blocks = [];
  let paragraph = '';
  const flush = () => {
    if (paragraph.trim()) blocks.push({ text: paragraph.trim(), type: 'body' });
    paragraph = '';
  };
  for (let i = 0; i < cleaned.length; i++) {
    const line = cleaned[i];
    const prev = cleaned[i-1];
    const gap = prev ? Math.abs(line.y - prev.y) : 0;
    const large = line.size > typicalSize * 1.23 && line.text.length < 110;
    const gapBreak = !!prev && gap > Math.max(typicalGap * 1.52, typicalSize * 1.6);
    const indented = !!prev && Math.abs(line.x-prev.x) > typicalSize * 2.5;
    if (gapBreak || indented || large) flush();
    if (large) {
      blocks.push({ text: line.text, type: 'heading' });
    } else if (!paragraph) {
      paragraph = line.text;
    } else if (paragraph.endsWith('-') && /^[\p{Ll}]/u.test(line.text)) {
      paragraph = paragraph.slice(0, -1) + line.text;
    } else {
      paragraph += ' ' + line.text;
    }
  }
  flush();
  let offset = 0;
  return blocks.map(block => {
    const result = { ...block, start: offset, end: offset + block.text.length };
    offset = result.end;
    return result;
  });
}

export async function renderPDFPage(document, pageNumber, canvas, availableWidth, zoom = 1) {
  const page = await document.getPage(pageNumber);
  const original = page.getViewport({scale: 1});
  const scale = Math.min(1.6, availableWidth / original.width) * zoom;
  const cssView = page.getViewport({scale});
  const deviceRatio = Math.min(window.devicePixelRatio || 1, 2);
  const view = page.getViewport({scale: scale * deviceRatio});
  canvas.width = Math.floor(view.width);
  canvas.height = Math.floor(view.height);
  canvas.style.width = `${Math.ceil(cssView.width)}px`;
  canvas.style.height = `${Math.ceil(cssView.height)}px`;
  await page.render({canvasContext: canvas.getContext('2d', {alpha: false}), viewport: view}).promise;
}
