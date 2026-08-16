// The CLI bundle (scripts/total-cli.mjs) loads .md files as text via esbuild's `text` loader.
declare module '*.md' {
  const text: string
  export default text
}
