// Settings → "Where Total keeps your books": the folder in use, the OneDrive warning (en / hi /
// hinglish), read-only under TOTAL_DATA_DIR, owner-only, pick → confirm → move, a refused pick.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { ReactNode } from 'react'
import type { DataFolderPick, DataFolderView } from '@shared/dataFolder'
import { DataFolderSetting } from '../simple/DataFolderSetting'
import { LANGUAGE_KEY } from '../lib/i18n'
import { useSession } from '../state/stores'
import { CATALOGUES } from '@shared/i18n'
import { en } from '@shared/i18n/catalogues/en'

const invoke = vi.fn()
let view: DataFolderView
let pick: DataFolderPick | null

const wrap = (ui: ReactNode): ReactNode => (
  <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>{ui}</QueryClientProvider>
)

beforeEach(() => {
  localStorage.clear()
  view = { path: 'C:\\Users\\asha\\OneDrive\\Documents\\total', source: 'default', defaultPath: 'C:\\Users\\asha\\OneDrive\\Documents\\total', oneDrive: true, synced: false, missingPointer: null }
  pick = { path: 'D:\\Total', ok: true, kind: 'new', bytes: 5 * 1024 * 1024, oneDrive: false, synced: false }
  invoke.mockReset()
  invoke.mockImplementation(async (channel: string, payload?: { path?: string }) => {
    switch (channel) {
      case 'app:dataRoot:get':
        return { ok: true, data: view }
      case 'app:dataRoot:pick':
        return { ok: true, data: pick }
      case 'app:dataRoot:move':
        return { ok: true, data: { path: payload!.path, copied: true, files: 12, relaunching: true } }
      case 'company:current':
        return { ok: true, data: { slug: 'acme' } }
      default:
        return { ok: false, error: `unmocked ${channel}` }
    }
  })
  window.total = { platform: 'test', invoke, onAiEvent: () => () => undefined, onUpdateEvent: () => () => undefined } as never
  act(() => useSession.setState({ slug: 'acme', user: null }))
})
afterEach(() => cleanup())

describe('DataFolderSetting', () => {
  it('shows the folder and warns about OneDrive', async () => {
    render(wrap(<DataFolderSetting />))
    expect((await screen.findByTestId('data-folder-path')).textContent).toBe(view.path)
    expect(screen.getByTestId('data-folder-source').textContent).toBe(en['simple.dataFolder.usual'])
    expect(screen.getByTestId('data-folder-synced').textContent).toBe(en['simple.dataFolder.oneDrive'])
  })

  it.each(['hi', 'hinglish'] as const)('warns in %s', async (lang) => {
    localStorage.setItem(LANGUAGE_KEY, lang)
    render(wrap(<DataFolderSetting />))
    expect((await screen.findByTestId('data-folder-synced')).textContent).toBe(CATALOGUES[lang]['simple.dataFolder.oneDrive'])
    expect(screen.getByTestId('btn-data-folder-move').textContent).toBe(CATALOGUES[lang]['simple.dataFolder.move'])
  })

  it('no warning for a local folder', async () => {
    view = { ...view, path: 'D:\\Total', source: 'pointer', oneDrive: false }
    render(wrap(<DataFolderSetting />))
    expect((await screen.findByTestId('data-folder-source')).textContent).toBe(en['simple.dataFolder.chosen'])
    expect(screen.queryByTestId('data-folder-synced')).toBeNull()
  })

  it('is read-only when the environment sets the folder', async () => {
    view = { ...view, source: 'env', oneDrive: false }
    render(wrap(<DataFolderSetting />))
    expect((await screen.findByTestId('data-folder-source')).textContent).toBe(en['simple.dataFolder.env'])
    expect(screen.queryByTestId('btn-data-folder-move')).toBeNull()
  })

  it('only the owner may move it where the business has sign-ins', async () => {
    act(() => useSession.setState({ user: { id: 2, name: 'Clerk', role: 'accountant' } as never }))
    render(wrap(<DataFolderSetting />))
    expect(((await screen.findByTestId('btn-data-folder-move')) as HTMLButtonElement).disabled).toBe(true)
  })

  it('pick → confirm → move and restart, sending the picked folder', async () => {
    render(wrap(<DataFolderSetting />))
    fireEvent.click(await screen.findByTestId('btn-data-folder-move'))
    const confirm = await screen.findByTestId('data-folder-confirm')
    expect(confirm.textContent).toContain('D:\\Total')
    expect(confirm.textContent).toContain(en['simple.dataFolder.confirmCopy'].replace('{size}', '5.0 MB'))
    fireEvent.click(screen.getByTestId('btn-data-folder-confirm'))
    expect((await screen.findByTestId('data-folder-moved')).textContent).toBe(en['simple.dataFolder.moved'])
    expect(invoke).toHaveBeenCalledWith('app:dataRoot:move', { path: 'D:\\Total' })
  })

  it('a folder that already holds books is opened, not copied over', async () => {
    pick = { path: 'E:\\Books', ok: true, kind: 'total', oneDrive: false, synced: false }
    render(wrap(<DataFolderSetting />))
    fireEvent.click(await screen.findByTestId('btn-data-folder-move'))
    expect((await screen.findByTestId('data-folder-confirm')).textContent).toContain(en['simple.dataFolder.confirmUse'])
    expect(screen.getByTestId('btn-data-folder-confirm').textContent).toBe(en['simple.dataFolder.useNow'])
  })

  it('a refused folder says why and offers nothing to confirm', async () => {
    pick = { path: 'D:\\Photos', ok: false, problem: 'not_empty', oneDrive: false, synced: false }
    render(wrap(<DataFolderSetting />))
    fireEvent.click(await screen.findByTestId('btn-data-folder-move'))
    expect((await screen.findByTestId('data-folder-problem')).textContent).toBe(en['errors.dataFolder.notEmpty'])
    expect(screen.queryByTestId('data-folder-confirm')).toBeNull()
  })

  it('a failed move shows the plain message, the detail behind Details', async () => {
    invoke.mockImplementation(async (channel: string) => {
      if (channel === 'app:dataRoot:get') return { ok: true, data: view }
      if (channel === 'app:dataRoot:pick') return { ok: true, data: pick }
      if (channel === 'app:dataRoot:move') return { ok: false, error: 'The books could not be copied — nothing was changed (EIO)', code: 'data_folder_copy_failed' }
      if (channel === 'company:current') return { ok: true, data: { slug: 'acme' } }
      return { ok: false, error: 'unmocked' }
    })
    render(wrap(<DataFolderSetting />))
    fireEvent.click(await screen.findByTestId('btn-data-folder-move'))
    fireEvent.click(await screen.findByTestId('btn-data-folder-confirm'))
    const err = await screen.findByTestId('data-folder-error')
    expect(err.textContent).toContain(en['errors.dataFolder.copyFailed'])
    expect(err.textContent).toContain('EIO')
    await waitFor(() => expect(screen.getByTestId('btn-data-folder-move')).toBeTruthy())
  })
})
