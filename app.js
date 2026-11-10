import { getBooks, putBook, deleteBook } from './db.js';
import { loadDocument, makeCover, extractPage, renderPDFPage } from './pdf-engine.js';

const $ = (selector) => document.querySelector(selector);
const app = $('#app');
const fileInput = $('#file-input');
const writeQueue = new Map();
const savedPrefs = (() => { try { return JSON.parse(localStorage.getItem('blattwerk-settings')) || {}; } catch { return {}; } })();
const state = {
  books: [], currentId: null, doc: null, page: 0, mode: 'book', blocks: [], pageCache: new Map(),
  loadingPage: false, opening: false, importing: false, readerVersion: 0, pageVersion: 0,
  noteOpen: false, noteFilter: 'page', editingNote: null, settingsOpen: false,
  fontSize: savedPrefs.fontSize || 19, paper: savedPrefs.paper === 'white' ? 'white' : 'dark', zoom: 1,
  search: '', selectedText: null, modal: null,
};

const ICONS = {
  book: '<path d="M12 7.5c-3-2.2-6.3-2.2-9-1v13c2.7-1.2 6-1.2 9 1m0-13c3-2.2 6.3-2.2 9-1v13c-2.7-1.2-6-1.2-9 1m0-13v13"/>',
  bookOpen: '<path d="M12 7c-3-2.2-6.3-2.2-9-1v13c2.7-1.2 6-1.2 9 1m0-13c3-2.2 6.3-2.2 9-1v13c-2.7-1.2-6-1.2-9 1m0-13v13"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  upload: '<path d="M12 16V3m-5 5 5-5 5 5M4 15v4a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-4"/>',
  left: '<path d="m14 6-6 6 6 6"/>',
  right: '<path d="m10 6 6 6-6 6"/>',
  back: '<path d="m12 19-7-7 7-7M5 12h14"/>',
  note: '<rect x="4" y="3" width="16" height="18" rx="2"/><path d="M8 8h8M8 12h8M8 16h5"/>',
  pen: '<path d="m15 5 4 4M4 20l4.5-1 11-11a2.8 2.8 0 0 0-4-4l-11 11L4 20Z"/>',
  highlighter: '<path d="m9 11 4 4M4 20h9M6 15l9.5-9.5a2.1 2.1 0 0 1 3 3L9 18l-3-3Z"/>',
  lock: '<rect x="5" y="10" width="14" height="11" rx="2"/><path d="M8 10V7a4 4 0 0 1 8 0v3"/>',
  chevron: '<path d="m6 9 6 6 6-6"/>',
  search: '<circle cx="10.8" cy="10.8" r="7"/><path d="m16 16 5 5"/>',
  close: '<path d="M18 6 6 18M6 6l12 12"/>',
  trash: '<path d="M4 7h16M10 3h4M6 7l1 14h10l1-14M10 11v6M14 11v6"/>',
  check: '<path d="m5 12 4 4L19 6"/>',
  settings: '<path d="M4 6h16M4 12h16M4 18h16"/><circle cx="9" cy="6" r="2" fill="currentColor" stroke="white"/><circle cx="16" cy="12" r="2" fill="currentColor" stroke="white"/><circle cx="10" cy="18" r="2" fill="currentColor" stroke="white"/>',
  moon: '<path d="M20.3 15.1A8.8 8.8 0 0 1 8.9 3.7a8.8 8.8 0 1 0 11.4 11.4Z"/>',
  download: '<path d="M12 3v13m-5-5 5 5 5-5M4 17v4h16v-4"/>',
  file: '<path d="M13 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9zM13 2v7h7M8 13h8M8 17h6"/>',
  leaf: '<path d="M20 4C10 4 4 8 4 16a4 4 0 0 0 4 4C16 20 20 14 20 4ZM5 19c3-4 6-7 11-10"/>',
  spark: '<path d="m12 2 2.3 7.7L22 12l-7.7 2.3L12 22l-2.3-7.7L2 12l7.7-2.3L12 2Z"/>',
  more: '<circle cx="5" cy="12" r="1"/><circle cx="12" cy="12" r="1"/><circle cx="19" cy="12" r="1"/>',
  info: '<circle cx="12" cy="12" r="9"/><path d="M12 11v6M12 7h.01"/>',
  keyboard: '<rect x="2" y="5" width="20" height="14" rx="2"/><path d="M6 9h.01M10 9h.01M14 9h.01M18 9h.01M7 13h.01M11 13h.01M15 13h.01M6 16h12"/>',
  minus: '<path d="M5 12h14"/>',
};
function icon(name, size = 19) { return `<span class="icon" aria-hidden="true"><svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round">${ICONS[name] || ICONS.book}</svg></span>`; }
function esc(value='') { return String(value).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }
function bookNow() { return state.books.find(book => book.id === state.currentId); }
function pluralPages(n) { return `${n} ${n === 1 ? 'Seite' : 'Seiten'}`; }
function toast(message, error=false) {
  $('#toast-region').innerHTML = `<div class="toast ${error?'error':''}">${icon(error?'info':'check',17)}<span>${esc(message)}</span></div>`;
  clearTimeout(toast.timer); toast.timer = setTimeout(() => { $('#toast-region').innerHTML=''; }, 3800);
}
function persistPreferences() { try { localStorage.setItem('blattwerk-settings', JSON.stringify({fontSize:state.fontSize,paper:state.paper})); } catch {} }
function updateBook(id, patch) {
  const index = state.books.findIndex(book => book.id === id);
  if (index < 0) return;
  const updated = {...state.books[index], ...patch};
  state.books[index] = updated;
  const previous = writeQueue.get(id) || Promise.resolve();
  const queued = previous.catch(() => {}).then(() => putBook(updated)).catch(error => { console.error(error); toast('Die Änderung konnte nicht gespeichert werden.', true); });
  writeQueue.set(id, queued);
}
function progress(book) { if (!book.lastOpened) return 0; return Math.round((Math.min((book.lastPage || 0)+1,book.pageCount) / Math.max(1,book.pageCount)) * 100); }

