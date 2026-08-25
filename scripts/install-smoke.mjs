// Release-only smoke against the distributable itself. Installs into a disposable directory,
// launches with a clean profile, creates/posts/backs up/restores, then uninstalls.
import { _electron as electron } from 'playwright-core'
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join, resolve } from 'node:path'

const platform = process.argv[2] ?? process.platform
const dist = resolve(process.env.RELEASE_DIR ?? 'dist')
const scratch = mkdtempSync(join(tmpdir(), 'total-install-smoke-'))
const installRoot = join(scratch, 'Applications')
let mountPoint = null
let executable = null
let uninstaller = null
let installer = null

function filesBelow(dir) {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name)
    return statSync(path).isDirectory() ? filesBelow(path) : [path]
  })
}

function artifact(path) {
  return {
    name: basename(path),
    bytes: statSync(path).size,
    sha256: createHash('sha256').update(readFileSync(path)).digest('hex')
  }
}

function writeHostedRunnerEvidence(result) {
  const output = process.env.INSTALL_EVIDENCE?.trim()
  if (!output) return
  if (process.env.GITHUB_ACTIONS !== 'true' || process.env.RUNNER_ENVIRONMENT !== 'github-hosted') {
    throw new Error('Install evidence may only be recorded by a GitHub-hosted Actions runner')
  }
  const sourceRevision = (process.env.RELEASE_REVISION ?? process.env.GITHUB_SHA ?? '').trim()
  if (!/^[0-9a-f]{40}$/i.test(sourceRevision)) throw new Error('Install evidence requires a full release revision')
  if (!installer) throw new Error('Install evidence has no source installer')
  const evidence = {
    schema: 1,
    ok: true,
    executed: true,
    testedAt: new Date().toISOString(),
    sourceRevision,
    productVersion: result.version,
    platform: platform === 'mac' || platform === 'darwin' ? 'mac' : 'win',
    runner: {
      provider: 'github-actions',
      environment: 'github-hosted',
      os: process.env.RUNNER_OS,
      arch: process.env.RUNNER_ARCH,
      imageOS: process.env.ImageOS,
      imageVersion: process.env.ImageVersion,
      runId: process.env.GITHUB_RUN_ID,
      runAttempt: process.env.GITHUB_RUN_ATTEMPT,
      job: process.env.GITHUB_JOB
    },
    candidateArtifact: artifact(installer),
    installationMethod: platform === 'mac' || platform === 'darwin' ? 'mounted-readonly-dmg-and-copied-app' : 'silent-nsis-install',
    checks: {
      freshIsolatedHomeAndProfile: 'passed',
      packagedLaunch: 'passed',
      postVoucher: 'passed',
      backupPreview: 'passed',
      backupRestore: 'passed',
      uninstallRemovesApplication: 'passed',
      uninstallPreservesCompanyData: 'passed'
    }
  }
  mkdirSync(resolve(output, '..'), { recursive: true })
  writeFileSync(resolve(output), `${JSON.stringify(evidence, null, 2)}\n`, { mode: 0o600 })
}

async function runBookWorkflow(path) {
  // Keep release smoke data outside both the application and profile directories. macOS 26's
  // LaunchServices path resolution does not consistently honour a child process HOME override,
  // so an explicit data root is required to keep hosted and local runs hermetic. Removing the
  // installed app/NSIS target still proves that uninstall leaves this external company root intact.
  const isolatedHome = join(scratch, 'home')
  const dataDir = join(isolatedHome, 'Documents', 'total')
  const profileDir = join(scratch, 'profile')
  mkdirSync(join(isolatedHome, 'Documents'), { recursive: true })
  const { ELECTRON_RUN_AS_NODE: _ignored, ...env } = process.env
  const app = await electron.launch({
    executablePath: path,
    args: [`--user-data-dir=${profileDir}`],
    timeout: 60_000,
    env: {
      ...env,
      HOME: isolatedHome,
      USERPROFILE: isolatedHome,
      TOTAL_DATA_DIR: dataDir,
      TOTAL_SUPPRESS_SYNC_WARNING: '1'
    }
  })
  const page = await app.firstWindow()
  await page.waitForFunction(() => Boolean(window.total), null, { timeout: 30_000 })
  const invoke = async (channel, payload) => {
    const result = await page.evaluate(([name, body]) => window.total.invoke(name, body), [channel, payload])
    if (!result.ok) throw new Error(`${channel}: ${result.error}`)
    return result.data
  }
  try {
    const identity = await app.evaluate(({ app }) => ({ packaged: app.isPackaged, version: app.getVersion() }))
    if (!identity.packaged) throw new Error('Installed application did not report app.isPackaged')
    const created = await invoke('company:create', {
      name: 'Release Smoke Books', stateCode: '27', gstin: null, gstRegistrationType: 'unregistered',
      address: '', booksFrom: 2026, email: null, phone: null, pan: null, tan: null
    })
    await invoke('company:open', { slug: created.slug })
    const types = await invoke('master:voucherTypes:list')
    const ledgers = await invoke('master:ledgers:list')
    const journal = types.find((row) => row.kind === 'journal')
    const cash = ledgers.find((row) => row.name === 'Cash')
    if (!journal || !cash) throw new Error('Seeded journal type or Cash ledger missing')
    const posted = await invoke('voucher:save', {
      data: {
        voucherTypeId: journal.id, date: '2026-08-24', partyLedgerId: null, narration: 'Release install smoke',
        reference: null, instrumentNo: null, instrumentDate: null, transporterId: null, vehicleNo: null,
        transportDistanceKm: null, posOverride: null, currencyCode: null, exchangeRate: null,
        lines: [
          { ledgerId: cash.id, drCr: 'dr', amount: 12345, costAllocations: [] },
          { ledgerId: cash.id, drCr: 'cr', amount: 12345, costAllocations: [] }
        ], inventory: [], billRefs: [], tds: null
      }
    })
    if (posted.approvalRequired || !posted.id) throw new Error('Smoke voucher was not posted')
    await invoke('backup:run')
    const backups = await invoke('backup:list')
    const manual = backups.find((row) => row.tag === 'manual') ?? backups[0]
    if (!manual?.file) throw new Error('Manual backup was not listed')
    const preview = await invoke('backup:preview', { file: manual.file })
    if (!preview.valid || preview.integrity !== 'ok' || preview.voucherCount < 1) throw new Error(`Backup preview failed: ${JSON.stringify(preview)}`)
    const mutation = await invoke('voucher:save', {
      data: {
        voucherTypeId: journal.id, date: '2026-08-25', partyLedgerId: null, narration: 'Must disappear after restore',
        reference: null, instrumentNo: null, instrumentDate: null, transporterId: null, vehicleNo: null,
        transportDistanceKm: null, posOverride: null, currencyCode: null, exchangeRate: null,
        lines: [
          { ledgerId: cash.id, drCr: 'dr', amount: 6789, costAllocations: [] },
          { ledgerId: cash.id, drCr: 'cr', amount: 6789, costAllocations: [] }
        ], inventory: [], billRefs: [], tds: null
      }
    })
    if (mutation.approvalRequired || !mutation.id) throw new Error('Restore mutation voucher was not posted')
    const beforeRestore = await invoke('voucher:list', { from: '2026-08-01', to: '2026-08-31' })
    if (beforeRestore.length !== 2) throw new Error(`Restore setup returned ${beforeRestore.length} vouchers instead of 2`)
    await invoke('backup:restore', { file: manual.file })
    const vouchers = await invoke('voucher:list', { from: '2026-08-01', to: '2026-08-31' })
    if (vouchers.length !== 1 || vouchers.some((row) => row.id === mutation.id)) {
      throw new Error(`Restore did not roll back the post-backup mutation: ${JSON.stringify(vouchers.map((row) => row.id))}`)
    }
    return { ...identity, slug: created.slug, voucherId: posted.id, backup: manual.file, restoredMutation: mutation.id, dataDir }
  } finally {
    await app.close()
  }
}

