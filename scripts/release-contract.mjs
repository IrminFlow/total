import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { basename, join, resolve } from 'node:path'

const root = resolve(process.env.RELEASE_DIR ?? 'release')
const tag = process.env.RELEASE_TAG ?? process.env.GITHUB_REF_NAME
if (!tag) throw new Error('RELEASE_TAG or GITHUB_REF_NAME is required')
const expectedVersion = tag.replace(/^v/, '')

function filesBelow(dir) {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name)
    return statSync(path).isDirectory() ? filesBelow(path) : [path]
  })
}

if (!existsSync(root)) throw new Error(`Release directory does not exist: ${root}`)
const files = filesBelow(root)
const byName = new Map(files.map((file) => [basename(file), file]))
for (const extension of ['.dmg', '.zip', '.exe']) {
  if (![...byName].some(([name]) => name.endsWith(extension))) throw new Error(`Missing ${extension} release artifact`)
}

for (const manifestName of ['latest-mac.yml', 'latest.yml']) {
  const manifestPath = byName.get(manifestName)
  if (!manifestPath) throw new Error(`Missing updater manifest ${manifestName}`)
  const yaml = readFileSync(manifestPath, 'utf8')
  const version = yaml.match(/^version:\s*['"]?([^'"\s]+)['"]?\s*$/m)?.[1]
  if (version !== expectedVersion) throw new Error(`${manifestName} version ${version ?? '<missing>'} does not match ${expectedVersion}`)
  const urls = [...yaml.matchAll(/^\s*-?\s*url:\s*['"]?([^'"\r\n]+?)['"]?\s*$/gm)].map((match) => decodeURIComponent(match[1].trim()))
  if (!urls.length) throw new Error(`${manifestName} contains no downloadable files`)
  for (const url of urls) {
    if (!byName.has(basename(url))) throw new Error(`${manifestName} references missing asset ${basename(url)}`)
  }
  if (!/^\s*sha512:\s*\S+/m.test(yaml)) throw new Error(`${manifestName} has no SHA-512 integrity value`)
}

console.log(JSON.stringify({ ok: true, version: expectedVersion, assets: [...byName.keys()].sort() }, null, 2))