function renderLibrary() {
  const filtered = [...state.books]
    .filter(book => book.title.toLowerCase().includes(state.search.toLowerCase()))
    .sort((a,b) => (b.lastOpened || b.addedAt) - (a.lastOpened || a.addedAt));
  const cards = filtered.map(book => `
    <article class="book-card">
      <button class="book-card-open" data-action="open-book" data-id="${esc(book.id)}" aria-label="${esc(book.title)} öffnen">
        <div class="cover-box">${book.cover ? `<img class="cover-pdf" alt="" src="${book.cover}">` : `<div class="cover-fallback">${icon('file',35)}<span>PDF</span></div>`}
        <span class="cover-open">${icon('right',19)}</span></div>
        <div class="book-card-title" title="${esc(book.title)}">${esc(book.title)}</div>
        <div class="book-card-sub"><span>${pluralPages(book.pageCount)}</span><span>${progress(book)}%</span></div>
        <div class="card-progress"><span style="width:${progress(book)}%"></span></div>
      </button>
      <button class="card-delete icon-btn" data-action="confirm-delete" data-id="${esc(book.id)}" aria-label="${esc(book.title)} löschen" title="Entfernen">${icon('trash',16)}</button>
    </article>`).join('');
  return `<div class="library-page">
    <header class="library-header"><div class="shell header-row">
      <div class="brand"><span class="brand-symbol">B</span><span>BLATTWERK<span class="brand-period">.</span></span></div>
      <button class="btn btn-primary" data-action="import">${icon('plus',18)} <span>PDF hinzufügen</span></button>
    </div></header>
    <main class="shell library-main">
      <div class="library-heading"><div class="library-title-wrap"><div class="section-kicker">SAMMLUNG <span class="kicker-line"></span> ${String(state.books.length).padStart(2, '0')} DATEIEN</div><h1>Bibliothek<span class="title-period">.</span></h1></div>
        ${state.books.length ? `<label class="search-field">${icon('search',18)}<input type="search" id="library-search" placeholder="Suchen" value="${esc(state.search)}" aria-label="Bücher suchen"></label>` : ''}
      </div>
      ${state.books.length && filtered.length ? `<section class="shelf-grid" aria-label="Bücher">${cards}</section>` : state.books.length ? `<div class="empty-shelf"><div class="empty-icon">${icon('search',25)}</div><h2>Keine Treffer</h2><button class="btn btn-secondary" data-action="clear-search">Suche löschen</button></div>` : `
      <div class="empty-shelf"><div class="empty-icon">${icon('file',32)}</div><h2>Keine PDFs</h2><button class="btn btn-secondary" data-action="import">${icon('plus',18)} PDF hinzufügen</button></div>`}
    </main>
    <div class="library-end">${icon('lock',13)} Lokal gespeichert</div>
    ${state.importing ? `<div class="modal-backdrop"><div class="modal progress-modal" role="status"><span class="loading-wheel"></span><h2>PDF wird importiert</h2></div></div>` : ''}
  </div>`;
}

