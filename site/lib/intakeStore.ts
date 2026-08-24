import { del, get, list, put } from "@vercel/blob";

const access = "private" as const;

export function intakeStoreConfigured(): boolean {
  return Boolean(process.env.BLOB_READ_WRITE_TOKEN || process.env.VERCEL_OIDC_TOKEN);
}

export async function storeJson(pathname: string, value: unknown, overwrite = false): Promise<void> {
  await put(pathname, JSON.stringify(value), {
    access,
    contentType: "application/json",
    addRandomSuffix: false,
    allowOverwrite: overwrite,
    cacheControlMaxAge: 60,
  });
}

export async function readJson<T>(pathname: string): Promise<T | null> {
  const result = await get(pathname, { access });
  if (!result || result.statusCode !== 200) return null;
  return await new Response(result.stream).json() as T;
}

export async function listJson<T>(prefix: string, maxItems = Number.POSITIVE_INFINITY): Promise<T[]> {
  const rows: T[] = [];
  let cursor: string | undefined;
  do {
    const remaining = Number.isFinite(maxItems) ? Math.max(0, maxItems - rows.length) : 1_000;
    if (remaining === 0) break;
    const result = await list({
      prefix,
      limit: Math.min(1_000, remaining),
      ...(cursor ? { cursor } : {}),
    });
    const page = await Promise.all(result.blobs.map((blob) => readJson<T>(blob.pathname)));
    rows.push(...page.flatMap((row) => row === null ? [] : [row]));
    if (!result.hasMore) break;
    if (!result.cursor) throw new Error("Blob listing reported another page without a cursor");
    cursor = result.cursor;
  } while (true);
  return rows;
}

export interface JsonEntry<T> {
  pathname: string;
  value: T;
}

export async function listJsonEntries<T>(prefix: string, maxItems: number): Promise<JsonEntry<T>[]> {
  const limit = Math.max(1, Math.min(1_000, Math.floor(maxItems)));
  const result = await list({ prefix, limit });
  const rows = await Promise.all(result.blobs.map(async (blob) => ({
    pathname: blob.pathname,
    value: await readJson<T>(blob.pathname),
  })));
  return rows.flatMap((row) => row.value === null ? [] : [{ pathname: row.pathname, value: row.value }]);
}

export async function deleteJson(pathname: string): Promise<void> {
  await del(pathname);
}

export async function jsonExists(pathname: string): Promise<boolean> {
  const result = await list({ prefix: pathname, limit: 2 });
  return result.blobs.some((blob) => blob.pathname === pathname);
}

export async function deleteJsonPrefix(prefix: string): Promise<number> {
  let cursor: string | undefined;
  let deleted = 0;
  do {
    const result = await list({ prefix, limit: 1_000, ...(cursor ? { cursor } : {}) });
    if (result.blobs.length) {
      await del(result.blobs.map((blob) => blob.url));
      deleted += result.blobs.length;
    }
    cursor = result.hasMore ? result.cursor : undefined;
  } while (cursor);
  return deleted;
}
