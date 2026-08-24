import { closeSync, fsyncSync, openSync, renameSync, rmSync, writeFileSync } from 'fs'
import { dirname } from 'path'

/** Crash-safe same-directory file replacement. Data reaches the temporary file, is fsynced,
 *  then atomically renamed over the destination. The parent directory is fsynced where the OS
 *  supports directory handles, making the rename durable across sudden power loss. */
export function atomicWriteFile(path: string, data: string | Buffer, mode = 0o600): void {
  const temporary = `${path}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`
  let handle: number | null = null
  try {
    handle = openSync(temporary, 'wx', mode)
    writeFileSync(handle, data)
    fsyncSync(handle)
    closeSync(handle)
    handle = null
    renameSync(temporary, path)

    // POSIX permits fsync on a directory; Windows may not. The file data + atomic rename are
    // still safe there, and the directory sync remains a best-effort durability enhancement.
    let directoryHandle: number | null = null
    try {
      directoryHandle = openSync(dirname(path), 'r')
      fsyncSync(directoryHandle)
    } catch {
      // Unsupported by this filesystem/platform.
    } finally {
      if (directoryHandle !== null) closeSync(directoryHandle)
    }
  } catch (error) {
    if (handle !== null) closeSync(handle)
    rmSync(temporary, { force: true })
    throw error
  }
}