function renderHighlightedBlock(block, highlights) {
  const points = new Set([block.start,block.end]);
  for (const mark of highlights) {
    if (mark.start < block.end && mark.end > block.start) {
      points.add(Math.max(block.start, mark.start)); points.add(Math.min(block.end, mark.end));
    }
  }
  const sorted = [...points].sort((a,b)=>a-b);
  let result = '';
  for (let i=0; i<sorted.length-1; i++) {
    const start=sorted[i], end=sorted[i+1];
    if (start>=end) continue;
    const value = esc(block.text.slice(start-block.start,end-block.start));
    const covering = [...highlights].reverse().find(mark => mark.start <= start && mark.end >= end);
    result += covering ? `<mark data-hid="${esc(covering.id)}" data-color="${esc(covering.color)}" title="Markierung anklicken, um eine Notiz zu schreiben">${value}</mark>` : value;
  }
  return `<${block.type==='heading'?'h3':'p'}>${result}</${block.type==='heading'?'h3':'p'}>`;
}
function renderPaper() {
  const book = bookNow();
  if (state.loadingPage || state.opening) return `<div class="book-paper ${state.paper==='white'?'white':'night'}"><div class="paper-empty"><span class="loading-wheel"></span><span>Seite wird geladen</span></div></div>`;
  const marks = (book.highlights||[]).filter(h => h.page===state.page);
  const body = state.blocks.length ? state.blocks.map(block => renderHighlightedBlock(block,marks)).join('') : `<div class="paper-empty">${icon('file',30)}<strong>Kein Text erkannt</strong><span>Diese Seite könnte ein Scan sein.</span><button data-action="mode-pdf" class="btn btn-secondary">PDF anzeigen</button></div>`;
  return `<div class="book-paper ${state.paper==='white'?'white':'night'}" id="paper-scroll" data-page="${state.page}"><div class="paper-content"><article class="book-text" id="book-text" style="--reader-font-size:${state.fontSize}px">${body}</article></div></div>`;
}

function renderSettings() {
  return `<div class="settings-menu" role="dialog" aria-label="Leseeinstellungen">
    <div class="settings-title">Darstellung</div>
    <div class="settings-label">Schriftgröße</div>
    <div class="size-row"><button data-action="font-down" aria-label="Schrift verkleinern">${icon('minus',16)}</button><span>${state.fontSize} px</span><button data-action="font-up" aria-label="Schrift vergrößern">${icon('plus',16)}</button></div>
    <div class="settings-label">Lesemodus</div><div class="appearance-row"><button class="${state.paper==='dark'?'selected':''}" data-action="paper-theme" data-value="dark" aria-pressed="${state.paper==='dark'}">Dunkel</button><button class="${state.paper==='white'?'selected':''}" data-action="paper-theme" data-value="white" aria-pressed="${state.paper==='white'}">Hell</button></div>
  </div>`;
}

function displayedNotes() {
  const book=bookNow();
  const notes=(book.notes||[]).filter(note => state.noteFilter==='all' || note.page===state.page);
  const orphans=(book.highlights||[]).filter(mark=> (state.noteFilter==='all'||mark.page===state.page) && !(book.notes||[]).some(note=>note.highlightId===mark.id))
    .map(mark=>({id:`mark:${mark.id}`,page:mark.page,quote:mark.quote,body:'',isMark:true,highlightId:mark.id,createdAt:mark.createdAt}));
  return [...notes,...orphans].sort((a,b)=>(b.createdAt||0)-(a.createdAt||0));
}
function renderNoteEditor() {
  const n=state.editingNote;
  if(!n)return '';
  return `<div class="note-editor"><div class="editor-title">${n.id==='new'?'Neue Notiz':'Notiz bearbeiten'} <span>· Seite ${n.page+1}</span></div>
    ${n.quote?`<div class="note-editor-quote">${esc(n.quote.slice(0,220))}${n.quote.length>220?'…':''}</div>`:''}
    <textarea id="note-draft" placeholder="Notiz schreiben …" aria-label="Notiztext">${esc(n.body||'')}</textarea>
    <div class="note-editor-actions"><button class="btn btn-quiet" data-action="cancel-note">Abbrechen</button><button class="btn btn-primary" data-action="save-note">Speichern</button></div>
    ${(n.id!=='new'||n.highlightId)?`<div class="note-editor-bottom">${n.id!=='new'?`<button class="danger-link" data-action="remove-note" data-id="${esc(n.id)}">Notiz löschen</button>`:'<span></span>'}${n.highlightId?`<button class="danger-link" data-action="remove-highlight" data-id="${esc(n.highlightId)}">Markierung entfernen</button>`:''}</div>`:''}
  </div>`;
}

