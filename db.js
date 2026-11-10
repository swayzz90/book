const DB_NAME = 'blattwerk-reader-db';
const DB_VERSION = 1;
const STORE = 'books';

function openDatabase() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains(STORE))
        request.result.createObjectStore(STORE, { keyPath: 'id' });
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function perform(mode, operation) {
  const db = await openDatabase();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, mode);
    const request = operation(tx.objectStore(STORE));
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
    tx.oncomplete = () => db.close();
    tx.onerror = () => { db.close(); reject(tx.error); };
    tx.onabort = () => db.close();
  });
}

export const getBooks = () => perform('readonly', (store) => store.getAll());
export const putBook = (book) => perform('readwrite', (store) => store.put(book));
export const deleteBook = (id) => perform('readwrite', (store) => store.delete(id));
