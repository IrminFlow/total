/** Stack of mounted modals — only the topmost one responds to Esc/Tab, so stacked modals
 *  (e.g. a ConfirmModal over a form modal) close one at a time. */
let modalSeq = 0
const modalStack: number[] = []

export function registerModal(): number {
  const id = ++modalSeq
  modalStack.push(id)
  return id
}

export function unregisterModal(id: number): void {
  const index = modalStack.indexOf(id)
  if (index >= 0) modalStack.splice(index, 1)
}

export function isTopModal(id: number): boolean {
  return modalStack[modalStack.length - 1] === id
}

/** True while any Modal is mounted — screens use it to suppress their own global shortcuts
 *  so keys aimed at a dialog never leak through to the screen underneath. */
export function isAnyModalOpen(): boolean {
  return modalStack.length > 0
}