function renderNotesPanel() {
  const notes=displayedNotes();
  const book=bookNow();
  return `<aside class="note-panel" aria-label="Notizen"><div class="note-top"><div class="note-topline"><h2>Notizen <span class="notes-count">${(book.notes||[]).length}</span></h2><button class="icon-btn" data-action="toggle-notes" aria-label="Notizen schließen">${icon('close',19)}</button></div>
    <div class="note-tabs"><button data-action="notes-filter" data-value="page" class="${state.noteFilter==='page'?'selected':''}">Diese Seite</button><button data-action="notes-filter" data-value="all" class="${state.noteFilter==='all'?'selected':''}">Alle</button></div></div>
    <div class="note-body"><button class="note-new" data-action="new-note">${icon('plus',17)} Neue Notiz</button>${renderNoteEditor()}
      ${notes.length?notes.map(note=>`<button class="note-card" data-action="${note.isMark?'note-for-highlight':'edit-note'}" data-id="${esc(note.isMark?note.highlightId:note.id)}"><div class="note-card-head"><span>${note.isMark?'MARKIERUNG':'NOTIZ'}</span><span>SEITE ${note.page+1}</span></div>${note.quote?`<div class="note-quote">${esc(note.quote)}</div>`:''}${note.body?`<div class="note-preview">${esc(note.body)}</div>`:''}</button>`).join(''):`<div class="notes-empty">Keine Notizen</div>`}
    </div><div class="note-bottom"><span>${(book.highlights||[]).length} Markierungen</span><button data-action="export-notes">${icon('download',15)} Exportieren</button></div></aside>`;
}

function renderReader() {
  const book=bookNow();
  if(!book)return renderLibrary();
  const percent=progress({...book,lastPage:state.page});
  return `<div class="reader-app"><header class="reader-header"><div class="reader-header-left"><button class="reader-back" data-action="back-library" aria-label="Zur Bibliothek" title="Zur Bibliothek">${icon('left',19)} <span>Bibliothek</span></button></div>
    <div class="reader-header-center"><div class="reader-name" title="${esc(book.title)}">${esc(book.title)}</div></div>
    <div class="reader-header-right"><button class="header-pill ${state.noteOpen?'active':''}" data-action="toggle-notes" aria-pressed="${state.noteOpen}" title="Notizen öffnen">${icon('note',18)} <span>Notizen</span></button><button class="icon-btn download-btn" data-action="download-pdf" title="PDF herunterladen" aria-label="PDF herunterladen">${icon('download',19)}</button></div></header>
    <div class="reader-grid ${state.noteOpen?'with-notes':''}"><main class="reading-column">
      <div class="reading-toolbar"><div class="mode-picker"><button class="${state.mode==='book'?'selected':''}" data-action="mode-book" aria-pressed="${state.mode==='book'}">Buch</button><button class="${state.mode==='pdf'?'selected':''}" data-action="mode-pdf" aria-pressed="${state.mode==='pdf'}">Original-PDF</button></div>
      <div class="tool-group">${state.mode==='pdf'?`<button class="icon-btn" data-action="zoom-out" title="Verkleinern" aria-label="Verkleinern">${icon('minus',17)}</button><span class="zoom-label">${Math.round(state.zoom*100)}%</span><button class="icon-btn" data-action="zoom-in" title="Vergrößern" aria-label="Vergrößern">${icon('plus',17)}</button>`:''}<div class="settings-wrap"><button class="icon-btn ${state.settingsOpen?'active':''}" data-action="settings" title="Darstellung" aria-label="Darstellung">${icon('settings',19)}</button>${state.settingsOpen?renderSettings():''}</div></div></div>
      <div class="book-stage"><button class="stage-arrow left" data-action="prev-page" aria-label="Vorherige Seite" ${state.page<=0?'disabled':''}>${icon('left',25)}</button><div class="page-wrapper">${state.mode==='book'?renderPaper():`<div class="original-wrap" id="original-wrap"><div class="original-loading"><span class="loading-wheel"></span></div><canvas id="pdf-canvas" class="hidden"></canvas></div>`}</div><button class="stage-arrow right" data-action="next-page" aria-label="Nächste Seite" ${state.page>=book.pageCount-1?'disabled':''}>${icon('right',25)}</button></div>
      <footer class="reader-footer"><div class="pager"><button data-action="prev-page" aria-label="Vorherige Seite" ${state.page<=0?'disabled':''}>${icon('left',18)}</button><span class="page-label"><input class="page-number-input" id="page-number" type="number" min="1" max="${book.pageCount}" value="${state.page+1}" aria-label="Seitenzahl"> <span class="page-of">/ ${book.pageCount}</span></span><button data-action="next-page" aria-label="Nächste Seite" ${state.page>=book.pageCount-1?'disabled':''}>${icon('right',18)}</button></div><div class="reading-progress"><div class="progress-track"><span style="width:${percent}%"></span></div><span class="progress-number">${percent}%</span></div></footer>
    </main>${state.noteOpen?renderNotesPanel():''}</div></div>
    ${state.noteOpen?'<div class="mobile-note-backdrop" data-action="toggle-notes"></div>':''}`;
}

