const EOCD_SIGNATURE = 0x06054b50;
const CENTRAL_SIGNATURE = 0x02014b50;
const MAX_EOCD_SEARCH = 65_557;

export interface XlsxContainerLimits {
  maxEntries?: number;
  maxUncompressedBytes?: number;
  maxEntryBytes?: number;
  maxCompressionRatio?: number;
}

/**
 * Inspect ZIP central-directory metadata before ExcelJS inflates an XLSX file.
 * ZIP64, split, encrypted, truncated and expansion-bomb containers are rejected.
 */
export function assertSafeXlsxContainer(
  buffer: Buffer,
  limits: XlsxContainerLimits = {},
): void {
  const maxEntries = limits.maxEntries ?? 10_000;
  const maxUncompressedBytes = limits.maxUncompressedBytes ?? 256 * 1024 * 1024;
  const maxEntryBytes = limits.maxEntryBytes ?? 64 * 1024 * 1024;
  const maxCompressionRatio = limits.maxCompressionRatio ?? 500;
  if (buffer.length < 22) throw new Error("The XLSX container is truncated");

  const searchStart = Math.max(0, buffer.length - MAX_EOCD_SEARCH);
  let eocd = -1;
  for (let offset = buffer.length - 22; offset >= searchStart; offset--) {
    if (buffer.readUInt32LE(offset) === EOCD_SIGNATURE) {
      const commentLength = buffer.readUInt16LE(offset + 20);
      if (offset + 22 + commentLength === buffer.length) {
        eocd = offset;
        break;
      }
    }
  }
  if (eocd < 0) throw new Error("The XLSX central directory is missing or malformed");

  const disk = buffer.readUInt16LE(eocd + 4);
  const directoryDisk = buffer.readUInt16LE(eocd + 6);
  const entriesOnDisk = buffer.readUInt16LE(eocd + 8);
  const entryCount = buffer.readUInt16LE(eocd + 10);
  const directorySize = buffer.readUInt32LE(eocd + 12);
  const directoryOffset = buffer.readUInt32LE(eocd + 16);
  if (disk !== 0 || directoryDisk !== 0 || entriesOnDisk !== entryCount)
    throw new Error("Split XLSX containers are not supported");
  if (entryCount === 0xffff || directorySize === 0xffffffff || directoryOffset === 0xffffffff)
    throw new Error("ZIP64 XLSX containers exceed the supported safety limits");
  if (entryCount === 0 || entryCount > maxEntries)
    throw new Error(`The XLSX container exceeds the ${maxEntries.toLocaleString("en-IN")} entry safety limit`);
  if (directoryOffset + directorySize !== eocd || directoryOffset > eocd)
    throw new Error("The XLSX central directory is inconsistent");

  let offset = directoryOffset;
  let totalCompressed = 0;
  let totalUncompressed = 0;
  for (let index = 0; index < entryCount; index++) {
    if (offset + 46 > eocd || buffer.readUInt32LE(offset) !== CENTRAL_SIGNATURE)
      throw new Error("The XLSX central directory contains a malformed entry");
    const flags = buffer.readUInt16LE(offset + 8);
    const compressed = buffer.readUInt32LE(offset + 20);
    const uncompressed = buffer.readUInt32LE(offset + 24);
    const fileNameLength = buffer.readUInt16LE(offset + 28);
    const extraLength = buffer.readUInt16LE(offset + 30);
    const commentLength = buffer.readUInt16LE(offset + 32);
    if ((flags & 0x1) !== 0) throw new Error("Encrypted XLSX containers are not supported");
    if (compressed === 0xffffffff || uncompressed === 0xffffffff)
      throw new Error("ZIP64 XLSX entries exceed the supported safety limits");
    if (uncompressed > maxEntryBytes)
      throw new Error("An XLSX entry exceeds the uncompressed size safety limit");
    totalCompressed += compressed;
    totalUncompressed += uncompressed;
    if (totalUncompressed > maxUncompressedBytes)
      throw new Error("The XLSX container exceeds the uncompressed size safety limit");
    offset += 46 + fileNameLength + extraLength + commentLength;
    if (offset > eocd) throw new Error("The XLSX central directory is truncated");
  }
  if (offset !== eocd) throw new Error("The XLSX central directory contains trailing data");
  if (
    totalUncompressed > 1_000_000 &&
    (totalCompressed === 0 || totalUncompressed / totalCompressed > maxCompressionRatio)
  )
    throw new Error("The XLSX container has an unsafe compression ratio");
}
