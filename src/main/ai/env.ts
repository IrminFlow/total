// The TOTAL_AI_MOCK switch (WP 5.1): the scripted MockProvider instead of the network provider.
// Honoured only together with TOTAL_DATA_DIR (a scratch data root, never ~/Documents/total) and
// never in a packaged build — the same rule as the insecure test cipher (services/secrets.ts).
// isPackaged null = Electron-as-Node (the dbtest runner), treated as unpackaged.
export function aiMockAllowed(env: { TOTAL_DATA_DIR?: string; TOTAL_AI_MOCK?: string }, isPackaged: boolean | null): boolean {
  if (isPackaged === true) return false
  return !!env.TOTAL_DATA_DIR && env.TOTAL_AI_MOCK === '1'
}