function renderModal() {
  if (!state.modal) return '';
  const book=state.books.find(b=>b.id===state.modal.id);
  return `<div class="modal-backdrop"><div class="modal" role="dialog" aria-modal="true" aria-label="PDF löschen"><button class="icon-btn close-x" data-action="close-modal" aria-label="Schließen">${icon('close',19)}</button><h2>PDF löschen?</h2><p>„${esc(book?.title||'Dieses PDF')}“ und alle Notizen werden dauerhaft gelöscht.</p><div class="modal-actions"><button class="btn btn-secondary" data-action="close-modal">Abbrechen</button><button class="btn btn-primary" data-action="delete-book" data-id="${esc(book?.id||'')}">Löschen</button></div></div></div>`;
}

function render() {
  // Opening the notes sidebar or changing type settings should not lose
  // the reader's scroll position on the current page.
  const oldPaper = $('#paper-scroll');
  const scrollSnapshot = oldPaper ? { page: oldPaper.dataset.page, top: oldPaper.scrollTop } : null;
  removeSelectionToolbar();
  app.innerHTML = (state.currentId?renderReader():renderLibrary()) + renderModal();
  const newPaper = $('#paper-scroll');
  if (scrollSnapshot && newPaper && newPaper.dataset.page === scrollSnapshot.page)
    newPaper.scrollTop = scrollSnapshot.top;
  if (state.currentId && state.mode==='pdf' && state.doc && !state.opening) requestAnimationFrame(drawOriginal);
}

async function openBook(id) {
  const book=state.books.find(b=>b.id===id); if (!book) return;
  state.readerVersion++; const token=state.readerVersion;
  const oldDoc=state.doc; state.doc=null; if(oldDoc) oldDoc.destroy().catch(()=>{});
  state.currentId=id; state.page=Math.min(book.pageCount-1,book.lastPage||0); state.mode=book.mode||'book';
  state.noteOpen=false;state.settingsOpen=false;state.editingNote=null;state.pageCache=new Map();state.blocks=[];state.opening=true; state.zoom=1;
  updateBook(id,{lastOpened:Date.now()}); render();
  try {
    const doc=await loadDocument(book.file);
    if (state.readerVersion!==token) { doc.destroy().catch(()=>{}); return; }
    state.doc=doc;state.opening=false; await showPage(state.page, false);
  } catch (error) {
    console.error(error);toast('PDF konnte nicht geöffnet werden. Bitte prüfe die Datei und die Internetverbindung.',true);
    state.currentId=null;state.opening=false;render();
  }
}
function backToLibrary() {
  state.readerVersion++;state.pageVersion++;
  const doc=state.doc;state.doc=null;if(doc)doc.destroy().catch(()=>{});
  state.currentId=null;state.noteOpen=false;state.editingNote=null;state.settingsOpen=false;state.selectedText=null;render();
}
async function showPage(page, shouldSave=true) {
  const book=bookNow();if (!book) return;
  const target=Math.max(0,Math.min(book.pageCount-1,page));
  state.page=target;state.settingsOpen=false;state.selectedText=null;
  if(shouldSave)updateBook(book.id,{lastPage:target});
  const token=++state.pageVersion;
  if(state.mode==='book' && state.doc) {
    const cached=state.pageCache.get(target);
    if(cached) {state.blocks=cached;state.loadingPage=false;render();return;}
    state.loadingPage=true;state.blocks=[];render();
    try {
      const blocks=await extractPage(state.doc,target+1);
      if(token!==state.pageVersion||!state.currentId)return;
      state.pageCache.set(target,blocks);state.blocks=blocks;state.loadingPage=false;render();
    } catch (error) {console.error(error);state.loadingPage=false;state.blocks=[];render();toast('Text auf dieser Seite konnte nicht geladen werden.',true);}
  } else {state.loadingPage=false;render();}
}
async function setMode(mode) {
  if(!bookNow()||state.mode===mode)return;
  state.mode=mode;state.zoom=1;state.settingsOpen=false;updateBook(state.currentId,{mode});await showPage(state.page,false);
}
let canvasDrawing=0;
async function drawOriginal() {
  const canvas=$('#pdf-canvas');const wrapper=$('#original-wrap');
  if (!canvas||!wrapper||!state.doc) return;
  const token=++canvasDrawing;
  try {
    const width=Math.max(240,wrapper.clientWidth-64);
    await renderPDFPage(state.doc,state.page+1,canvas,width,state.zoom);
    if(token===canvasDrawing && canvas.isConnected){canvas.classList.remove('hidden');wrapper.querySelector('.original-loading')?.remove();}
  } catch(error) {console.error(error);if(wrapper.isConnected)wrapper.innerHTML='<div class="original-loading">PDF-Seite konnte nicht angezeigt werden.</div>';}
}

