import { readFileSync } from 'node:fs'

const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
const tag = process.env.RELEASE_TAG ?? process.env.GITHUB_REF_NAME
if (!tag) throw new Error('RELEASE_TAG or GITHUB_REF_NAME is required')
if (!/^v\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(tag)) throw new Error(`Invalid release tag: ${tag}`)
if (tag !== `v${pkg.version}`) throw new Error(`Tag ${tag} does not match package version v${pkg.version}`)
if (!pkg.build?.publish?.some((entry) => entry.provider === 'github' && entry.releaseType === 'release')) {
  throw new Error('electron-builder must target a non-draft GitHub release')
}
console.log(JSON.stringify({ ok: true, tag, version: pkg.version, appId: pkg.build.appId }))
