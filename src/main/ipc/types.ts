import type { CompanyInfo } from "@shared/domain";
import type { DB } from "../db/connection";
import type { Role } from "../services/roles";

export interface CompanyContext {
  slug: string;
  db: DB;
  info: CompanyInfo;
}

export interface OpenCompany extends CompanyContext {
  /** Cached usersExist(db), refreshed when the company or its user roster changes. */
  usersExist: boolean;
}

export type IpcHandler = (payload: unknown) => unknown | Promise<unknown>;

/** Every domain registrar receives this wrapper; none registers with Electron directly. */
export type IpcHandle = (
  channel: string,
  handler: IpcHandler,
  minRole?: Role,
) => void;