function startNewNote(options={}) {
  const page=options.page??state.page;
  state.noteOpen=true;state.settingsOpen=false;
  state.editingNote={id:'new',page,body:'',quote:options.quote||'',highlightId:options.highlightId||null,createdAt:Date.now()};
  render();requestAnimationFrame(()=>$('#note-draft')?.focus());
}
function editNote(id) {
  const note=(bookNow()?.notes||[]).find(n=>n.id===id);
  if(!note)return;
  state.noteOpen=true;state.editingNote={...note};render();requestAnimationFrame(()=>$('#note-draft')?.focus());
}
function noteForHighlight(id) {
  const book=bookNow(); if(!book)return;
  const note=(book.notes||[]).find(n=>n.highlightId===id);
  if(note) return editNote(note.id);
  const mark=(book.highlights||[]).find(h=>h.id===id);
  if(mark) startNewNote({page:mark.page,quote:mark.quote,highlightId:mark.id});
}
function saveNote() {
  const book=bookNow(),draft=state.editingNote;if(!book||!draft)return;
  const content=$('#note-draft')?.value.trim()||'';
  if(!content){toast('Notiz ist leer',true);$('#note-draft')?.focus();return;}
  const note={...draft,id:draft.id==='new'?crypto.randomUUID():draft.id,body:content,updatedAt:Date.now()};
  const notes=[...(book.notes||[])];const index=notes.findIndex(n=>n.id===note.id);
  if(index>=0)notes[index]=note; else notes.push(note);
  updateBook(book.id,{notes});state.editingNote=null;render();toast('Notiz gespeichert');
}
function removeNote(id) {
  const book=bookNow();if(!book)return;
  updateBook(book.id,{notes:(book.notes||[]).filter(n=>n.id!==id)});
  state.editingNote=null;render();toast('Notiz entfernt.');
}
function removeHighlight(id) {
  const book=bookNow();if(!book)return;
  updateBook(book.id,{highlights:(book.highlights||[]).filter(h=>h.id!==id),notes:(book.notes||[]).map(n=>n.highlightId===id?{...n,highlightId:null}:n)});
  if(state.editingNote)state.editingNote.highlightId=null;
  render();toast('Markierung entfernt.');
}
function removeSelectionToolbar() {$('#selection-toolbar')?.remove();}
function captureSelection() {
  const root=$('#book-text');
  if(!root || state.mode!=='book'||state.loadingPage)return;
  const selection=window.getSelection();
  if(!selection||selection.isCollapsed||!selection.rangeCount)return;
  const range=selection.getRangeAt(0);
  if(!root.contains(range.startContainer)||!root.contains(range.endContainer))return;
  try {
    const pre=document.createRange();pre.selectNodeContents(root);pre.setEnd(range.startContainer,range.startOffset);
    const start=pre.cloneContents().textContent.length;
    pre.selectNodeContents(root);pre.setEnd(range.endContainer,range.endOffset);
    const end=pre.cloneContents().textContent.length;
    if(end<=start||end-start>3500)return;
    const quote=root.textContent.slice(start,end).trim();if(!quote)return;
    state.selectedText={page:state.page,start,end,quote};
    const rect=range.getBoundingClientRect();
    const popup=document.createElement('div');popup.id='selection-toolbar';
    const top = rect.top > 90?rect.top-11:rect.bottom+55;
    popup.style.left=`${Math.max(145,Math.min(window.innerWidth-145,rect.left+rect.width/2))}px`;
    popup.style.top=`${Math.max(60,Math.min(window.innerHeight-15,top))}px`;
    popup.innerHTML=`<button data-action="mark-text" data-color="gray">${icon('highlighter',16)} Markieren</button><span class="divider"></span><button data-action="mark-note">${icon('note',16)} Notiz</button>`;
    removeSelectionToolbar();document.body.appendChild(popup);
  } catch(error) {console.warn('Markierung nicht möglich',error);}
}
function markSelection(color,withNote=false) {
  const book=bookNow(),sel=state.selectedText;if(!book||!sel)return;
  const mark={id:crypto.randomUUID(),page:sel.page,start:sel.start,end:sel.end,color,quote:sel.quote,createdAt:Date.now()};
  updateBook(book.id,{highlights:[...(book.highlights||[]),mark]});
  window.getSelection()?.removeAllRanges();state.selectedText=null;removeSelectionToolbar();
  if(withNote)startNewNote({page:mark.page,quote:mark.quote,highlightId:mark.id});
  else {render();toast('Markiert');}
}
function exportNotes() {
  const book=bookNow();if(!book)return;
  const lines=[`# ${book.title}`, '', 'Notizen & Markierungen', ''];
  const entries=[...(book.notes||[])].sort((a,b)=>a.page-b.page);
  for(const note of entries){lines.push(`## Seite ${note.page+1}`);if(note.quote)lines.push(`> ${note.quote.replace(/\n/g,' ')}`,'');lines.push(note.body,'');}
  const unnoted=(book.highlights||[]).filter(h=>!entries.some(n=>n.highlightId===h.id));
  if(unnoted.length){lines.push('## Markierungen ohne Notiz','');for(const mark of unnoted)lines.push(`- Seite ${mark.page+1}: „${mark.quote.replace(/\n/g,' ')}“`);}
  if(!entries.length&&!unnoted.length){toast('Noch keine Notizen oder Markierungen vorhanden.');return;}
  downloadBlob(new Blob([lines.join('\n')],{type:'text/markdown;charset=utf-8'}),`${book.title}-Notizen.md`);
  toast('Notizen wurden exportiert.');
}
function downloadBlob(blob,name){const url=URL.createObjectURL(blob);const a=document.createElement('a');a.href=url;a.download=name;document.body.append(a);a.click();a.remove();setTimeout(()=>URL.revokeObjectURL(url),1500);}
async function importFiles(files) {
  const pdfFiles=[...files].filter(file => /\.pdf$/i.test(file.name)||file.type==='application/pdf');
  if(!pdfFiles.length){toast('Bitte wähle eine PDF-Datei aus.',true);return;}
  state.importing=true;render();let imported=0;
  for(const file of pdfFiles){
    let doc;
    try{
      doc=await loadDocument(file);
      const cover=await makeCover(doc);
      const book={id:crypto.randomUUID(),title:file.name.replace(/\.pdf$/i,'').replace(/[_-]/g,' ').trim()||'Unbenanntes Buch',file,pageCount:doc.numPages,cover,
        addedAt:Date.now(),lastOpened:null,lastPage:0,mode:'book',notes:[],highlights:[]};
      await putBook(book);state.books.push(book);imported++;
    }catch(error){console.error(error);toast(`„${file.name}“ konnte nicht importiert werden.`,true);}
    finally{try{await doc?.destroy();}catch{}}
  }
  state.importing=false;render();if(imported)toast(imported===1?'PDF ist in deiner Bibliothek.':`${imported} PDFs wurden importiert.`);
}
async function importSample() {
  try {const response=await fetch('./beispiel.pdf');if(!response.ok)throw new Error('Leseprobe fehlt');
    const file=new File([await response.blob()],'Zwischen den Seiten.pdf',{type:'application/pdf'});
    await importFiles([file]);
    const found=[...state.books].sort((a,b)=>b.addedAt-a.addedAt)[0];if(found?.title==='Zwischen den Seiten')await openBook(found.id);
  } catch(error){console.error(error);toast('Leseprobe konnte nicht geöffnet werden.',true);}
}
async function deleteBookConfirmed(id) {
  try{await (writeQueue.get(id)||Promise.resolve());await deleteBook(id);state.books=state.books.filter(book=>book.id!==id);state.modal=null;render();toast('Buch und Notizen entfernt.');}
  catch(error){console.error(error);toast('Buch konnte nicht gelöscht werden.',true);}
}

