import { randomUUID } from "crypto";
import { z } from "zod";
import { authLoginSchema, userInputSchema } from "@shared/schemas";
import type { OpenCompany, IpcHandle } from "./types";
import type { Role } from "../services/roles";
import * as usersService from "../services/users";
import * as controlsService from "../services/internalControls";
import { writeAudit as writeAuditRow } from "../services/audit";

export interface SessionUser {
  id: number;
  name: string;
  role: Role;
}

interface AuthHandlerContext {
  handle: IpcHandle;
  requireCompany: () => OpenCompany;
  getCurrentCompany: () => OpenCompany | null;
  getSessionUser: () => SessionUser | null;
  getSessionToken: () => string | null;
  setSessionUser: (user: SessionUser | null) => void;
  setSessionToken: (token: string | null) => void;
  createSessionToken?: () => string;
  users?: Pick<
    typeof usersService,
    | "listLoginNames"
    | "login"
    | "listUsers"
    | "getUser"
    | "saveUser"
    | "usersExist"
    | "deactivateUser"
  >;
  controls?: Pick<typeof controlsService, "openSession" | "closeSession">;
  writeAudit?: typeof writeAuditRow;
}

const idSchema = z.object({ id: z.number().int().positive() });

/** Register the authentication and owner-only user-management surface. */
export function registerAuthHandlers({
  handle,
  requireCompany,
  getCurrentCompany,
  getSessionUser,
  getSessionToken,
  setSessionUser,
  setSessionToken,
  createSessionToken = randomUUID,
  users = usersService,
  controls = controlsService,
  writeAudit = writeAuditRow,
}: AuthHandlerContext): void {
  // auth:* is deliberately ungated by ipc.ts: callers must be able to sign in before a
  // session exists. users:* remains owner-only, while the central gate permits the first
  // owner to be bootstrapped when a new company has no users yet.
  handle("auth:users", () => users.listLoginNames(requireCompany().db));
  handle("auth:login", (payload) => {
    const { userId, pin } = authLoginSchema.parse(payload);
    const company = requireCompany();
    const result = users.login(company.db, userId, pin);
    const previousToken = getSessionToken();
    if (previousToken)
      controls.closeSession(company.db, previousToken, "locked");
    setSessionUser(result);
    const token = createSessionToken();
    setSessionToken(token);
    controls.openSession(company.db, result.id, token);
    return result;
  });
  handle("auth:logout", () => {
    const company = getCurrentCompany();
    const user = getSessionUser();
    if (company && user) {
      writeAudit(company.db, "user", user.id, "logout", null, null);
      const token = getSessionToken();
      if (token) controls.closeSession(company.db, token, "signed_out");
    }
    setSessionUser(null);
    setSessionToken(null);
    return null;
  });
  handle("auth:current", () => getSessionUser());

  handle("users:list", () => users.listUsers(requireCompany().db), "owner");
  handle(
    "users:save",
    (payload) => {
      const { data, id } = z
        .object({
          data: userInputSchema,
          id: z.number().int().positive().optional(),
        })
        .parse(payload);
      const company = requireCompany();
      const bootstrap = id === undefined && !company.usersExist;
      const before = id ? users.getUser(company.db, id) : null;
      const saved = users.saveUser(company.db, data, id);
      company.usersExist = users.usersExist(company.db);
      if (bootstrap) {
        setSessionUser({ id: saved.id, name: saved.name, role: saved.role });
        const token = createSessionToken();
        setSessionToken(token);
        controls.openSession(company.db, saved.id, token);
      }
      writeAudit(
        company.db,
        "user",
        saved.id,
        id ? "update" : "create",
        before,
        saved,
      );
      return { ...saved, locked: company.usersExist && !getSessionUser() };
    },
    "owner",
  );
  handle(
    "users:deactivate",
    (payload) => {
      const { id } = idSchema.parse(payload);
      const company = requireCompany();
      const before = users.getUser(company.db, id);
      users.deactivateUser(company.db, id);
      company.usersExist = users.usersExist(company.db);
      writeAudit(company.db, "user", id, "update", before, {
        ...before,
        active: false,
      });
      return null;
    },
    "owner",
  );
}
