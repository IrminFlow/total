import { createHash } from 'node:crypto'
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { basename, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const CHANNELS = new Set(['stable', 'beta', 'internal'])
const ARTIFACT_SUFFIXES = ['.dmg', '.zip', '.exe', '.blockmap', '.yml']

function sha256(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex')
}

export function createStagedReleaseManifest({
  artifactDirectory,
  output,
  channel,
  rolloutPercentage,
  sourceRevision,
  platform,
  createdAt = new Date().toISOString(),
  packagePath = resolve('package.json'),
}) {
  if (!CHANNELS.has(channel)) throw new Error(`Invalid update channel: ${channel}`)
  const percentage = Number(rolloutPercentage)
  if (!Number.isInteger(percentage) || percentage < 0 || percentage > 100) {
    throw new Error('Rollout percentage must be an integer from 0 to 100')
  }
  if (!/^[0-9a-f]{40}$/i.test(sourceRevision)) throw new Error('Source revision must be a full commit SHA')
  if (platform !== 'mac' && platform !== 'win') throw new Error('Platform must be mac or win')
  if (!existsSync(artifactDirectory)) throw new Error(`Artifact directory does not exist: ${artifactDirectory}`)

  const pkg = JSON.parse(readFileSync(packagePath, 'utf8'))
  const artifacts = readdirSync(artifactDirectory)
    .map((name) => join(artifactDirectory, name))
    .filter((path) => statSync(path).isFile() && ARTIFACT_SUFFIXES.some((suffix) => path.endsWith(suffix)))
    .sort()
    .map((path) => ({ name: basename(path), bytes: statSync(path).size, sha256: sha256(path) }))
  if (!artifacts.length) throw new Error('No package artifacts found')

  const manifest = {
    schema: 1,
    version: pkg.version,
    channel,
    rolloutPercentage: percentage,
    sourceRevision: sourceRevision.toLowerCase(),
    platform,
    signed: false,
    publishable: false,
    createdAt,
    artifacts,
  }
  writeFileSync(output, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8')
  return manifest
}

function argument(name) {
  const index = process.argv.indexOf(`--${name}`)
  return index < 0 ? undefined : process.argv[index + 1]
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  createStagedReleaseManifest({
    artifactDirectory: resolve(argument('artifacts') ?? 'dist'),
    output: resolve(argument('output') ?? 'dist/staged-release-manifest.json'),
    channel: argument('channel') ?? 'internal',
    rolloutPercentage: argument('rollout') ?? '100',
    sourceRevision: argument('revision') ?? '',
    platform: argument('platform') ?? '',
  })
}
