import { describe, expect, it, vi } from 'vitest'
import { join } from 'path'
import { chooseExportPath, hermeticRun } from './exportTarget'

const req = { exportsDir: '/data/companies/acme/exports', defaultName: 'einvoice-102026.json', title: 'Save e-invoice JSON', filters: [{ name: 'JSON', extensions: ['json'] }] }

describe('chooseExportPath', () => {
  it('a hermetic run never shows the dialog and writes into exports/ as before', async () => {
    const show = vi.fn()
    expect(await chooseExportPath(req, { hermetic: () => true, showSaveDialog: show })).toBe(join(req.exportsDir, req.defaultName))
    expect(show).not.toHaveBeenCalled()
  })
  it('otherwise the dialog starts in exports/ with the export’s own name', async () => {
    const show = vi.fn(async () => ({ canceled: false, filePath: '/Users/me/Desktop/mine.json' }))
    expect(await chooseExportPath(req, { hermetic: () => false, showSaveDialog: show })).toBe('/Users/me/Desktop/mine.json')
    expect(show).toHaveBeenCalledWith(expect.objectContaining({ defaultPath: join(req.exportsDir, req.defaultName), filters: req.filters }))
  })
  it('cancel = null (nothing written)', async () => {
    expect(await chooseExportPath(req, { hermetic: () => false, showSaveDialog: async () => ({ canceled: true }) })).toBeNull()
    expect(await chooseExportPath(req, { hermetic: () => false, showSaveDialog: async () => ({ canceled: false, filePath: '' }) })).toBeNull()
  })
  it('a folder export has no file-type filter', async () => {
    const show = vi.fn(async (_opts: { filters?: unknown }) => ({ canceled: false, filePath: '/x/ca-pack' }))
    await chooseExportPath({ ...req, kind: 'folder' }, { hermetic: () => false, showSaveDialog: show })
    expect(show.mock.calls[0]![0].filters).toBeUndefined()
  })
  it('hermetic = TOTAL_DATA_DIR set in an unpackaged build (a packaged app always asks)', () => {
    expect(hermeticRun({ TOTAL_DATA_DIR: '/tmp/x' }, false)).toBe(true)
    expect(hermeticRun({ TOTAL_DATA_DIR: '/tmp/x' }, null)).toBe(true)
    expect(hermeticRun({ TOTAL_DATA_DIR: '/tmp/x' }, true)).toBe(false)
    expect(hermeticRun({}, false)).toBe(false)
    expect(hermeticRun({}, true)).toBe(false)
  })
})
