import { _electron as electron } from 'playwright-core'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, readdirSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join, resolve } from 'node:path'

const platform = process.argv[2] ?? process.platform
const dist = resolve(process.env.RELEASE_DIR ?? 'dist')

function filesBelow(dir) {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name)
    return statSync(path).isDirectory() && !path.endsWith('.app') ? filesBelow(path) : [path]
  })
}

const files = filesBelow(dist)
let executable
if (platform === 'mac' || platform === 'darwin') {
  const appBundle = files.find((path) => path.endsWith('Total.app'))
  if (!appBundle) throw new Error('Packaged Total.app not found')
  executable = join(appBundle, 'Contents', 'MacOS', 'Total')
  execFileSync('codesign', ['--verify', '--deep', '--strict', '--verbose=2', appBundle], { stdio: 'inherit' })
  execFileSync('spctl', ['--assess', '--type', 'execute', '--verbose=2', appBundle], { stdio: 'inherit' })
  execFileSync('xcrun', ['stapler', 'validate', appBundle], { stdio: 'inherit' })
  for (const dmg of files.filter((path) => path.endsWith('.dmg'))) execFileSync('hdiutil', ['verify', dmg], { stdio: 'inherit' })
  for (const zip of files.filter((path) => path.endsWith('.zip'))) execFileSync('unzip', ['-t', zip], { stdio: 'inherit' })
} else if (platform === 'win32' || platform === 'win') {
  executable = files.find((path) => /win-unpacked[\\/]Total\.exe$/.test(path))
  if (!executable) throw new Error('Packaged win-unpacked/Total.exe not found')
} else {
  throw new Error(`Unsupported artifact platform: ${platform}`)
}

if (!existsSync(executable)) throw new Error(`Packaged executable missing: ${executable}`)
const { ELECTRON_RUN_AS_NODE: _ignored, ...env } = process.env
const profileDir = mkdtempSync(join(tmpdir(), 'total-artifact-profile-'))
const app = await electron.launch({
  executablePath: executable,
  timeout: 60_000,
  args: [`--user-data-dir=${profileDir}`],
  env: {
    ...env,
    TOTAL_DATA_DIR: mkdtempSync(join(tmpdir(), 'total-artifact-gate-')),
    TOTAL_SUPPRESS_SYNC_WARNING: '1'
  }
})
try {
  const identity = await app.evaluate(({ app }) => ({ packaged: app.isPackaged, version: app.getVersion(), name: app.getName() }))
  if (!identity.packaged || identity.name !== 'Total') throw new Error(`Invalid packaged identity: ${JSON.stringify(identity)}`)
  console.log(JSON.stringify({ ok: true, executable: basename(executable), ...identity }))
} finally {
  await app.close()
}
