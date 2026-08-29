import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { createHash } from 'node:crypto'
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
const duplicateNames = files.map((file) => basename(file)).filter((name, index, names) => names.indexOf(name) !== index)
if (duplicateNames.length) throw new Error(`Duplicate release asset names: ${[...new Set(duplicateNames)].join(', ')}`)
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
  const entries = []
  for (const line of yaml.split(/\r?\n/)) {
    const url = line.match(/^\s*-\s*url:\s*['"]?([^'"\r\n]+?)['"]?\s*$/)?.[1]
    if (url) {
      entries.push({ url: decodeURIComponent(url.trim()), sha512: null, size: null })
      continue
    }
    const current = entries.at(-1)
    if (!current) continue
    const sha512 = line.match(/^\s+sha512:\s*['"]?(\S+?)['"]?\s*$/)?.[1]
    if (sha512) current.sha512 = sha512
    const size = line.match(/^\s+size:\s*(\d+)\s*$/)?.[1]
    if (size) current.size = Number(size)
  }
  if (!entries.length) throw new Error(`${manifestName} contains no downloadable files`)
  for (const entry of entries) {
    const assetName = basename(entry.url)
    const assetPath = byName.get(assetName)
    if (!assetPath) throw new Error(`${manifestName} references missing asset ${assetName}`)
    if (!entry.sha512 || !Number.isSafeInteger(entry.size)) throw new Error(`${manifestName} lacks integrity metadata for ${assetName}`)
    const bytes = statSync(assetPath).size
    if (entry.size !== bytes) throw new Error(`${manifestName} size for ${assetName} is ${entry.size}, actual size is ${bytes}`)
    const digest = createHash('sha512').update(readFileSync(assetPath)).digest('base64')
    if (entry.sha512 !== digest) throw new Error(`${manifestName} SHA-512 mismatch for ${assetName}`)
  }
}

console.log(JSON.stringify({ ok: true, version: expectedVersion, assets: [...byName.keys()].sort() }, null, 2))