// Delegated events keep working after reader and library re-render.
document.addEventListener('click',async (event)=>{
  const target=event.target.closest('[data-action]');if(!target)return;
  const action=target.dataset.action;
  const id=target.dataset.id;
  if (action!=='mark-text' && action!=='mark-note' && !target.closest('#selection-toolbar')) removeSelectionToolbar();
  switch(action){
    case 'import':fileInput.click();break;
    case 'sample':await importSample();break;
    case 'clear-search':state.search='';render();break;
    case 'close-modal':state.modal=null;render();break;
    case 'open-book':await openBook(id);break;
    case 'confirm-delete':state.modal={type:'delete-book',id};render();break;
    case 'delete-book':await deleteBookConfirmed(id);break;
    case 'back-library':backToLibrary();break;
    case 'mode-book':await setMode('book');break;
    case 'mode-pdf':await setMode('pdf');break;
    case 'next-page':await showPage(state.page+1);break;
    case 'prev-page':await showPage(state.page-1);break;
    case 'settings':state.settingsOpen=!state.settingsOpen;render();break;
    case 'font-down':state.fontSize=Math.max(13,state.fontSize-1);persistPreferences();render();break;
    case 'font-up':state.fontSize=Math.min(29,state.fontSize+1);persistPreferences();render();break;
    case 'paper-theme':state.paper=target.dataset.value;persistPreferences();render();break;
    case 'zoom-in':state.zoom=Math.min(2.5,Math.round((state.zoom+.15)*100)/100);render();break;
    case 'zoom-out':state.zoom=Math.max(.5,Math.round((state.zoom-.15)*100)/100);render();break;
    case 'toggle-notes':state.noteOpen=!state.noteOpen;state.editingNote=null;render();break;
    case 'notes-filter':state.noteFilter=target.dataset.value;render();break;
    case 'new-note':startNewNote();break;
    case 'edit-note':editNote(id);break;
    case 'note-for-highlight':noteForHighlight(id);break;
    case 'cancel-note':state.editingNote=null;render();break;
    case 'save-note':saveNote();break;
    case 'remove-note':removeNote(id);break;
    case 'remove-highlight':removeHighlight(id);break;
    case 'export-notes':exportNotes();break;
    case 'download-pdf':{const book=bookNow();if(book)downloadBlob(book.file,`${book.title}.pdf`);break;}
    case 'mark-text':markSelection(target.dataset.color||'green');break;
    case 'mark-note':markSelection('gray',true);break;
  }
});
document.addEventListener('click',(event)=>{
  const target=event.target.closest('mark[data-hid]');
  if(target&&bookNow()){event.preventDefault();noteForHighlight(target.dataset.hid);}
});
document.addEventListener('change',(event)=>{
  if(event.target.id==='page-number'){const page=Number(event.target.value);if(Number.isInteger(page)&&page>=1&&page<=(bookNow()?.pageCount||0))showPage(page-1);else render();}
});
document.addEventListener('input',(event)=>{
  if(event.target.id==='library-search'){
    const pos=event.target.selectionStart;
    state.search=event.target.value;render();const el=$('#library-search');el?.focus();if(el)el.setSelectionRange(pos,pos);
  }
});
fileInput.addEventListener('change',async(event)=>{const files=[...event.target.files];fileInput.value='';await importFiles(files);});
document.addEventListener('mouseup',(event)=>{if(event.target.closest('#book-text'))setTimeout(captureSelection,0);});
document.addEventListener('keyup',(event)=>{if((event.shiftKey||event.key==='Shift')&&$('#book-text'))setTimeout(captureSelection,0);});
let mobileSelectionTimer;
document.addEventListener('selectionchange', () => {
  if (!state.currentId || state.mode !== 'book') return;
  clearTimeout(mobileSelectionTimer);
  mobileSelectionTimer = setTimeout(captureSelection, 260);
});
document.addEventListener('keydown',(event)=>{
  const element=document.activeElement;
  const isInput=element&&(['INPUT','TEXTAREA'].includes(element.tagName)||element.isContentEditable);
  if(event.key==='Escape'){
    if(state.modal){state.modal=null;render();return;}
    if(state.editingNote){state.editingNote=null;render();return;}
    removeSelectionToolbar();window.getSelection()?.removeAllRanges();return;
  }
  if(isInput || !bookNow() || state.modal || event.altKey || event.metaKey || event.ctrlKey || window.getSelection()?.toString())return;
  if(event.key==='ArrowRight'){event.preventDefault();showPage(state.page+1);}
  if(event.key==='ArrowLeft'){event.preventDefault();showPage(state.page-1);}
});
let dragDepth=0;
window.addEventListener('dragenter',event=>{if(![...event.dataTransfer?.types||[]].includes('Files'))return;event.preventDefault();dragDepth++;if(!$('#drop-overlay'))document.body.insertAdjacentHTML('beforeend',`<div class="drop-screen" id="drop-overlay"><div class="drop-card">${icon('upload',44)}<h3>PDF hinzufügen</h3></div></div>`);});
window.addEventListener('dragover',event=>{if([...event.dataTransfer?.types||[]].includes('Files'))event.preventDefault();});
window.addEventListener('dragleave',event=>{event.preventDefault();dragDepth=Math.max(0,dragDepth-1);if(!dragDepth)$('#drop-overlay')?.remove();});
window.addEventListener('drop',async event=>{event.preventDefault();dragDepth=0;$('#drop-overlay')?.remove();if(event.dataTransfer?.files?.length)await importFiles(event.dataTransfer.files);});
window.addEventListener('blur',()=>{dragDepth=0;$('#drop-overlay')?.remove();});
let resizeTimer;
window.addEventListener('resize',()=>{if(state.mode==='pdf'&&bookNow()){clearTimeout(resizeTimer);resizeTimer=setTimeout(()=>render(),180);}});

async function initialize(){
  try{state.books=await getBooks();}
  catch(error){console.error(error);toast('Der Browser blockiert die lokale Bibliothek. Prüfe den Privatmodus.',true);}
  render();
}
initialize();

if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('./sw.js').catch(error => console.warn('Offline-Speicher nicht aktiv:', error));
  });
}
