/**
 * The application menu.
 *
 * Until now the app shipped Electron's DEFAULT menu, which silently owned several keys the
 * renderer wants: Cmd-R and Shift-Cmd-R (reload), Alt-Cmd-I (devtools), and on Windows F12.
 * A renderer binding on any of those never fired, because a menu accelerator wins.
 *
 * Two rules shape what is here:
 *
 *  1. The Edit menu's roles stay. Removing `undo/redo/cut/copy/paste/selectAll` would take
 *     native Cmd-Z/X/C/V/A away from every text field in the app -- Electron only wires those
 *     to the focused input through the menu.
 *
 *  2. Screen actions appear WITHOUT accelerators. A menu accelerator fires even while the
 *     cursor is in a text field, which is exactly what the renderer's own layer registry is
 *     careful not to do. Giving F4-F9 accelerators here would double-fire them and break the
 *     "letters never fire while typing" guarantee. The menu items send a command instead, so
 *     the renderer stays the single owner of every F-key and bare letter.
 */

import { app, BrowserWindow, Menu, shell, type MenuItemConstructorOptions } from 'electron'
import { is } from '@electron-toolkit/utils'
import { SITE_URL } from '@shared/product'

/** Menu -> renderer commands. The renderer maps these ids onto the same actions its keyboard
 *  layers run, so there is one implementation per action rather than two. */
export const MENU_CHANNEL = 'menu:command'

function send(id: string): void {
  const win = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0]
  win?.webContents.send(`total:${MENU_CHANNEL}`, id)
}

const item = (label: string, id: string, accelerator?: string): MenuItemConstructorOptions => ({
  label,
  accelerator,
  click: () => send(id)
})

export function buildMenu(): Menu {
  const isMac = process.platform === 'darwin'

  const appMenu: MenuItemConstructorOptions[] = isMac
    ? [
        {
          label: app.name,
          submenu: [
            { role: 'about' },
            { type: 'separator' },
            item('Settings…', 'settings', 'CmdOrCtrl+,'),
            { type: 'separator' },
            { role: 'services' },
            { type: 'separator' },
            { role: 'hide' },
            { role: 'hideOthers' },
            { role: 'unhide' },
            { type: 'separator' },
            { role: 'quit' }
          ]
        }
      ]
    : []

  const company: MenuItemConstructorOptions = {
    label: 'Company',
    submenu: [
      item('New company…', 'company-new', 'CmdOrCtrl+Shift+N'),
      item('Switch company…', 'company-switch', 'CmdOrCtrl+Shift+O'),
      item('Company details', 'company-info', 'CmdOrCtrl+I'),
      { type: 'separator' },
      item('Back up now', 'backup', 'CmdOrCtrl+B'),
      item('Show exports in file manager', 'show-exports'),
      ...(isMac
        ? []
        : ([
            { type: 'separator' },
            item('Settings…', 'settings', 'CmdOrCtrl+,'),
            { role: 'quit', label: 'Exit' }
          ] as MenuItemConstructorOptions[]))
    ]
  }

  const edit: MenuItemConstructorOptions = {
    label: 'Edit',
    submenu: [
      // Roles, not custom handlers: this is what gives every input native clipboard keys.
      { role: 'undo' },
      { role: 'redo' },
      { type: 'separator' },
      { role: 'cut' },
      { role: 'copy' },
      { role: 'paste' },
      { role: 'selectAll' }
    ]
  }

  const go: MenuItemConstructorOptions = {
    label: 'Go',
    submenu: [
      item('Gateway', 'go-gateway', 'CmdOrCtrl+1'),
      item('Voucher entry', 'go-voucher-entry', 'CmdOrCtrl+2'),
      item('Day book', 'go-daybook', 'CmdOrCtrl+3'),
      item('Masters', 'go-masters', 'CmdOrCtrl+4'),
      { type: 'separator' },
      item('Back', 'back', 'CmdOrCtrl+['),
      item('Find anything…', 'palette', 'CmdOrCtrl+K')
    ]
  }

  const report: MenuItemConstructorOptions = {
    label: 'Report',
    submenu: [
      item('Refresh', 'refresh', 'CmdOrCtrl+R'),
      { type: 'separator' },
      item('Export CSV', 'export-csv', 'CmdOrCtrl+Shift+E'),
      item('Print / PDF', 'print', 'CmdOrCtrl+P'),
      // No accelerator: F12 belongs to the renderer, which knows whether a report is on screen.
      item('Configure columns', 'configure-columns')
    ]
  }

  const view: MenuItemConstructorOptions = {
    label: 'View',
    submenu: [
      { role: 'resetZoom' },
      { role: 'zoomIn' },
      { role: 'zoomOut' },
      { type: 'separator' },
      { role: 'togglefullscreen' },
      // Reload and devtools exist only in development. In a packaged build they would hand the
      // user a way to blow away unsaved voucher state with a stray Cmd-R, and they hold three
      // accelerators the app has better uses for.
      ...(is.dev
        ? ([
            { type: 'separator' },
            { role: 'reload' },
            { role: 'forceReload' },
            { role: 'toggleDevTools' }
          ] as MenuItemConstructorOptions[])
        : [])
    ]
  }

  const window: MenuItemConstructorOptions = {
    label: 'Window',
    submenu: isMac
      ? [{ role: 'minimize' }, { role: 'zoom' }, { type: 'separator' }, { role: 'front' }]
      : [{ role: 'minimize' }, { role: 'close' }]
  }

  const help: MenuItemConstructorOptions = {
    role: 'help',
    submenu: [
      item('Keyboard shortcuts', 'shortcuts', 'CmdOrCtrl+/'),
      {
        label: 'Total on the web',
        click: () => {
          void shell.openExternal(SITE_URL)
        }
      }
    ]
  }

  return Menu.buildFromTemplate([...appMenu, company, edit, go, report, view, window, help])
}

export function installMenu(): void {
  Menu.setApplicationMenu(buildMenu())
}
