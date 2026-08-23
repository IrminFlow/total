/**
 * Menu -> renderer command routing.
 *
 * The application menu deliberately carries no accelerators for screen actions (a menu
 * accelerator fires even inside a text field, which would break the "letters never fire while
 * typing" rule the keyboard layers enforce). Instead menu items send a command id, and this maps
 * each id onto the same action the keyboard already runs — one implementation per action.
 */

import { useEffect } from 'react'
import { useNav, type Screen } from '../state/stores'

export type MenuCommand =
  | 'settings'
  | 'company-new'
  | 'company-switch'
  | 'company-info'
  | 'backup'
  | 'show-exports'
  | 'go-gateway'
  | 'go-voucher-entry'
  | 'go-daybook'
  | 'go-masters'
  | 'back'
  | 'palette'
  | 'refresh'
  | 'export-csv'
  | 'print'
  | 'configure-columns'
  | 'shortcuts'

/** Menu ids that are plain navigation, handled here rather than by each caller. */
const NAVIGATE: Partial<Record<MenuCommand, Screen>> = {
  settings: { name: 'settings' },
  'company-info': { name: 'company-info' },
  'go-voucher-entry': { name: 'voucher-entry' },
  'go-daybook': { name: 'daybook' },
  'go-masters': { name: 'masters' }
}

export function useMenuCommands(handlers: Partial<Record<MenuCommand, () => void>>): void {
  const nav = useNav()
  useEffect(() => {
    return window.total.on('menu:command', (payload) => {
      const id = payload as MenuCommand
      const handler = handlers[id]
      if (handler) {
        handler()
        return
      }
      if (id === 'go-gateway') {
        nav.home()
        return
      }
      if (id === 'back') {
        nav.back()
        return
      }
      const screen = NAVIGATE[id]
      if (screen) nav.go(screen)
    })
    // `handlers` is rebuilt every render; the subscription reads it through the closure, so it
    // only needs re-establishing when the nav store identity changes (never, in practice).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [nav])
}
