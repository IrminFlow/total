import { useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { api, type Role, type UserRow } from '../../lib/client'
import { useSession, useToasts } from '../../state/stores'
import {
  Button,
  EmptyState,
  Field,
  Modal,
  Panel,
  RowAction,
  SectionTitle,
  Select,
  TextInput
} from '../../components/ui'
import { useStickyNumber } from '../../lib/useStickyTab'
import { AUTO_LOCK_OPTIONS } from '../../lib/useAutoLock'
import { CAPABILITIES, CAPABILITY_LABELS, type Capability } from '@shared/permissions'

const ROLES: Role[] = ['owner', 'accountant', 'viewer']

export function UsersSection(): React.JSX.Element {
  const { user, setUser } = useSession()
  const isOwner = user?.role === 'owner'
  // users:list/save/deactivate are owner-gated server-side, EXCEPT while the company has zero
  // users at all — that gate is off entirely then (see ipc.ts's UNGATED_CHANNELS / `usersExist`
  // check), which is how the bootstrap-owner flow (user == null) reaches this screen and query.
  // A signed-in non-owner (accountant/viewer) would just get "You do not have permission" back,
  // so don't even fire the query for them — show the same message the server would.
  const canManage = user == null || isOwner
  const { data } = useQuery({ queryKey: ['users'], queryFn: api.users.list, enabled: canManage })
  const toast = useToasts()
  const queryClient = useQueryClient()
  const [adding, setAdding] = useState(false)
  const [editing, setEditing] = useState<UserRow | null>(null)
  const [deactivating, setDeactivating] = useState<UserRow | null>(null)
  const rows = data ?? []
  const bootstrap = rows.length === 0

  if (!canManage) {
    return (
      <div>
        <SectionTitle>Users</SectionTitle>
        <div className="rounded-md border border-blue/40 bg-blue/10 px-3.5 py-2.5 text-body-sm text-blue">
          Only the owner can manage users. Ask an owner to sign in to add, edit or deactivate accounts.
        </div>
      </div>
    )
  }

  return (
    <div>
      <SectionTitle right={<Button variant="primary" data-testid="btn-users-add" onClick={() => setAdding(true)}>Add user</Button>}>
        Users
      </SectionTitle>
      <Panel>
        {rows.length === 0 ? (
          <EmptyState title="No users yet" hint="Add the first user to enable sign-in and role-based access." />
        ) : (
          <table className="ledger-table">
            <thead>
              <tr>
                <th scope="col">Name</th>
                <th scope="col" className="w-28">Role</th>
                <th scope="col">Cannot reach</th>
                <th scope="col" className="w-24">Status</th>
                <th scope="col" className="r w-32"></th>
              </tr>
            </thead>
            <tbody>
              {rows.map((u) => (
                <tr key={u.id}>
                  <td>{u.name}</td>
                  <td className="capitalize">{u.role}</td>
                  <td className="text-hint text-muted" data-testid={`user-denied-${u.id}`}>
                    {u.denied.length === 0 ? 'everything their role allows' : u.denied.join(', ')}
                  </td>
                  <td>
                    <span
                      className={`rounded-full border px-2 py-0.5 text-caption ${
                        u.active ? 'border-dr/40 text-dr' : 'border-line text-muted'
                      }`}
                    >
                      {u.active ? 'Active' : 'Inactive'}
                    </span>
                  </td>
                  <td className="r whitespace-nowrap">
                    <RowAction onClick={() => setEditing(u)}>
                      Edit
                    </RowAction>
                    {u.active && (
                      <button className="text-small text-cr hover:underline" onClick={() => setDeactivating(u)}>
                        Deactivate
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Panel>

      <AutoLockSetting hasUsers={rows.length > 0} />

      {(adding || editing) && (
        <UserModal
          existing={editing}
          bootstrap={bootstrap}
          onClose={() => {
            setAdding(false)
            setEditing(null)
          }}
          onSaved={(saved) => {
            void queryClient.invalidateQueries({ queryKey: ['users'] })
            // Bootstrap owner creation auto-signs the caller in (see ipc.ts's users:save) — the
            // renderer session must catch up so the Shell chip and role gates work immediately.
            if (!user && !saved.locked) {
              setUser({ id: saved.id, name: saved.name, role: saved.role, denied: saved.denied })
            }
          }}
        />
      )}
      {deactivating && <DeactivateModal user={deactivating} onClose={() => setDeactivating(null)} />}
    </div>
  )
}

function UserModal({
  existing,
  bootstrap,
  onClose,
  onSaved
}: {
  existing: UserRow | null
  bootstrap: boolean
  onClose: () => void
  onSaved: (result: UserRow & { locked: boolean }) => void
}): React.JSX.Element {
  const toast = useToasts()
  const [name, setName] = useState(existing?.name ?? '')
  const [role, setRole] = useState<Role>(existing?.role ?? (bootstrap ? 'owner' : 'accountant'))
  const [active, setActive] = useState(existing?.active ?? true)
  const [denied, setDenied] = useState<Capability[]>(existing?.denied ?? [])
  const [pin, setPin] = useState('')
  const [pin2, setPin2] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const pinRequired = !existing
  const pinProvided = pin.length > 0
  const pinOk = pinRequired ? /^\d{4,12}$/.test(pin) : pin === '' || /^\d{4,12}$/.test(pin)

  const submit = async (): Promise<void> => {
    if (!name.trim()) return setError('Name is required')
    if (!pinOk) return setError('PIN must be 4-12 digits')
    if ((pinRequired || pinProvided) && pin !== pin2) return setError('PINs do not match')
    setBusy(true)
    try {
      const result = await api.users.save(
        { name: name.trim(), role, active, denied, pin: pin || undefined },
        existing?.id
      )
      toast.push('success', existing ? 'User updated' : 'User added')
      onSaved(result)
      onClose()
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <Modal title={existing ? `Edit ${existing.name}` : 'Add user'} onClose={onClose}>
      <div className="flex flex-col gap-3">
        <Field label="Name" error={error}>
          <TextInput
            data-testid="input-user-name"
            value={name}
            onChange={(e) => {
              setName(e.target.value)
              setError(null)
            }}
            autoFocus
          />
        </Field>
        <Field label="Role" hint={bootstrap ? 'The first user of a company is always the owner.' : undefined}>
          <Select value={role} onChange={(e) => setRole(e.target.value as Role)} disabled={bootstrap}>
            {ROLES.map((r) => (
              <option key={r} value={r}>
                {r}
              </option>
            ))}
          </Select>
        </Field>
        {!bootstrap && (
          <Field
            label="Areas this account may not reach"
            hint="The role sets the ceiling; ticking here cuts an area out of it. There is no way to grant more than the role — an entry the audit trail attributes to a viewer should have been impossible for a viewer to make."
          >
            <div className="grid grid-cols-2 gap-1.5" data-testid="user-denials">
              {CAPABILITIES.map((capability) => (
                <label key={capability} className="flex items-center gap-2 text-detail text-ink">
                  <input
                    type="checkbox"
                    data-testid={`deny-${capability}`}
                    checked={denied.includes(capability)}
                    onChange={(e) =>
                      setDenied((current) =>
                        e.target.checked ? [...current, capability] : current.filter((c) => c !== capability)
                      )
                    }
                  />
                  {CAPABILITY_LABELS[capability]}
                </label>
              ))}
            </div>
          </Field>
        )}
        <Field label={existing ? 'New PIN (leave blank to keep current)' : 'PIN (4-12 digits)'}>
          <TextInput
            type="password"
            inputMode="numeric"
            value={pin}
            onChange={(e) => {
              setPin(e.target.value.replace(/\D/g, '').slice(0, 12))
              setError(null)
            }}
          />
        </Field>
        {(pinRequired || pinProvided) && (
          <Field label="Confirm PIN">
            <TextInput
              type="password"
              inputMode="numeric"
              value={pin2}
              onChange={(e) => {
                setPin2(e.target.value.replace(/\D/g, '').slice(0, 12))
                setError(null)
              }}
            />
          </Field>
        )}
        {existing && (
          <Field label="Status">
            <Select value={active ? '1' : '0'} onChange={(e) => setActive(e.target.value === '1')}>
              <option value="1">Active</option>
              <option value="0">Inactive</option>
            </Select>
          </Field>
        )}
      </div>
      <div className="mt-5 flex justify-end gap-2">
        <Button onClick={onClose}>Cancel</Button>
        <Button variant="primary" data-testid="btn-users-save" disabled={busy} onClick={() => void submit()}>
          {busy ? 'Saving…' : existing ? 'Save' : 'Add user'}
        </Button>
      </div>
    </Modal>
  )
}

function DeactivateModal({ user, onClose }: { user: UserRow; onClose: () => void }): React.JSX.Element {
  const toast = useToasts()
  const queryClient = useQueryClient()
  const [busy, setBusy] = useState(false)

  const submit = async (): Promise<void> => {
    setBusy(true)
    try {
      await api.users.deactivate(user.id)
      await queryClient.invalidateQueries({ queryKey: ['users'] })
      toast.push('success', `${user.name} deactivated`)
      onClose()
    } catch (err) {
      // Surfaces server-side refusals verbatim, e.g. "Cannot deactivate the last active owner".
      toast.push('error', (err as Error).message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <Modal title="Deactivate user" onClose={onClose}>
      <p className="text-detail text-ink">Deactivate {user.name}? They will no longer be able to sign in.</p>
      <div className="mt-5 flex justify-end gap-2">
        <Button onClick={onClose}>Cancel</Button>
        <Button variant="danger" disabled={busy} onClick={() => void submit()}>
          {busy ? 'Deactivating…' : 'Deactivate'}
        </Button>
      </div>
    </Modal>
  )
}

/**
 * Lock the books when nobody is at the machine.
 *
 * A laptop left open on a counter shows every customer's balance, every supplier's price and
 * every salary in the payroll. The lock screen already exists and is one click away, which means
 * it protects nothing at the moment it matters: when someone walks away without thinking about
 * it.
 *
 * Stored per machine rather than per company: it is about the desk this app is open on, and
 * someone with two companies wants the same answer for both.
 */
function AutoLockSetting({ hasUsers }: { hasUsers: boolean }): React.JSX.Element {
  const [minutes, setMinutes] = useStickyNumber('auto-lock-minutes', 0)

  return (
    <Panel className="mt-4 p-4">
      <Field
        label="Lock automatically after"
        hint={
          hasUsers
            ? 'Applies to this machine. ⌘⇧L (Ctrl+Shift+L) locks immediately, from any screen.'
            : 'Add a user first — without one there is no lock screen to fall back to, and locking would strand you behind a PIN you never set.'
        }
      >
        <Select
          data-testid="select-auto-lock"
          className="w-48"
          value={minutes}
          disabled={!hasUsers}
          onChange={(e) => setMinutes(Number(e.target.value))}
        >
          {AUTO_LOCK_OPTIONS.map((m) => (
            <option key={m} value={m}>
              {m === 0 ? 'Never' : `${m} minutes`}
            </option>
          ))}
        </Select>
      </Field>
    </Panel>
  )
}
