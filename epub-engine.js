// EPUB 2/3 reader. Everything is decoded locally; no EPUB leaves the browser.
// Uses the bundled open-source JSZip library (vendor/jszip.min.js).
function xml(source) {
  const parsed = new DOMParser().parseFromString(source, 'application/xml');
  if (parsed.getElementsByTagName('parsererror').length) throw new Error('Ungültiges EPUB-XML');
  return parsed;
}
function descendants(node, name) {
  return [...node.getElementsByTagName('*')].filter(el => el.localName.toLowerCase() === name);
}
function first(node, name) { return descendants(node,name)[0]; }
function normalizedPath(base, relative) {
  const clean = relative.split(/[?#]/)[0];
  if (!clean) return '';
  const parts = clean.startsWith('/') ? [] : base.split('/').slice(0, -1);
  for (const segment of clean.split('/')) {
    if (!segment || segment === '.') continue;
    if (segment === '..') {parts.pop();continue;}
    let decoded = segment;
    try { decoded = decodeURIComponent(segment); } catch {}
    parts.push(decoded);
  }
  return parts.join('/');
}
function zipEntry(zip, path) {
  // ZIP entry names can be either URL-decoded or percent-encoded.
  return zip.file(path) || zip.file(encodeURI(path)) || zip.file(path.replaceAll(' ', '%20'));
}
function mime(path) {
  const ext = path.split('.').at(-1)?.toLowerCase();
  return ({jpg:'image/jpeg',jpeg:'image/jpeg',png:'image/png',gif:'image/gif',webp:'image/webp',avif:'image/avif'})[ext] || null;
}
async function imageData(zip, path) {
  const entry = zipEntry(zip, path), type=mime(path);
  if (!entry || !type) return null;
  const base64 = await entry.async('base64');
  return `data:${type};base64,${base64}`;
}
async function smallCover(dataUri) {
  if (!dataUri) return null;
  try {
    const image = new Image();
    image.src = dataUri;
    await image.decode();
    const scale = Math.min(1, 250 / image.naturalWidth, 350 / image.naturalHeight);
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1,Math.round(image.naturalWidth * scale));
    canvas.height = Math.max(1,Math.round(image.naturalHeight * scale));
    canvas.getContext('2d').drawImage(image,0,0,canvas.width,canvas.height);
    return canvas.toDataURL('image/jpeg',.8);
  } catch { return null; }
}
export async function loadEpub(blob) {
  if (!globalThis.JSZip) throw new Error('EPUB-Modul nicht geladen');
  const zip = await JSZip.loadAsync(await blob.arrayBuffer());
  const container = zipEntry(zip,'META-INF/container.xml');
  if (!container) throw new Error('EPUB enthält keine Container-Datei');
  const root = first(xml(await container.async('text')), 'rootfile');
  const packagePath = root?.getAttribute('full-path');
  if (!packagePath) throw new Error('EPUB-Paketdatei fehlt');
  const opfEntry = zipEntry(zip, packagePath);
  if (!opfEntry) throw new Error('EPUB-Paketdatei nicht gefunden');
  const opf = xml(await opfEntry.async('text'));
  const title = first(opf,'title')?.textContent?.trim() || blob.name?.replace(/\.epub$/i,'') || 'Unbenanntes Buch';
  const author = first(opf,'creator')?.textContent?.trim() || '';
  const manifest = new Map();
  for (const item of descendants(opf,'item')) {
    const id = item.getAttribute('id'), href = item.getAttribute('href');
    if (!id || !href) continue;
    manifest.set(id,{id,path:normalizedPath(packagePath,href),type:item.getAttribute('media-type')||'',properties:item.getAttribute('properties')||''});
  }
  const chapters = descendants(opf,'itemref').filter(item=>item.getAttribute('linear')!=='no')
    .map(item=>manifest.get(item.getAttribute('idref')))
    .filter(item=>item && /(?:xhtml|html|xml)/i.test(item.type) && !item.properties.split(/\s+/).includes('nav') && zipEntry(zip,item.path));
  if (!chapters.length) throw new Error('EPUB enthält keine lesbaren Kapitel');
  let coverItem = [...manifest.values()].find(item => item.properties.split(/\s+/).includes('cover-image'));
  if (!coverItem) {
    const oldCoverId=descendants(opf,'meta').find(item=>item.getAttribute('name')==='cover')?.getAttribute('content');
    coverItem=manifest.get(oldCoverId);
  }
  let cover=null;
  if (coverItem?.path) cover=await smallCover(await imageData(zip,coverItem.path));
  return {zip,chapters,title,author,cover};
}
function cleanText(value) {
  return (value||'').replace(/[\u200b\ufeff]/g,'').replace(/[\t\r\n ]+/g,' ').trim();
}
export async function extractEpubChapter(epub, chapterIndex) {
  const chapter=epub.chapters[chapterIndex];
  if (!chapter) return [];
  const entry=zipEntry(epub.zip,chapter.path);
  if (!entry) throw new Error('Kapitel fehlt');
  const source=await entry.async('text');
  // Parse as XML when valid, fall back to HTML for older EPUBs.
  let parsed=new DOMParser().parseFromString(source,'application/xhtml+xml');
  if (parsed.querySelector('parsererror')) parsed=new DOMParser().parseFromString(source,'text/html');
  const body=first(parsed,'body') || parsed.documentElement;
  const blocks=[]; let offset=0;let count=0;
  function addText(text,type='body') {
    text=cleanText(text);
    if(!text)return;
    blocks.push({type,text,start:offset,end:offset+text.length});offset+=text.length;
  }
  async function walk(el) {
    if(count++>30000)return;
    if(el.nodeType!==1) return;
    const tag=el.localName?.toLowerCase()||'';
    if(['script','style','noscript','iframe','object','embed','form','video','audio','svg','math','nav'].includes(tag)) return;
    if(tag==='img') {
      const src=el.getAttribute('src')||el.getAttribute('data-src')||'';
      const path=normalizedPath(chapter.path,src);
      if(path && !/^\w+:/.test(src)) {
        const data=await imageData(epub.zip,path);
        if(data) blocks.push({type:'image',src:data,alt:cleanText(el.getAttribute('alt')||''),start:offset,end:offset});
      }
      return;
    }
    if (/^h[1-6]$/.test(tag)) {addText(el.textContent,'heading');return;}
    if (['p','li','dt','dd','pre','blockquote','figcaption','th','td'].includes(tag)) {
      addText((tag==='li'?'• ':'')+el.textContent,tag==='blockquote'?'quote':'body');
      // Some EPUBs place illustrations inline inside a paragraph.
      for (const child of el.querySelectorAll('img')) await walk(child);
      return;
    }
    if(['hr','br'].includes(tag))return;
    // EPUBs may contain bare text in div/section without paragraph tags.
    let loose='';
    for (const child of el.childNodes) {
      if(child.nodeType===3) loose+=' '+child.textContent;
      else {addText(loose);loose='';await walk(child);}
    }
    addText(loose);
  }
  await walk(body);
  return blocks;
}
