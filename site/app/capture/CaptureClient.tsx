'use client'

import { useEffect, useRef, useState } from 'react'

type Capture = { id: string; name: string; kind: 'receipt' | 'invoice'; createdAt: string; blob: Blob }
const DB_NAME = 'total-local-capture'
const STORE = 'captures'

function database(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 1)
    request.onupgradeneeded = () => request.result.createObjectStore(STORE, { keyPath: 'id' })
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error)
  })
}
async function readAll(): Promise<Capture[]> {
  const db = await database()
  return new Promise((resolve, reject) => {
    const request = db.transaction(STORE).objectStore(STORE).getAll()
    request.onsuccess = () => resolve((request.result as Capture[]).sort((a, b) => b.createdAt.localeCompare(a.createdAt)))
    request.onerror = () => reject(request.error)
  })
}
async function put(row: Capture): Promise<void> {
  const db = await database()
  await new Promise<void>((resolve, reject) => { const request = db.transaction(STORE, 'readwrite').objectStore(STORE).put(row); request.onsuccess = () => resolve(); request.onerror = () => reject(request.error) })
}
async function remove(id: string): Promise<void> {
  const db = await database()
  await new Promise<void>((resolve, reject) => { const request = db.transaction(STORE, 'readwrite').objectStore(STORE).delete(id); request.onsuccess = () => resolve(); request.onerror = () => reject(request.error) })
}
const safeName = (value: string): string => value.trim().replace(/[^a-zA-Z0-9_-]+/g, '-').replace(/^-|-$/g, '').slice(0, 48) || 'document'

export default function CaptureClient(): React.JSX.Element {
  const [rows, setRows] = useState<Capture[]>([])
  const [kind, setKind] = useState<Capture['kind']>('receipt')
  const [label, setLabel] = useState('')
  const [message, setMessage] = useState('')
  const input = useRef<HTMLInputElement>(null)
  useEffect(() => { void readAll().then(setRows).catch(() => setMessage('Local capture storage is unavailable in this browser.')) }, [])
  const add = async (files: FileList | null): Promise<void> => {
    if (!files?.length) return
    const now = new Date()
    for (const [index, file] of [...files].entries()) {
      if (!file.type.startsWith('image/')) continue
      const extension = file.type.includes('png') ? 'png' : 'jpg'
      const row: Capture = { id: crypto.randomUUID(), kind, createdAt: new Date(now.getTime() + index).toISOString(), name: `${kind}-${safeName(label)}-${now.toISOString().slice(0, 10)}.${extension}`, blob: file }
      await put(row)
    }
    setRows(await readAll()); setLabel(''); if (input.current) input.current.value = ''; setMessage('Saved on this phone. Nothing was uploaded.')
  }
  const share = async (): Promise<void> => {
    const files = rows.map((row) => new File([row.blob], row.name, { type: row.blob.type || 'image/jpeg' }))
    if (!files.length) return
    if (navigator.share && (!navigator.canShare || navigator.canShare({ files }))) {
      await navigator.share({ title: 'Total receipt capture', text: 'Import these images in Total → Assist → Document inbox.', files })
      setMessage('Share sheet opened. Delete local copies after confirming import on the desktop.')
      return
    }
    for (const file of files) { const link = document.createElement('a'); link.href = URL.createObjectURL(file); link.download = file.name; link.click(); setTimeout(() => URL.revokeObjectURL(link.href), 1_000) }
    setMessage('Downloaded the queued images. Move them to the desktop and import them in Assist.')
  }
  const discard = async (id: string): Promise<void> => { await remove(id); setRows(await readAll()) }
  return <div className="capture-board"><div className="capture-compose"><div className="capture-switch" role="group" aria-label="Document type"><button className={kind === 'receipt' ? 'active' : ''} onClick={() => setKind('receipt')}>Receipt</button><button className={kind === 'invoice' ? 'active' : ''} onClick={() => setKind('invoice')}>Supplier invoice</button></div><label>Optional label<input value={label} maxLength={48} onChange={(event) => setLabel(event.target.value)} placeholder="Taxi, hotel, vendor…" /></label><input ref={input} className="capture-file" type="file" accept="image/*" capture="environment" multiple onChange={(event) => void add(event.target.files)} /><button className="btn capture-button" onClick={() => input.current?.click()}>Open camera or photos</button><p className="support-privacy">Images are stored in this browser’s private local storage. This page has no upload action.</p>{message && <p className="capture-message" role="status">{message}</p>}</div><div className="capture-queue"><div className="capture-queue-head"><div><p className="eyebrow">Local queue</p><h2 className="serif">{rows.length} document{rows.length === 1 ? '' : 's'}</h2></div><button className="btn small" disabled={!rows.length} onClick={() => void share()}>Share to desktop</button></div>{!rows.length ? <p className="capture-empty">Photograph a receipt or choose an existing image. It will stay here until you share or delete it.</p> : <div className="capture-grid">{rows.map((row) => <CaptureCard key={row.id} row={row} onDelete={discard} />)}</div>}</div></div>
}

function CaptureCard({ row, onDelete }: { row: Capture; onDelete: (id: string) => Promise<void> }): React.JSX.Element {
  const [url, setUrl] = useState('')
  useEffect(() => { const next = URL.createObjectURL(row.blob); setUrl(next); return () => URL.revokeObjectURL(next) }, [row.blob])
  return <article className="capture-card">{url && <img src={url} alt="Captured accounting document" />}<div><b>{row.kind === 'receipt' ? 'Receipt' : 'Supplier invoice'}</b><span>{new Date(row.createdAt).toLocaleString()}</span><button onClick={() => void onDelete(row.id)}>Delete from phone</button></div></article>
}
