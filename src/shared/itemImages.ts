/**
 * Item images (roadmap E #119) — the naming, sizing and safety rules, with no filesystem in sight.
 *
 * The same decision as `attachments.ts`, for the same reason, and reusing the same machinery:
 * the picture is COPIED into the company folder and referenced by a name this module generates,
 * never by the path the user picked it from. A path is a promise about somebody else's disk; it
 * breaks when Downloads is emptied, and it breaks silently.
 *
 * What differs from an attachment, and why this is its own module rather than a fourth kind of
 * `voucher_attachments` row:
 *
 * - An attachment is EVIDENCE and belongs to a voucher. An item image is a MASTER-DATA field and
 *   belongs to an item. They have different owners, different lifetimes and different reasons to
 *   be deleted; a shared table would need a nullable voucher_id, which is how the "one attachment
 *   with no voucher" bug gets written.
 * - There is exactly ONE image per item. A picker showing four pictures of the same bolt is not
 *   more useful than one; it is a picker with a scroll bar.
 * - The cap is far smaller. An attachment may be a 10 MB scan because it is a legal document. An
 *   item image is a thumbnail in a picker and a 40×40 square on an invoice; a 10 MB photograph
 *   used that way is 10 MB the user backs up every night to draw a postage stamp.
 * - Only formats a browser can actually paint. HEIC is on the attachment list because a phone
 *   produces it and the OS can open it — but Chromium will not render it in an <img>, so an item
 *   image in HEIC would be a picture that exists, backs up, and shows as a broken square.
 */

import { extensionOf, formatBytes, safeFileName } from './attachments'

/** Formats Chromium will paint. Deliberately narrower than the attachment list — see above. */
export const ITEM_IMAGE_EXTENSIONS = ['jpg', 'jpeg', 'png', 'webp', 'gif'] as const

/** Largest picture accepted. A 1000 px product shot at reasonable quality is 100–300 KB. */
export const ITEM_IMAGE_MAX_BYTES = 2 * 1024 * 1024

/** Stated in the UI before the file is chosen, so the rule is known before it bites. */
export const ITEM_IMAGE_HINT = `JPG, PNG, WebP or GIF, up to ${ITEM_IMAGE_MAX_BYTES / (1024 * 1024)} MB`

export function isAllowedItemImage(fileName: string): boolean {
  return (ITEM_IMAGE_EXTENSIONS as readonly string[]).includes(extensionOf(fileName))
}

export type ItemImageRejection = { ok: true } | { ok: false; reason: 'type' | 'size'; message: string }

/** Everything that can refuse a picture, answered before a byte is copied. */
export function checkItemImage(input: { fileName: string; byteSize: number }): ItemImageRejection {
  if (!isAllowedItemImage(input.fileName)) {
    return {
      ok: false,
      reason: 'type',
      message: `An item picture is a ${ITEM_IMAGE_EXTENSIONS.join(', ')} file. "${safeFileName(input.fileName)}" is not one of them.`
    }
  }
  if (input.byteSize <= 0) return { ok: false, reason: 'size', message: 'That file is empty.' }
  if (input.byteSize > ITEM_IMAGE_MAX_BYTES) {
    return {
      ok: false,
      reason: 'size',
      message: `That picture is ${formatBytes(input.byteSize)}. The limit is ${formatBytes(ITEM_IMAGE_MAX_BYTES)} — it is drawn at thumbnail size, so a smaller copy loses nothing.`
    }
  }
  return { ok: true }
}

/**
 * The name the copy is given on disk: `<itemId>-<token>-<safe original>`.
 *
 * Same shape as an attachment's stored name and for the same reason — the folder has to stay
 * readable by a human who does not have the app, because the whole point of copying the file in is
 * that it outlives the app. The token makes replacing an image atomic from the reader's side: the
 * new file is written under a new name and the row is pointed at it, so nothing ever reads a
 * half-written picture at a name that used to be a good one.
 */
export function storedImageNameFor(itemId: number, token: string, fileName: string): string {
  const safeToken = token.replace(/[^A-Za-z0-9]/g, '').slice(0, 12) || '0'
  return `${itemId}-${safeToken}-${safeFileName(fileName)}`
}

/** The MIME type for a data URL, from the extension. The renderer gets bytes over IPC and has to
 *  say what they are; guessing `image/*` gives Chromium nothing to decode with. */
export function itemImageMime(fileName: string): string {
  switch (extensionOf(fileName)) {
    case 'png':
      return 'image/png'
    case 'webp':
      return 'image/webp'
    case 'gif':
      return 'image/gif'
    default:
      return 'image/jpeg'
  }
}
