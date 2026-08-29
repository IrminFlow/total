import { useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { api } from '../lib/client'
import { useToasts } from '../state/stores'
import { Button, Modal, TextInput } from './ui'
import { confirmDialog } from '../lib/dialogs'

/**
 * Saved report views.
 *
 * The state a screen hands over is opaque to everything below this component: it goes into the
 * company database as JSON and comes back the same shape. Restoring one changes what is asked
 * for, never what is computed — which is why saving a view can never make a report wrong.
 *
 * Deliberately narrow: no sharing, no defaults, no "open this on startup". A named period plus a
 * set of columns is the whole of what people actually re-open.
 */
export function SavedViews<T>({
  screen,
  state,
  onRestore
}: {
  /** Screen key the views are filed under — must be stable across releases. */
  screen: string
  /** The current display state, captured when the user saves. */
  state: T
  onRestore: (state: T) => void
}): React.JSX.Element {
  const toast = useToasts()
  const queryClient = useQueryClient()
  const [open, setOpen] = useState(false)
  const [name, setName] = useState('')
  const { data: views } = useQuery({ queryKey: ['reportViews', screen], queryFn: () => api.views.list(screen) })

  const refresh = async (): Promise<void> => {
    await queryClient.invalidateQueries({ queryKey: ['reportViews'] })
  }

  const save = async (): Promise<void> => {
    const trimmed = name.trim()
    if (!trimmed) return
    try {
      await api.views.save(screen, trimmed, state)
      await refresh()
      setName('')
      toast.push('success', `View “${trimmed}” saved`)
    } catch (err) {
      toast.push('error', (err as Error).message)
    }
  }

  const remove = async (id: number, viewName: string): Promise<void> => {
    const proceed = await confirmDialog({
      title: 'Delete view',
      message: `Delete the saved view “${viewName}”?`,
      confirmLabel: 'Delete',
      danger: true
    })
    if (!proceed) return
    try {
      await api.views.remove(id)
      await refresh()
    } catch (err) {
      toast.push('error', (err as Error).message)
    }
  }

  const count = views?.length ?? 0

  return (
    <>
      <Button variant="ghost" data-testid={`btn-views-${screen}`} onClick={() => setOpen(true)}>
        Views{count > 0 ? ` (${count})` : ''}
      </Button>
      {open && (
        <Modal title="Saved views" onClose={() => setOpen(false)}>
          <div className="flex flex-col gap-3">
            <div className="flex items-end gap-2">
              <TextInput
                value={name}
                placeholder="Name this view"
                data-testid="input-view-name"
                onChange={(e) => setName(e.currentTarget.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') void save()
                }}
              />
              <Button variant="primary" data-testid="btn-view-save" onClick={() => void save()}>
                Save current
              </Button>
            </div>
            {count === 0 ? (
              <p className="text-body-sm text-muted">
                No saved views yet. A view remembers the period and the columns, not the figures.
              </p>
            ) : (
              <div data-testid="rows-saved-views">
                {views!.map((v) => (
                  <div key={v.id} className="flex items-center gap-3 border-b border-line/40 py-1.5 last:border-b-0">
                    <button
                      className="flex-1 truncate text-left text-detail hover:underline"
                      data-testid={`btn-view-open-${v.id}`}
                      onClick={() => {
                        onRestore(v.state as T)
                        setOpen(false)
                      }}
                    >
                      {v.name}
                    </button>
                    <Button variant="ghost" onClick={() => void remove(v.id, v.name)}>
                      Delete
                    </Button>
                  </div>
                ))}
              </div>
            )}
          </div>
        </Modal>
      )}
    </>
  )
}
