/**
 * Attachments on a voucher — the naming, sizing and safety rules, with no filesystem in sight.
 *
 * The decision this file encodes, and the reason for it:
 *
 * An attachment is **copied into the company folder**, never referenced where the user picked it
 * from. A reference is a path, and a path is a promise about somebody else's filesystem: it
 * breaks when Downloads is emptied, when a folder is renamed, when the books are restored onto a
 * new machine, and — worst — it breaks silently, so the app goes on listing a bill that is no
 * longer anywhere. Copying costs disk twice for every scan. That is the price of `~/Documents/
 * total/<company>/` being the whole of a user's data, which is the promise everything else in
 * this app makes (backups, sync, "no cloud, no accounts").
 *
 * The cap exists for the same reason: a 40 MB phone photograph of a ₹900 diesel bill would be
 * copied in full into a folder the user backs up. It is stated in the UI up front rather than
 * discovered as a failure after a slow copy.
 */

/** Largest file accepted, in bytes. A scan of an A4 bill is ~200 KB; a phone photo 2–6 MB. */
export const ATTACHMENT_MAX_BYTES = 10 * 1024 * 1024

/** Most attachments a single voucher may carry. A bill, its challan, its e-way copy, the
 *  transporter's LR — more than this is a filing cabinet, not a voucher. */
export const ATTACHMENT_MAX_PER_VOUCHER = 20

/**
 * Extensions accepted. Deliberately a small allowlist of things a bill is actually scanned or
 * photographed into, plus the spreadsheet a supplier occasionally sends instead.
 *
 * The safety point is the one that matters more than the tidiness point: the app opens these
 * with the OS handler (shell.openPath), so accepting `.command`, `.app` or `.exe` would turn
 * "open the bill" into "run whatever was in the drop folder".
 */
export const ATTACHMENT_EXTENSIONS = [
  'pdf', 'jpg', 'jpeg', 'png', 'heic', 'webp', 'gif', 'tif', 'tiff', 'txt', 'csv', 'xml'
] as const

export type AttachmentExtension = (typeof ATTACHMENT_EXTENSIONS)[number]

/** Human sentence for the limits, used verbatim in the UI so the rule is stated before it bites. */
export const ATTACHMENT_LIMIT_HINT = `PDF or image, up to ${ATTACHMENT_MAX_BYTES / (1024 * 1024)} MB, ${ATTACHMENT_MAX_PER_VOUCHER} per voucher`

/** Lowercased extension without the dot, or '' when the name has none. */
export function extensionOf(fileName: string): string {
  const base = fileName.slice(fileName.lastIndexOf('/') + 1)
  const dot = base.lastIndexOf('.')
  if (dot <= 0 || dot === base.length - 1) return ''
  return base.slice(dot + 1).toLowerCase()
}

export function isAllowedAttachment(fileName: string): boolean {
  return (ATTACHMENT_EXTENSIONS as readonly string[]).includes(extensionOf(fileName))
}

/**
 * Strip a user-supplied filename down to something that can only ever name a file inside the
 * attachments folder: no separators, no traversal, no leading dot, no control characters.
 * A name that reduces to nothing becomes 'attachment'.
 */
export function safeFileName(fileName: string): string {
  const base = fileName.split(/[\\/]/).pop() ?? ''
  const cleaned = base
    // Control characters go first: they can make a directory listing lie about what a file
    // is called, and they have no business in a name a user typed.
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .replace(/[^A-Za-z0-9._ -]/g, '_')
    .replace(/^\.+/, '')
    .trim()
    .slice(0, 80)
  return cleaned || 'attachment'
}

/**
 * The name the copy is given on disk: `<voucherId>-<token>-<safe original>`.
 *
 * The voucher id leads so a human looking in the folder without the app can still tell what a
 * file belongs to — the folder has to remain readable on its own, because the whole point of
 * copying the file in is that it survives the app. The random token keeps two scans called
 * `bill.pdf` from colliding.
 */
export function storedNameFor(voucherId: number, token: string, fileName: string): string {
  const safeToken = token.replace(/[^A-Za-z0-9]/g, '').slice(0, 12) || '0'
  return `${voucherId}-${safeToken}-${safeFileName(fileName)}`
}

export type AttachmentRejection =
  | { ok: true }
  | { ok: false; reason: 'type' | 'size' | 'count'; message: string }

/** Everything that can refuse an attachment, answered before a byte is copied. */
export function checkAttachment(input: {
  fileName: string
  byteSize: number
  existingCount: number
}): AttachmentRejection {
  if (!isAllowedAttachment(input.fileName)) {
    return {
      ok: false,
      reason: 'type',
      message: `Total keeps ${ATTACHMENT_EXTENSIONS.join(', ')} files. "${safeFileName(input.fileName)}" is not one of them.`
    }
  }
  if (input.byteSize <= 0) {
    return { ok: false, reason: 'size', message: 'That file is empty.' }
  }
  if (input.byteSize > ATTACHMENT_MAX_BYTES) {
    return {
      ok: false,
      reason: 'size',
      message: `That file is ${formatBytes(input.byteSize)}. The limit is ${formatBytes(ATTACHMENT_MAX_BYTES)} — scan it at a lower resolution, or attach a PDF instead of a photograph.`
    }
  }
  if (input.existingCount >= ATTACHMENT_MAX_PER_VOUCHER) {
    return {
      ok: false,
      reason: 'count',
      message: `This voucher already has ${ATTACHMENT_MAX_PER_VOUCHER} attachments.`
    }
  }
  return { ok: true }
}

/** Sizes for people: 964 B, 1.2 MB. Not money, so a float is fine here. */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  const kb = bytes / 1024
  if (kb < 1024) return `${kb < 10 ? kb.toFixed(1) : Math.round(kb)} KB`
  const mb = kb / 1024
  return `${mb < 10 ? mb.toFixed(1) : Math.round(mb)} MB`
}
