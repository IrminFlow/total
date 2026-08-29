import { describe, expect, it, vi } from "vitest";
import { registerAuthHandlers, type SessionUser } from "./authHandlers";
import type { IpcHandle, IpcHandler, OpenCompany } from "./types";

function setup(options: { usersExist?: boolean; signedIn?: boolean } = {}) {
  const events: string[] = [];
  const handlers = new Map<string, IpcHandler>();
  const handle: IpcHandle = (channel, handler) =>
    handlers.set(channel, handler);
  const company = {
    slug: "books",
    db: {},
    info: {},
    usersExist: options.usersExist ?? true,
  } as OpenCompany;
  let sessionUser: SessionUser | null = options.signedIn
    ? { id: 7, name: "Old owner", role: "owner" }
    : null;
  let sessionToken: string | null = options.signedIn ? "old-token" : null;
  const saved = {
    id: 8,
    name: "Asha",
    role: "accountant" as const,
    active: true,
    createdAt: "2026-08-25T00:00:00.000Z",
    accessExpiresAt: null,
  };
  const users = {
    listLoginNames: vi.fn(() => []),
    login: vi.fn(() => {
      events.push("login");
      return { id: 8, name: "Asha", role: "accountant" as const };
    }),
    listUsers: vi.fn(() => []),
    getUser: vi.fn(() => saved),
    saveUser: vi.fn(() => {
      events.push("save-user");
      return saved;
    }),
    usersExist: vi.fn(() => true),
    deactivateUser: vi.fn(),
  };
  const controls = {
    closeSession: vi.fn((_db, token, reason) => {
      events.push(`close:${String(token)}:${String(reason)}`);
    }),
    openSession: vi.fn((_db, id, token) => {
      events.push(`open:${String(id)}:${String(token)}`);
    }),
  };
  const writeAudit = vi.fn((_db, _entity, _id, action) => {
    events.push(`audit:${String(action)}`);
  });
  registerAuthHandlers({
    handle,
    requireCompany: () => company,
    getCurrentCompany: () => company,
    getSessionUser: () => sessionUser,
    getSessionToken: () => sessionToken,
    setSessionUser: (user) => {
      events.push(`set-user:${user?.id ?? "null"}`);
      sessionUser = user;
    },
    setSessionToken: (token) => {
      events.push(`set-token:${token ?? "null"}`);
      sessionToken = token;
    },
    createSessionToken: () => "new-token",
    users: users as never,
    controls: controls as never,
    writeAudit: writeAudit as never,
  });
  return {
    handlers,
    company,
    users,
    controls,
    writeAudit,
    events,
    session: () => ({ sessionUser, sessionToken }),
  };
}

describe("auth and user IPC handlers", () => {
  it("validates login before touching company state and rotates the session in order", () => {
    let companyReads = 0;
    const test = setup({ signedIn: true });
    const originalLogin = test.handlers.get("auth:login")!;
    const handlers = new Map<string, IpcHandler>();
    registerAuthHandlers({
      handle: (channel, handler) => handlers.set(channel, handler),
      requireCompany: () => {
        companyReads += 1;
        return test.company;
      },
      getCurrentCompany: () => test.company,
      getSessionUser: () => test.session().sessionUser,
      getSessionToken: () => test.session().sessionToken,
      setSessionUser: () => undefined,
      setSessionToken: () => undefined,
      users: test.users as never,
      controls: test.controls as never,
      writeAudit: test.writeAudit as never,
    });
    expect(() =>
      handlers.get("auth:login")!({ userId: 0, pin: "1" }),
    ).toThrow();
    expect(companyReads).toBe(0);

    originalLogin({ userId: 8, pin: "1234" });
    expect(test.events).toEqual([
      "login",
      "close:old-token:locked",
      "set-user:8",
      "set-token:new-token",
      "open:8:new-token",
    ]);
  });

  it("bootstraps the first owner session before auditing the created user", () => {
    const test = setup({ usersExist: false });
    const result = test.handlers.get("users:save")!({
      data: { name: "Asha", role: "viewer", pin: "1234" },
    });

    expect(test.events).toEqual([
      "save-user",
      "set-user:8",
      "set-token:new-token",
      "open:8:new-token",
      "audit:create",
    ]);
    expect(test.company.usersExist).toBe(true);
    expect(result).toMatchObject({ id: 8, locked: false });
  });

  it("audits and closes a live session before clearing it on logout", () => {
    const test = setup({ signedIn: true });
    expect(test.handlers.get("auth:logout")!(undefined)).toBeNull();
    expect(test.events).toEqual([
      "audit:logout",
      "close:old-token:signed_out",
      "set-user:null",
      "set-token:null",
    ]);
    expect(test.session()).toEqual({ sessionUser: null, sessionToken: null });
  });

  it("keeps user mutations owner-only and validates ids before service calls", () => {
    const test = setup();
    expect(() => test.handlers.get("users:deactivate")!({ id: 0 })).toThrow();
    expect(test.users.getUser).not.toHaveBeenCalled();
    expect(test.users.deactivateUser).not.toHaveBeenCalled();
  });
});
