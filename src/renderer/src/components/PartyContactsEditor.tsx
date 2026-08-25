import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { EnvelopeSimple, Phone, Plus, Star } from "@phosphor-icons/react";
import type { PartyContact } from "@shared/communications";
import { api } from "../lib/client";
import { useToasts } from "../state/stores";
import { confirmDialog } from "../lib/dialogs";
import { Button, EmptyState, Field, TextInput } from "./ui";

interface ContactDraft {
  name: string;
  role: string;
  email: string;
  phone: string;
  isPrimary: boolean;
  active: boolean;
}

const emptyDraft = (): ContactDraft => ({
  name: "",
  role: "",
  email: "",
  phone: "",
  isPrimary: false,
  active: true,
});

const fromContact = (contact: PartyContact): ContactDraft => ({
  name: contact.name,
  role: contact.role,
  email: contact.email ?? "",
  phone: contact.phone ?? "",
  isPrimary: contact.isPrimary,
  active: contact.active,
});

export function PartyContactsEditor({ ledgerId }: { ledgerId: number }): React.JSX.Element {
  const toast = useToasts();
  const queryClient = useQueryClient();
  const [includeInactive, setIncludeInactive] = useState(false);
  const [editingId, setEditingId] = useState<number | "new" | null>(null);
  const [draft, setDraft] = useState<ContactDraft>(emptyDraft);
  const contacts = useQuery({
    queryKey: ["partyContacts", ledgerId, includeInactive],
    queryFn: () => api.communications.contacts.list(ledgerId, includeInactive),
  });

  const refresh = async (): Promise<void> => {
    await queryClient.invalidateQueries({ queryKey: ["partyContacts", ledgerId] });
  };

  const begin = (contact?: PartyContact): void => {
    setEditingId(contact?.id ?? "new");
    setDraft(contact ? fromContact(contact) : emptyDraft());
  };

  const save = async (): Promise<void> => {
    if (!draft.name.trim()) return void toast.push("error", "Enter the contact's name");
    if (!draft.email.trim() && !draft.phone.trim()) {
      return void toast.push("error", "Add an email address or phone number");
    }
    try {
      await api.communications.contacts.save(
        {
          ledgerId,
          name: draft.name.trim(),
          role: draft.role.trim(),
          email: draft.email.trim().toLowerCase() || null,
          phone: draft.phone.trim() || null,
          isPrimary: draft.isPrimary,
          active: draft.active,
        },
        editingId === "new" ? undefined : editingId ?? undefined,
      );
      await refresh();
      setEditingId(null);
      toast.push("success", editingId === "new" ? "Contact added" : "Contact updated");
    } catch (error) {
      toast.push("error", error instanceof Error ? error.message : String(error));
    }
  };

  const remove = async (contact: PartyContact): Promise<void> => {
    const confirmed = await confirmDialog({
      title: "Delete contact",
      message: `Delete ${contact.name} from this ledger? Message history will remain intact.`,
      confirmLabel: "Delete",
      danger: true,
    });
    if (!confirmed) return;
    try {
      await api.communications.contacts.remove(contact.id);
      await refresh();
      toast.push("success", "Contact deleted");
    } catch (error) {
      toast.push("error", error instanceof Error ? error.message : String(error));
    }
  };

  return (
    <section className="rounded-lg border border-line bg-panel2/45 p-3" data-testid="party-contacts-editor">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <h3 className="text-[12.5px] font-semibold">People at this business</h3>
          <p className="mt-0.5 text-[10px] text-muted">
            Keep billing, accounts and delivery contacts separate.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <label className="flex items-center gap-1.5 text-[10px] text-muted">
            <input
              type="checkbox"
              checked={includeInactive}
              onChange={(event) => setIncludeInactive(event.target.checked)}
            />
            Show inactive
          </label>
          <Button onClick={() => begin()} data-testid="btn-contact-add">
            <Plus size={13} className="mr-1 inline" /> Add contact
          </Button>
        </div>
      </div>

      {contacts.isLoading ? (
        <p className="py-5 text-center text-[11px] text-muted" role="status">Loading contacts…</p>
      ) : contacts.isError ? (
        <div className="mt-3 rounded-md border border-cr/30 bg-cr/5 px-3 py-2 text-[11px] text-cr" role="alert">
          Contacts could not be loaded. {contacts.error instanceof Error ? contacts.error.message : "Try again."}
        </div>
      ) : contacts.data?.length ? (
        <div className="mt-3 grid gap-1.5">
          {contacts.data.map((contact) => (
            <div
              key={contact.id}
              className={`flex items-center gap-3 rounded-md border px-3 py-2 ${contact.active ? "border-line bg-panel" : "border-line/70 bg-panel/40 opacity-70"}`}
            >
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-1.5">
                  <p className="truncate text-[11.5px] font-semibold">{contact.name}</p>
                  {contact.isPrimary && <Star size={12} weight="fill" className="shrink-0 text-amber" aria-label="Primary contact" />}
                  {!contact.active && <span className="text-[9px] text-muted">Inactive</span>}
                </div>
                <p className="mt-0.5 truncate text-[9.5px] text-muted">{contact.role || "No role set"}</p>
              </div>
              <div className="hidden min-w-0 max-w-[44%] gap-3 text-[9.5px] text-muted sm:flex">
                {contact.email && <span className="truncate"><EnvelopeSimple size={12} className="mr-1 inline" />{contact.email}</span>}
                {contact.phone && <span className="whitespace-nowrap"><Phone size={12} className="mr-1 inline" />{contact.phone}</span>}
              </div>
              <Button variant="ghost" onClick={() => begin(contact)}>Edit</Button>
              <Button variant="ghost" className="!text-cr" onClick={() => void remove(contact)}>Delete</Button>
            </div>
          ))}
        </div>
      ) : (
        <EmptyState title="No contacts yet" hint="Add the person who should receive invoices or statements." />
      )}

      {editingId !== null && (
        <div className="mt-3 rounded-md border border-amber/35 bg-panel p-3" data-testid="contact-form">
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Contact name">
              <TextInput autoFocus value={draft.name} onChange={(event) => setDraft((value) => ({ ...value, name: event.target.value }))} />
            </Field>
            <Field label="Role or department">
              <TextInput value={draft.role} onChange={(event) => setDraft((value) => ({ ...value, role: event.target.value }))} placeholder="Accounts payable" />
            </Field>
            <Field label="Email">
              <TextInput type="email" value={draft.email} onChange={(event) => setDraft((value) => ({ ...value, email: event.target.value }))} placeholder="accounts@example.com" />
            </Field>
            <Field label="Phone">
              <TextInput value={draft.phone} onChange={(event) => setDraft((value) => ({ ...value, phone: event.target.value }))} placeholder="+91 98765 43210" />
            </Field>
          </div>
          <div className="mt-3 flex flex-wrap items-center justify-between gap-2">
            <div className="flex gap-4 text-[10.5px] text-muted">
              <label className="flex items-center gap-1.5">
                <input type="checkbox" checked={draft.isPrimary} onChange={(event) => setDraft((value) => ({ ...value, isPrimary: event.target.checked }))} /> Primary contact
              </label>
              <label className="flex items-center gap-1.5">
                <input type="checkbox" checked={draft.active} onChange={(event) => setDraft((value) => ({ ...value, active: event.target.checked }))} /> Active
              </label>
            </div>
            <div className="flex gap-2">
              <Button onClick={() => setEditingId(null)}>Cancel</Button>
              <Button variant="primary" data-testid="btn-contact-save" onClick={() => void save()}>Save contact</Button>
            </div>
          </div>
        </div>
      )}
    </section>
  );
}
