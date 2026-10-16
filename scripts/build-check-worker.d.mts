import type { BuildResult } from 'esbuild'
export declare const CHECK_WORKER_FORBIDDEN: RegExp[]
export declare function buildCheckWorker(outfile: string, opts?: { sqlitePath?: string; metafile?: boolean; minify?: boolean }): Promise<BuildResult>
export declare function sqliteDriverPath(): string
export declare const ELECTRON_STUB: string