try {
  const files = filesBelow(dist)
  if (platform === 'mac' || platform === 'darwin') {
    installer = files.find((path) => path.endsWith('.dmg'))
    if (!installer) throw new Error('DMG not found')
    const attached = execFileSync('hdiutil', ['attach', installer, '-nobrowse', '-readonly'], { encoding: 'utf8' })
    mountPoint = attached.split(/\r?\n/).flatMap((line) => line.split('\t')).find((part) => part.startsWith('/Volumes/')) ?? null
    if (!mountPoint) throw new Error(`Could not identify mounted DMG: ${attached}`)
    const sourceApp = join(mountPoint, 'Total.app')
    const installedApp = join(installRoot, 'Total.app')
    execFileSync('ditto', [sourceApp, installedApp], { stdio: 'inherit' })
    executable = join(installedApp, 'Contents', 'MacOS', 'Total')
  } else if (platform === 'win' || platform === 'win32') {
    installer = files.find((path) => path.endsWith('.exe') && !path.includes('win-unpacked'))
    if (!installer) throw new Error('NSIS installer not found')
    execFileSync(installer, ['/S', `/D=${installRoot}`], { stdio: 'inherit' })
    executable = join(installRoot, 'Total.exe')
    uninstaller = join(installRoot, 'Uninstall Total.exe')
  } else {
    throw new Error(`Unsupported install platform: ${platform}`)
  }
  if (!executable || !existsSync(executable)) throw new Error(`Installed executable missing: ${executable}`)
  const result = await runBookWorkflow(executable)
  const executableName = basename(executable)
  if (platform === 'mac' || platform === 'darwin') {
    rmSync(join(installRoot, 'Total.app'), { recursive: true, force: false })
  } else if (uninstaller && existsSync(uninstaller)) {
    execFileSync(uninstaller, ['/S'], { stdio: 'inherit' })
    uninstaller = null
  }
  if (existsSync(executable)) throw new Error(`Uninstall left the application executable behind: ${executable}`)
  const preservedDb = join(result.dataDir, 'companies', result.slug, 'company.db')
  if (!existsSync(preservedDb)) throw new Error('Uninstall deleted the company database')
  writeHostedRunnerEvidence(result)
  console.log(JSON.stringify({ ok: true, platform, executable: executableName, ...result, dataPreservedAfterUninstall: true }))
} finally {
  if (uninstaller && existsSync(uninstaller)) {
    try { execFileSync(uninstaller, ['/S'], { stdio: 'inherit' }) } catch (error) { console.warn('Uninstaller cleanup failed:', String(error)) }
  }
  if (mountPoint) {
    try {
      execFileSync('hdiutil', ['detach', mountPoint], { stdio: 'inherit' })
    } catch {
      try { execFileSync('hdiutil', ['detach', '-force', mountPoint], { stdio: 'inherit' }) } catch (error) { console.warn('DMG cleanup failed:', String(error)) }
    }
  }
  try {
    // NSIS can briefly retain a directory handle after its silent uninstaller exits.
    rmSync(scratch, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 })
  } catch (error) {
    if ((platform === 'win' || platform === 'win32') && ['EBUSY', 'EPERM'].includes(error?.code)) {
      console.warn('Deferred Windows smoke-directory cleanup:', String(error))
    } else {
      throw error
    }
  }
}
