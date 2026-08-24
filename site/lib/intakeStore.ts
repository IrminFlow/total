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
    cacheControlMaxAge: 0,
  });
}

export async function readJson<T>(pathname: string): Promise<T | null> {
  const result = await get(pathname, { access });
  if (!result || result.statusCode !== 200) return null;
  return await new Response(result.stream).json() as T;
}

export async function listJson<T>(prefix: string, limit = 1_000): Promise<T[]> {
  const result = await list({ prefix, limit });
  const rows = await Promise.all(result.blobs.map((blob) => readJson<T>(blob.pathname)));
  return rows.flatMap((row) => row === null ? [] : [row as T]);
}

export async function deleteJson(pathname: string): Promise<void> {
  await del(pathname);
}
