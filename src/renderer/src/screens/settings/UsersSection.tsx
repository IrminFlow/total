import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api, type Role, type UserRow } from "../../lib/client";
import { useSession, useToasts } from "../../state/stores";
import {
  Button,
  EmptyState,
  Field,
  Modal,
  Panel,
  SectionTitle,
  Select,
  TextInput,
} from "../../components/ui";

const ROLES: Role[] = ["owner", "accountant", "viewer"];

export function UsersSection(): React.JSX.Element {
  const { user, setUser } = useSession();
  const isOwner = user?.role === "owner";
  // users:list/save/deactivate are owner-gated server-side, EXCEPT while the company has zero
  // users at all — that gate is off entirely then (see ipc.ts's UNGATED_CHANNELS / `usersExist`
  // check), which is how the bootstrap-owner flow (user == null) reaches this screen and query.
  // A signed-in non-owner (accountant/viewer) would just get "You do not have permission" back,
  // so don't even fire the query for them — show the same message the server would.
  const canManage = user == null || isOwner;
  const { data } = useQuery({
    queryKey: ["users"],
    queryFn: api.users.list,
    enabled: canManage,
  });
  const toast = useToasts();
  const queryClient = useQueryClient();
  const [adding, setAdding] = useState(false);
  const [editing, setEditing] = useState<UserRow | null>(null);
  const [deactivating, setDeactivating] = useState<UserRow | null>(null);
  const rows = data ?? [];
  const bootstrap = rows.length === 0;

  if (!canManage) {
    return (
      <div>
        <SectionTitle>Users</SectionTitle>
        <div className="rounded-md border border-blue/40 bg-blue/10 px-3.5 py-2.5 text-[12.5px] text-blue">
          Only the owner can manage users. Ask an owner to sign in to add, edit
          or deactivate accounts.
        </div>
      </div>
    );
  }

  return (
    <div>
      <SectionTitle
        right={
          <Button
            variant="primary"
            data-testid="btn-users-add"
            onClick={() => setAdding(true)}
          >
            Add user
          </Button>
        }
      >
        Users
      </SectionTitle>
      <Panel>
        {rows.length === 0 ? (
          <EmptyState
            title="No users yet"
            hint="Add the first user to enable sign-in and role-based access."
          />
        ) : (
          <table className="ledger-table">
            <thead>
              <tr>
                <th>Name</th>
                <th className="w-28">Role</th>
                <th className="w-24">Status</th>
                <th className="w-40">Access window</th>
                <th className="r w-32"></th>
              </tr>
            </thead>
            <tbody>
              {rows.map((u) => (
                <tr key={u.id}>
                  <td>{u.name}</td>
                  <td className="capitalize">{u.role}</td>
                  <td>
                    <span
                      className={`rounded-full border px-2 py-0.5 text-[11px] ${
                        u.active
                          ? "border-dr/40 text-dr"
                          : "border-line text-muted"
                      }`}
                    >
                      {u.active ? "Active" : "Inactive"}
                    </span>
                  </td>
                  <td className="num text-[11px] text-muted">
                    {u.accessExpiresAt
                      ? `Until ${new Date(u.accessExpiresAt).toLocaleString("en-IN", { dateStyle: "medium", timeStyle: "short" })}`
                      : "Permanent"}
                  </td>
                  <td className="r whitespace-nowrap">
                    <button
                      className="mr-2 text-[12px] text-blue hover:underline"
                      onClick={() => setEditing(u)}
                    >
                      Edit
                    </button>
                    {u.active && (
                      <button
                        className="text-[12px] text-cr hover:underline"
                        onClick={() => setDeactivating(u)}
                      >
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

      {(adding || editing) && (
        <UserModal
          existing={editing}
          bootstrap={bootstrap}
          onClose={() => {
            setAdding(false);
            setEditing(null);
          }}
          onSaved={(saved) => {
            void queryClient.invalidateQueries({ queryKey: ["users"] });
            // Bootstrap owner creation auto-signs the caller in (see ipc.ts's users:save) — the
            // renderer session must catch up so the Shell chip and role gates work immediately.
            if (!user && !saved.locked)
              setUser({ id: saved.id, name: saved.name, role: saved.role });
          }}
        />
      )}
      {deactivating && (
        <DeactivateModal
          user={deactivating}
          onClose={() => setDeactivating(null)}
        />
      )}
    </div>
  );
}

function UserModal({
  existing,
  bootstrap,
  onClose,
  onSaved,
}: {
  existing: UserRow | null;
  bootstrap: boolean;
  onClose: () => void;
  onSaved: (result: UserRow & { locked: boolean }) => void;
}): React.JSX.Element {
  const toast = useToasts();
  const [name, setName] = useState(existing?.name ?? "");
  const [role, setRole] = useState<Role>(
    existing?.role ?? (bootstrap ? "owner" : "accountant"),
  );
  const [active, setActive] = useState(existing?.active ?? true);
  const [accessExpiresAt, setAccessExpiresAt] = useState(
    existing?.accessExpiresAt?.slice(0, 16) ?? "",
  );
  const [pin, setPin] = useState("");
  const [pin2, setPin2] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const pinRequired = !existing;
  const pinProvided = pin.length > 0;
  const pinOk = pinRequired
    ? /^\d{4,12}$/.test(pin)
    : pin === "" || /^\d{4,12}$/.test(pin);

  const submit = async (): Promise<void> => {
    if (!name.trim()) return setError("Name is required");
    if (!pinOk) return setError("PIN must be 4-12 digits");
    if ((pinRequired || pinProvided) && pin !== pin2)
      return setError("PINs do not match");
    setBusy(true);
    try {
      const result = await api.users.save(
        {
          name: name.trim(),
          role,
          active,
          pin: pin || undefined,
          accessExpiresAt: accessExpiresAt
            ? new Date(accessExpiresAt).toISOString()
            : null,
        },
        existing?.id,
      );
      toast.push("success", existing ? "User updated" : "User added");
      onSaved(result);
      onClose();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      title={existing ? `Edit ${existing.name}` : "Add user"}
      onClose={onClose}
    >
      <div className="flex flex-col gap-3">
        <Field label="Name" error={error}>
          <TextInput
            value={name}
            onChange={(e) => {
              setName(e.target.value);
              setError(null);
            }}
            autoFocus
          />
        </Field>
        <Field
          label="Role"
          hint={
            bootstrap
              ? "The first user of a company is always the owner."
              : undefined
          }
        >
          <Select
            value={role}
            onChange={(e) => setRole(e.target.value as Role)}
            disabled={bootstrap}
          >
            {ROLES.map((r) => (
              <option key={r} value={r}>
                {r}
              </option>
            ))}
          </Select>
        </Field>
        <Field
          label="Access expires"
          hint="Optional. Use this for visiting accountants or auditors; expired users disappear from sign-in automatically."
        >
          <TextInput
            type="datetime-local"
            value={accessExpiresAt}
            min={new Date().toISOString().slice(0, 16)}
            onChange={(e) => setAccessExpiresAt(e.target.value)}
            disabled={bootstrap || role === "owner"}
          />
        </Field>
        <Field
          label={
            existing
              ? "New PIN (leave blank to keep current)"
              : "PIN (4-12 digits)"
          }
        >
          <TextInput
            type="password"
            inputMode="numeric"
            value={pin}
            onChange={(e) => {
              setPin(e.target.value.replace(/\D/g, "").slice(0, 12));
              setError(null);
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
                setPin2(e.target.value.replace(/\D/g, "").slice(0, 12));
                setError(null);
              }}
            />
          </Field>
        )}
        {existing && (
          <Field label="Status">
            <Select
              value={active ? "1" : "0"}
              onChange={(e) => setActive(e.target.value === "1")}
            >
              <option value="1">Active</option>
              <option value="0">Inactive</option>
            </Select>
          </Field>
        )}
      </div>
      <div className="mt-5 flex justify-end gap-2">
        <Button onClick={onClose}>Cancel</Button>
        <Button
          variant="primary"
          data-testid="btn-users-save"
          disabled={busy}
          onClick={() => void submit()}
        >
          {busy ? "Saving…" : existing ? "Save" : "Add user"}
        </Button>
      </div>
    </Modal>
  );
}

function DeactivateModal({
  user,
  onClose,
}: {
  user: UserRow;
  onClose: () => void;
}): React.JSX.Element {
  const toast = useToasts();
  const queryClient = useQueryClient();
  const [busy, setBusy] = useState(false);

  const submit = async (): Promise<void> => {
    setBusy(true);
    try {
      await api.users.deactivate(user.id);
      await queryClient.invalidateQueries({ queryKey: ["users"] });
      toast.push("success", `${user.name} deactivated`);
      onClose();
    } catch (err) {
      // Surfaces server-side refusals verbatim, e.g. "Cannot deactivate the last active owner".
      toast.push("error", (err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal title="Deactivate user" onClose={onClose}>
      <p className="text-[13px] text-ink">
        Deactivate {user.name}? They will no longer be able to sign in.
      </p>
      <div className="mt-5 flex justify-end gap-2">
        <Button onClick={onClose}>Cancel</Button>
        <Button variant="danger" disabled={busy} onClick={() => void submit()}>
          {busy ? "Deactivating…" : "Deactivate"}
        </Button>
      </div>
    </Modal>
  );
}
