/** Desktop and server-to-server calls may omit Origin. A browser that supplies one must be same-site. */
export function hasForeignOrigin(request: Request): boolean {
  const supplied = request.headers.get("origin");
  if (!supplied) return false;
  try {
    return new URL(supplied).origin !== new URL(request.url).origin;
  } catch {
    return true;
  }
}
