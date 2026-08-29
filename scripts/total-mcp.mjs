#!/usr/bin/env node
import {
  appendFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { createConnection } from "node:net";
import { basename, dirname, extname, join, resolve, sep } from "node:path";
import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import { fileURLToPath } from "node:url";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const CONTRACT_VERSION = 1;
const PRODUCT_VERSION =
  process.env.TOTAL_APP_VERSION ||
  (typeof __TOTAL_APP_VERSION__ !== "undefined"
    ? __TOTAL_APP_VERSION__
    : "5.0.0");
const root = resolve(
  process.env.TOTAL_DATA_DIR || join(homedir(), "Documents", "total"),
);
const scriptDir = dirname(fileURLToPath(import.meta.url));
const registryPath = join(root, "total.json");
const accessPath = join(root, "mcp-access.json");
const safetyPath = join(root, "device-safety.json");
const clientName = (process.env.TOTAL_MCP_CLIENT || "local-mcp-client").slice(
  0,
  80,
);

const SCOPES = [
  "companies:list",
  "mirror:read",
  "attachment:read",
  "proposal:create",
  "proposal:read",
  "proposal:discard",
  "mirror:refresh",
];
const ERROR_CODES = {
  AUTH_REQUIRED:
    "Set TOTAL_MCP_TOKEN to a token issued in Total > Settings > Agent access.",
  AUTH_INVALID: "The supplied token is not recognized.",
  TOKEN_EXPIRED: "The supplied token has expired.",
  TOKEN_REVOKED: "The supplied token was revoked.",
  SCOPE_DENIED: "The token does not grant the scope required by this tool.",
  COMPANY_DENIED: "The token is constrained to a different company.",
  COMPANY_NOT_FOUND: "The token company is no longer registered in Total.",
  MCP_DISABLED: "Local MCP access is disabled in Total on this device.",
  APP_UNAVAILABLE: "Total must be running to authorize MCP access.",
  APP_SESSION_REQUIRED: "Open the paired company and sign in to Total.",
  COMPANY_INACTIVE: "The token's company is not the active company in Total.",
  ROLE_DENIED: "The current Total user role cannot perform this MCP operation.",
  MIRROR_MISSING:
    "Generate or approve a refresh of the company mirror in Total.",
  INVALID_RESOURCE: "The requested file or view is not allowed.",
  RESOURCE_LIMIT: "The requested resource exceeds the MCP safety limit.",
  INTERNAL_ERROR: "The tool failed without exposing local paths or secrets.",
};

const CONTRACT = {
  contract: "total.mcp",
  contractVersion: CONTRACT_VERSION,
  productVersion: PRODUCT_VERSION,
  transport: "stdio",
  requiresRunningApp: true,
  moneyUnit: "integer paise",
  quantityUnit: "integer thousandths",
  mirrorSchemaVersions: [1, 2],
  scopes: SCOPES,
  tools: {
    get_capabilities: { scope: null, mutatesBooks: false },
    list_companies: { scope: "companies:list", mutatesBooks: false },
    get_mirror_status: { scope: "mirror:read", mutatesBooks: false },
    get_book_snapshot: { scope: "mirror:read", mutatesBooks: false },
    search_books: { scope: "mirror:read", mutatesBooks: false },
    get_voucher: { scope: "mirror:read", mutatesBooks: false },
    get_ledger: { scope: "mirror:read", mutatesBooks: false },
    run_report: { scope: "mirror:read", mutatesBooks: false },
    list_outstandings: { scope: "mirror:read", mutatesBooks: false },
    list_exceptions: { scope: "mirror:read", mutatesBooks: false },
    read_attachment: { scope: "attachment:read", mutatesBooks: false },
    request_mirror_refresh: {
      scope: "mirror:refresh",
      mutatesBooks: false,
      requiresHumanApproval: true,
    },
    propose_voucher: {
      scope: "proposal:create",
      mutatesBooks: false,
      requiresHumanApproval: true,
    },
    propose_master_change: {
      scope: "proposal:create",
      mutatesBooks: false,
      requiresHumanApproval: true,
    },
    validate_proposal: { scope: "proposal:create", mutatesBooks: false },
    list_proposals: { scope: "proposal:read", mutatesBooks: false },
    discard_proposal: { scope: "proposal:discard", mutatesBooks: false },
  },
  errors: ERROR_CODES,
};

class ContractError extends Error {
  constructor(code, message, retryable = false) {
    super(message);
    this.code = code;
    this.retryable = retryable;
  }
}

function registry() {
  try {
    const value = JSON.parse(readFileSync(registryPath, "utf8"));
    return Array.isArray(value.companies) ? value : { companies: [] };
  } catch {
    return { companies: [] };
  }
}

function readAccess() {
  try {
    if (statSync(accessPath).size > 1024 * 1024)
      throw new ContractError(
        "RESOURCE_LIMIT",
        "MCP access configuration is too large.",
      );
    const parsed = JSON.parse(readFileSync(accessPath, "utf8"));
    return parsed.version === 1 && Array.isArray(parsed.tokens)
      ? parsed.tokens
      : [];
  } catch (error) {
    if (error instanceof ContractError) throw error;
    return [];
  }
}

function mcpAccessEnabled() {
  try {
    const parsed = JSON.parse(readFileSync(safetyPath, "utf8"));
    return parsed?.mcpAccess === true;
  } catch {
    return false;
  }
}

function sameHash(left, right) {
  const a = Buffer.from(left, "hex");
  const b = Buffer.from(right, "hex");
  return a.length === b.length && a.length > 0 && timingSafeEqual(a, b);
}

function authorize(scope, requestedCompany) {
  if (!mcpAccessEnabled())
    throw new ContractError("MCP_DISABLED", ERROR_CODES.MCP_DISABLED);
  const supplied = process.env.TOTAL_MCP_TOKEN;
  if (!supplied)
    throw new ContractError("AUTH_REQUIRED", ERROR_CODES.AUTH_REQUIRED);
  const hash = createHash("sha256").update(supplied).digest("hex");
  const token = readAccess().find((candidate) =>
    sameHash(candidate.tokenHash || "", hash),
  );
  if (!token) throw new ContractError("AUTH_INVALID", ERROR_CODES.AUTH_INVALID);
  if (token.revokedAt)
    throw new ContractError("TOKEN_REVOKED", ERROR_CODES.TOKEN_REVOKED);
  if (!token.expiresAt || Date.parse(token.expiresAt) <= Date.now())
    throw new ContractError("TOKEN_EXPIRED", ERROR_CODES.TOKEN_EXPIRED);
  if (!Array.isArray(token.scopes) || !token.scopes.includes(scope))
    throw new ContractError(
      "SCOPE_DENIED",
      `${ERROR_CODES.SCOPE_DENIED} Required: ${scope}.`,
    );
  if (requestedCompany && requestedCompany !== token.company)
    throw new ContractError("COMPANY_DENIED", ERROR_CODES.COMPANY_DENIED);
  if (!registry().companies.some((company) => company.slug === token.company))
    throw new ContractError("COMPANY_NOT_FOUND", ERROR_CODES.COMPANY_NOT_FOUND);
  return token;
}

function presenceEndpoint() {
  const suffix = createHash("sha256").update(root).digest("hex").slice(0, 24);
  return process.platform === "win32"
    ? `\\\\.\\pipe\\total-mcp-${suffix}`
    : join(tmpdir(), `total-mcp-${suffix}.sock`);
}

async function requireAppPresence(token, scope) {
  const nonce = randomUUID().replaceAll("-", "");
  const request = JSON.stringify({
    version: 1,
    nonce,
    tokenHash: token.tokenHash,
    company: token.company,
    scope,
  });
  const response = await new Promise((resolveResponse, rejectResponse) => {
    const socket = createConnection(presenceEndpoint());
    let body = "";
    let settled = false;
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      if (error) rejectResponse(error);
      else resolveResponse(value);
    };
    socket.setEncoding("utf8");
    socket.setTimeout(1_500, () => finish(new ContractError("APP_UNAVAILABLE", ERROR_CODES.APP_UNAVAILABLE, true)));
    socket.on("error", () => finish(new ContractError("APP_UNAVAILABLE", ERROR_CODES.APP_UNAVAILABLE, true)));
    socket.on("connect", () => socket.write(`${request}\n`));
    socket.on("data", (chunk) => {
      body += chunk;
      if (Buffer.byteLength(body) > 8 * 1024)
        return finish(new ContractError("APP_UNAVAILABLE", ERROR_CODES.APP_UNAVAILABLE, true));
      const newline = body.indexOf("\n");
      if (newline < 0) return;
      try { finish(null, JSON.parse(body.slice(0, newline))); }
      catch { finish(new ContractError("APP_UNAVAILABLE", ERROR_CODES.APP_UNAVAILABLE, true)); }
    });
  });
  if (response?.nonce !== nonce)
    throw new ContractError("APP_UNAVAILABLE", ERROR_CODES.APP_UNAVAILABLE, true);
  if (response.ok === true) return;
  const code = ["MCP_DISABLED", "APP_SESSION_REQUIRED", "COMPANY_INACTIVE", "ROLE_DENIED"].includes(response.code)
    ? response.code
    : "APP_UNAVAILABLE";
  throw new ContractError(code, ERROR_CODES[code], code === "APP_UNAVAILABLE");
}

function mirrorMeta(company) {
  const path = join(root, "companies", company, "agent", "meta.json");
  if (!existsSync(path))
    return {
      generatedAt: null,
      schemaVersion: null,
      ageSeconds: null,
      stale: true,
      files: [],
    };
  if (statSync(path).size > 1024 * 1024)
    throw new ContractError("RESOURCE_LIMIT", "Mirror metadata exceeds 1 MB.");
  const meta = JSON.parse(readFileSync(path, "utf8"));
  const generatedAt =
    typeof meta.generatedAt === "string" ? meta.generatedAt : null;
  const ageSeconds = generatedAt
    ? Math.max(0, Math.floor((Date.now() - Date.parse(generatedAt)) / 1000))
    : null;
  return {
    generationId:
      typeof meta.generationId === "string" ? meta.generationId : null,
    generatedAt,
    schemaVersion: Number.isInteger(meta.schemaVersion)
      ? meta.schemaVersion
      : null,
    ageSeconds,
    stale: ageSeconds === null || ageSeconds > 600,
    files: Array.isArray(meta.files)
      ? meta.files.filter((file) => typeof file === "string")
      : [],
    manifest:
      meta.manifest && meta.manifest.algorithm === "sha256"
        ? meta.manifest
        : null,
  };
}

function readMirror(company, file) {
  if (!/^[a-z0-9-]+\.json$/.test(file))
    throw new ContractError("INVALID_RESOURCE", ERROR_CODES.INVALID_RESOURCE);
  const path = join(root, "companies", company, "agent", file);
  if (!existsSync(path))
    throw new ContractError(
      "MIRROR_MISSING",
      `Mirror file ${file} is missing. ${ERROR_CODES.MIRROR_MISSING}`,
      true,
    );
  const entry = lstatSync(path);
  if (entry.isSymbolicLink() || !entry.isFile())
    throw new ContractError("INVALID_RESOURCE", ERROR_CODES.INVALID_RESOURCE);
  if (entry.size > 10 * 1024 * 1024)
    throw new ContractError(
      "RESOURCE_LIMIT",
      "Mirror file exceeds the 10 MB limit.",
    );
  return JSON.parse(readFileSync(path, "utf8"));
}

function voucherFiles(company) {
  const dir = join(root, "companies", company, "agent");
  if (!existsSync(dir))
    throw new ContractError("MIRROR_MISSING", ERROR_CODES.MIRROR_MISSING, true);
  const entry = lstatSync(dir);
  if (entry.isSymbolicLink() || !entry.isDirectory())
    throw new ContractError("INVALID_RESOURCE", ERROR_CODES.INVALID_RESOURCE);
  return readdirSync(dir)
    .filter((name) => /^vouchers-\d{4}-\d{2}\.json$/.test(name))
    .sort()
    .slice(0, 100);
}

function findVoucher(company, id) {
  for (const file of voucherFiles(company)) {
    const vouchers = readMirror(company, file);
    if (!Array.isArray(vouchers)) continue;
    const voucher = vouchers.find((row) => row && row.id === id);
    if (voucher) return { file, voucher };
  }
  return null;
}

function reportSnapshot(company, report) {
  const files = {
    trial_balance: "trial-balance.json",
    outstandings: "outstandings.json",
  };
  return readMirror(company, files[report]);
}

function boundedProposal(company, path, tokenId) {
  const companyRoot = join(root, "companies", company);
  const realCompany = realpathSync(companyRoot);
  const entry = lstatSync(path);
  if (entry.isSymbolicLink() || !entry.isFile() || entry.size > 512 * 1024)
    return null;
  const real = realpathSync(path);
  if (!real.startsWith(`${realCompany}${sep}`)) return null;
  try {
    const value = JSON.parse(readFileSync(real, "utf8"));
    return value?.version === 1 && value?.status === "pending" &&
      value?.source === "mcp" && value?.tokenId === tokenId
      ? value
      : null;
  } catch {
    return null;
  }
}

function secureProposalDirectory(company, child = null, create = false) {
  const companyRoot = join(root, "companies", company);
  const companyEntry = lstatSync(companyRoot);
  if (companyEntry.isSymbolicLink() || !companyEntry.isDirectory())
    throw new ContractError("INVALID_RESOURCE", "Company storage is not a regular directory.");
  const realCompany = realpathSync(companyRoot);
  const proposalRoot = join(companyRoot, "proposals");
  if (!existsSync(proposalRoot)) {
    if (!create) return null;
    mkdirSync(proposalRoot, { mode: 0o700 });
  }
  const rootEntry = lstatSync(proposalRoot);
  if (rootEntry.isSymbolicLink() || !rootEntry.isDirectory() || !realpathSync(proposalRoot).startsWith(`${realCompany}${sep}`))
    throw new ContractError("INVALID_RESOURCE", "Proposal storage is not a regular directory.");
  if (!child) return proposalRoot;
  if (!/^[a-z0-9-]+$/.test(child)) throw new ContractError("INVALID_RESOURCE", ERROR_CODES.INVALID_RESOURCE);
  const dir = join(proposalRoot, child);
  if (!existsSync(dir)) {
    if (!create) return null;
    mkdirSync(dir, { mode: 0o700 });
  }
  const entry = lstatSync(dir);
  if (entry.isSymbolicLink() || !entry.isDirectory() || !realpathSync(dir).startsWith(`${realCompany}${sep}`))
    throw new ContractError("INVALID_RESOURCE", "Proposal storage is not a regular directory.");
  return dir;
}

function listTokenProposals(company, tokenId) {
  const rootDir = secureProposalDirectory(company);
  if (!rootDir) return [];
  const candidates = [];
  const addDirectory = (dir, kind) => {
    if (!existsSync(dir) || candidates.length >= 200) return;
    const dirEntry = lstatSync(dir);
    if (dirEntry.isSymbolicLink() || !dirEntry.isDirectory()) return;
    for (const entry of readdirSync(dir, { withFileTypes: true }).slice(0, 400)) {
      if (candidates.length >= 200) break;
      if (!entry.isFile() || entry.isSymbolicLink() || !/^[a-zA-Z0-9._-]+\.json$/.test(entry.name)) continue;
      const proposal = boundedProposal(company, join(dir, entry.name), tokenId);
      if (proposal) candidates.push({ ...proposal, proposalKind: proposal.proposalKind || kind });
    }
  };
  addDirectory(rootDir, "voucher");
  const masterDir = secureProposalDirectory(company, "mcp-master");
  if (masterDir) addDirectory(masterDir, "master");
  return candidates
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id))
    .slice(0, 200);
}

function createMcpProposal(company, token, kind, summary, payload) {
  const serialized = JSON.stringify(payload);
  if (Buffer.byteLength(serialized) > 512 * 1024)
    throw new ContractError("RESOURCE_LIMIT", "Proposal exceeds 512 KB.");
  const rootDir = secureProposalDirectory(company, null, true);
  const dir = kind === "master" ? secureProposalDirectory(company, "mcp-master", true) : rootDir;
  const createdAt = new Date().toISOString();
  const id = `${createdAt.replace(/[:.]/g, "-")}-${randomUUID()}.json`;
  const proposal = {
    version: 1,
    id,
    createdAt,
    source: "mcp",
    tokenId: token.id,
    status: "pending",
    proposalKind: kind,
    summary,
    ...(kind === "voucher" ? { voucher: payload } : { masterChange: payload }),
  };
  writeFileSync(join(dir, id), JSON.stringify(proposal, null, 2), {
    flag: "wx",
    mode: 0o600,
  });
  return proposal;
}

function auditPath(company) {
  return join(root, "companies", company, "mcp", "audit.jsonl");
}

function audit(event) {
  if (!event.company || !/^[a-z0-9-]{1,80}$/.test(event.company)) return;
  const path = auditPath(event.company);
  mkdirSync(dirname(path), { recursive: true });
  try {
    if (existsSync(path) && statSync(path).size > 5 * 1024 * 1024) {
      const rotated = `${path}.1`;
      if (existsSync(rotated))
        renameSync(rotated, `${path}.${Date.now()}.archive`);
      renameSync(path, rotated);
    }
    appendFileSync(path, `${JSON.stringify(event)}\n`, { mode: 0o600 });
  } catch {
    // Audit is best-effort so a filesystem warning cannot corrupt the stdio protocol.
  }
}

function ok(value) {
  const payload = { contractVersion: CONTRACT_VERSION, ...value };
  return {
    content: [{ type: "text", text: JSON.stringify(payload, null, 2) }],
    structuredContent: payload,
  };
}

function fail(error) {
  const known = error instanceof ContractError;
  const payload = {
    contractVersion: CONTRACT_VERSION,
    error: {
      code: known ? error.code : "INTERNAL_ERROR",
      message: known ? error.message : ERROR_CODES.INTERNAL_ERROR,
      retryable: known ? error.retryable : false,
    },
  };
  return {
    isError: true,
    content: [{ type: "text", text: JSON.stringify(payload, null, 2) }],
    structuredContent: payload,
  };
}

async function scoped(tool, scope, args, operation) {
  let company = args.company || null;
  try {
    const token = authorize(scope, company);
    company = token.company;
    await requireAppPresence(token, scope);
    const value = await operation(company, token);
    audit({
      timestamp: new Date().toISOString(),
      client: clientName,
      tool,
      company,
      outcome: "allowed",
      proposalId: value?.proposalId || null,
      errorCode: null,
    });
    return ok(value);
  } catch (error) {
    const denied =
      error instanceof ContractError &&
      [
        "AUTH_REQUIRED",
        "AUTH_INVALID",
        "TOKEN_EXPIRED",
        "TOKEN_REVOKED",
        "SCOPE_DENIED",
        "COMPANY_DENIED",
      ].includes(error.code);
    audit({
      timestamp: new Date().toISOString(),
      client: clientName,
      tool,
      company: company || "unknown",
      outcome: denied ? "denied" : "error",
      proposalId: null,
      errorCode: error instanceof ContractError ? error.code : "INTERNAL_ERROR",
    });
    return fail(error);
  }
}

const companyInput = z.object({
  company: z
    .string()
    .regex(/^[a-z0-9-]{1,80}$/)
    .optional(),
});
const voucherProposalSchema = z.object({
  voucherTypeId: z.number().int().positive(),
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  narration: z.string().max(1000).optional(),
  lines: z.array(z.object({
    ledgerId: z.number().int().positive(),
    drCr: z.enum(["dr", "cr"]),
    amount: z.number().int().positive(),
  }).passthrough()).min(2).max(500),
}).passthrough();
const masterChangeSchema = z.object({
  entity: z.enum(["ledger", "item"]),
  operation: z.enum(["create", "update"]),
  targetId: z.number().int().positive().optional(),
  values: z.record(z.unknown()),
}).superRefine((value, context) => {
  if (value.operation === "update" && !value.targetId) {
    context.addIssue({ code: "custom", message: "targetId is required for update" });
  }
  if (Object.keys(value.values).length === 0) {
    context.addIssue({ code: "custom", message: "values must not be empty" });
  }
});

function validateProposal(kind, payload) {
  const result = (kind === "voucher" ? voucherProposalSchema : masterChangeSchema).safeParse(payload);
  const errors = result.success
    ? []
    : result.error.issues.map((issue) => ({ path: issue.path.join("."), message: issue.message }));
  if (result.success && kind === "voucher") {
    const debit = result.data.lines
      .filter((line) => line.drCr === "dr")
      .reduce((sum, line) => sum + line.amount, 0);
    const credit = result.data.lines
      .filter((line) => line.drCr === "cr")
      .reduce((sum, line) => sum + line.amount, 0);
    if (debit !== credit) errors.push({ path: "lines", message: `Debits ${debit} and credits ${credit} differ` });
  }
  return {
    valid: errors.length === 0,
    errors,
    databaseValidated: false,
    requiresAppValidation: true,
    posted: false,
  };
}
const server = new McpServer({
  name: "total-accounting",
  version: PRODUCT_VERSION,
});

server.registerTool(
  "get_capabilities",
  {
    title: "Describe Total MCP capabilities",
    description:
      "Return contract version, scopes, units, tools and stable error codes without reading company data.",
    inputSchema: z.object({}),
    annotations: { readOnlyHint: true },
  },
  async () => ok({ capabilities: CONTRACT }),
);

server.registerTool(
  "list_companies",
  {
    title: "List permitted Total companies",
    description: "List only the company bound to this scoped token.",
    inputSchema: z.object({}),
    annotations: { readOnlyHint: true },
  },
  async (args) =>
    scoped("list_companies", "companies:list", args, async (company) => ({
      companies: registry()
        .companies.filter((row) => row.slug === company)
        .map(({ slug, name, lastOpenedAt }) => ({
          slug,
          name,
          lastOpenedAt,
        })),
    })),
);

server.registerTool(
  "get_mirror_status",
  {
    title: "Check mirror freshness",
    description:
      "Return generated time, schema version, file manifest and staleness without refreshing anything.",
    inputSchema: companyInput,
    annotations: { readOnlyHint: true },
  },
  async (args) =>
    scoped("get_mirror_status", "mirror:read", args, async (company) => ({
      company,
      mirror: mirrorMeta(company),
    })),
);

server.registerTool(
  "get_book_snapshot",
  {
    title: "Read accounting snapshot",
    description:
      "Read a generated JSON mirror. Amounts are integer paise and results include freshness.",
    inputSchema: companyInput.extend({
      view: z.enum(["ledgers", "trial_balance", "outstandings", "meta"]),
    }),
    annotations: { readOnlyHint: true },
  },
  async (args) =>
    scoped("get_book_snapshot", "mirror:read", args, async (company) => {
      const files = {
        ledgers: "ledgers.json",
        trial_balance: "trial-balance.json",
        outstandings: "outstandings.json",
        meta: "meta.json",
      };
      return {
        company,
        view: args.view,
        mirror: mirrorMeta(company),
        data: readMirror(company, files[args.view]),
      };
    }),
);

server.registerTool(
  "search_books",
  {
    title: "Search Total mirrors",
    description:
      "Case-insensitive bounded search across ledgers and exported vouchers.",
    inputSchema: companyInput.extend({
      query: z.string().trim().min(2).max(120),
      limit: z.number().int().min(1).max(50).default(20),
    }),
    annotations: { readOnlyHint: true },
  },
  async (args) =>
    scoped("search_books", "mirror:read", args, async (company) => {
      const dir = join(root, "companies", company, "agent");
      if (!existsSync(dir))
        throw new ContractError(
          "MIRROR_MISSING",
          ERROR_CODES.MIRROR_MISSING,
          true,
        );
      const needle = args.query.toLowerCase();
      const matches = [];
      for (const file of readdirSync(dir)
        .filter(
          (name) => name === "ledgers.json" || /^vouchers-.*\.json$/.test(name),
        )
        .sort()) {
        if (matches.length >= args.limit) break;
        const rows = readMirror(company, file);
        for (const record of Array.isArray(rows) ? rows : [rows]) {
          if (JSON.stringify(record).toLowerCase().includes(needle))
            matches.push({ file, record });
          if (matches.length >= args.limit) break;
        }
      }
      return {
        company,
        query: args.query,
        mirror: mirrorMeta(company),
        matches,
      };
    }),
);

server.registerTool(
  "get_voucher",
  {
    title: "Get one voucher",
    description: "Read one voucher by stable database ID from the generated mirror.",
    inputSchema: companyInput.extend({ id: z.number().int().positive() }),
    annotations: { readOnlyHint: true },
  },
  async (args) => scoped("get_voucher", "mirror:read", args, async (company) => {
    const found = findVoucher(company, args.id);
    if (!found) throw new ContractError("INVALID_RESOURCE", "Voucher is not present in this mirror generation.");
    return { company, mirror: mirrorMeta(company), sourceFile: found.file, voucher: found.voucher };
  }),
);

server.registerTool(
  "get_ledger",
  {
    title: "Get one ledger",
    description: "Read one ledger by stable ID or exact case-insensitive name from the generated mirror.",
    inputSchema: companyInput.extend({
      id: z.number().int().positive().optional(),
      name: z.string().trim().min(1).max(200).optional(),
    }).superRefine((value, context) => {
      if ((value.id === undefined) === (value.name === undefined))
        context.addIssue({ code: "custom", message: "Provide exactly one of id or name" });
    }),
    annotations: { readOnlyHint: true },
  },
  async (args) => scoped("get_ledger", "mirror:read", args, async (company) => {
    const rows = readMirror(company, "ledgers.json");
    if (!Array.isArray(rows)) throw new ContractError("INVALID_RESOURCE", "Ledger mirror is invalid.");
    const ledger = args.id !== undefined
      ? rows.find((row) => row?.id === args.id)
      : rows.find((row) => typeof row?.name === "string" && row.name.toLowerCase() === args.name.toLowerCase());
    if (!ledger) throw new ContractError("INVALID_RESOURCE", "Ledger is not present in this mirror generation.");
    return { company, mirror: mirrorMeta(company), ledger };
  }),
);

server.registerTool(
  "run_report",
  {
    title: "Read a generated report",
    description: "Return a verified generated report snapshot; MCP does not query SQLite or recompute books.",
    inputSchema: companyInput.extend({
      report: z.enum(["trial_balance", "outstandings"]),
      asOn: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
    }),
    annotations: { readOnlyHint: true },
  },
  async (args) => scoped("run_report", "mirror:read", args, async (company) => {
    const data = reportSnapshot(company, args.report);
    if (args.asOn && data?.asOn !== args.asOn)
      throw new ContractError("INVALID_RESOURCE", `The current mirror is for ${data?.asOn || "an unknown date"}; request a refresh for ${args.asOn}.`, true);
    return { company, report: args.report, snapshot: true, mirror: mirrorMeta(company), data };
  }),
);

server.registerTool(
  "list_outstandings",
  {
    title: "List receivables and payables",
    description: "Read bounded outstanding-party snapshots from the generated mirror.",
    inputSchema: companyInput.extend({
      side: z.enum(["receivable", "payable", "all"]).default("all"),
      limit: z.number().int().min(1).max(200).default(100),
    }),
    annotations: { readOnlyHint: true },
  },
  async (args) => scoped("list_outstandings", "mirror:read", args, async (company) => {
    const data = reportSnapshot(company, "outstandings");
    const result = {};
    if (args.side !== "payable") result.receivable = Array.isArray(data?.receivable) ? data.receivable.slice(0, args.limit) : [];
    if (args.side !== "receivable") result.payable = Array.isArray(data?.payable) ? data.payable.slice(0, args.limit) : [];
    return { company, asOn: data?.asOn || null, mirror: mirrorMeta(company), ...result };
  }),
);

server.registerTool(
  "list_exceptions",
  {
    title: "List accounting exceptions",
    description: "Derive bounded, explainable exceptions only from generated report snapshots.",
    inputSchema: companyInput.extend({ limit: z.number().int().min(1).max(200).default(100) }),
    annotations: { readOnlyHint: true },
  },
  async (args) => scoped("list_exceptions", "mirror:read", args, async (company) => {
    const outstanding = reportSnapshot(company, "outstandings");
    const trial = reportSnapshot(company, "trial_balance");
    const exceptions = [];
    if (Number.isInteger(trial?.totalDebit) && Number.isInteger(trial?.totalCredit) && trial.totalDebit !== trial.totalCredit) {
      exceptions.push({ kind: "trial_balance_mismatch", severity: "critical", debit: trial.totalDebit, credit: trial.totalCredit });
    }
    for (const side of ["receivable", "payable"]) {
      for (const party of Array.isArray(outstanding?.[side]) ? outstanding[side] : []) {
        for (const warning of Array.isArray(party?.warnings) ? party.warnings : []) {
          exceptions.push({ kind: "bill_allocation_warning", severity: "warning", side, ledgerId: party.ledgerId, message: String(warning).slice(0, 500) });
        }
        for (const bill of Array.isArray(party?.bills) ? party.bills : []) {
          if (Number.isInteger(bill?.overdueDays) && bill.overdueDays > 0)
            exceptions.push({ kind: "overdue_bill", severity: "warning", side, ledgerId: party.ledgerId, voucherId: bill.voucherId ?? null, overdueDays: bill.overdueDays, pending: bill.pending });
          if (exceptions.length >= args.limit) break;
        }
        if (exceptions.length >= args.limit) break;
      }
      if (exceptions.length >= args.limit) break;
    }
    return { company, asOn: outstanding?.asOn || trial?.asOn || null, mirror: mirrorMeta(company), exceptions: exceptions.slice(0, args.limit) };
  }),
);

server.registerTool(
  "read_attachment",
  {
    title: "Read a managed attachment",
    description:
      "Read one explicitly named file under the company attachments folder as bounded base64.",
    inputSchema: companyInput.extend({
      path: z.string().trim().min(1).max(500),
    }),
    annotations: { readOnlyHint: true },
  },
  async (args) =>
    scoped("read_attachment", "attachment:read", args, async (company) => {
      const base = join(root, "companies", company, "attachments");
      const target = resolve(base, args.path);
      if (!existsSync(base) || !existsSync(target))
        throw new ContractError("INVALID_RESOURCE", "Attachment not found.");
      const realBase = realpathSync(base);
      const realTarget = realpathSync(target);
      if (
        !realTarget.startsWith(`${realBase}${sep}`) ||
        !statSync(realTarget).isFile()
      )
        throw new ContractError(
          "INVALID_RESOURCE",
          ERROR_CODES.INVALID_RESOURCE,
        );
      const bytes = statSync(realTarget).size;
      if (bytes > 2 * 1024 * 1024)
        throw new ContractError(
          "RESOURCE_LIMIT",
          "Attachment exceeds the 2 MB MCP read limit.",
        );
      const extension = extname(realTarget).toLowerCase();
      const mimeType =
        extension === ".pdf"
          ? "application/pdf"
          : extension === ".png"
            ? "image/png"
            : [".jpg", ".jpeg"].includes(extension)
              ? "image/jpeg"
              : "application/octet-stream";
      return {
        company,
        path: args.path,
        bytes,
        mimeType,
        encoding: "base64",
        data: readFileSync(realTarget).toString("base64"),
      };
    }),
);

server.registerTool(
  "request_mirror_refresh",
  {
    title: "Request a fresh mirror",
    description:
      "Create a pending request. Total must be open and an owner must approve it; this tool cannot access SQLite.",
    inputSchema: companyInput,
    annotations: { readOnlyHint: false, destructiveHint: false },
  },
  async (args) =>
    scoped(
      "request_mirror_refresh",
      "mirror:refresh",
      args,
      async (company) => {
        const dir = join(root, "companies", company, "mcp", "refresh-requests");
        mkdirSync(dir, { recursive: true });
        const id = randomUUID();
        const request = {
          id,
          company,
          client: clientName,
          requestedAt: new Date().toISOString(),
          status: "pending",
        };
        writeFileSync(
          join(dir, `${id}.json`),
          JSON.stringify(request, null, 2),
          {
            flag: "wx",
            mode: 0o600,
          },
        );
        return {
          requested: true,
          approved: false,
          requestId: id,
          message:
            "An owner must approve this request in Total > Settings > Agent access.",
        };
      },
    ),
);

server.registerTool(
  "propose_voucher",
  {
    title: "Draft a voucher for review",
    description:
      "Write an inert pending proposal. It never posts; a human must inspect and approve it inside Total.",
    inputSchema: companyInput.extend({
      summary: z.string().trim().min(1).max(240),
      voucher: z.record(z.unknown()),
    }),
    annotations: { readOnlyHint: false, destructiveHint: false },
  },
  async (args) =>
    scoped("propose_voucher", "proposal:create", args, async (company, token) => {
      const validation = validateProposal("voucher", args.voucher);
      if (!validation.valid)
        throw new ContractError("INVALID_RESOURCE", `Voucher proposal is invalid: ${validation.errors.map((row) => row.message).join("; ")}`);
      const proposal = createMcpProposal(company, token, "voucher", args.summary, args.voucher);
      return {
        accepted: true,
        posted: false,
        proposalId: proposal.id,
        validation,
        message: "Review this draft in Total > Settings > Agent access.",
      };
    }),
);

server.registerTool(
  "propose_master_change",
  {
    title: "Draft a master change for review",
    description: "Write an inert ledger or item change proposal. v5.0 never applies it from MCP.",
    inputSchema: companyInput.extend({ summary: z.string().trim().min(1).max(240), change: masterChangeSchema }),
    annotations: { readOnlyHint: false, destructiveHint: false },
  },
  async (args) => scoped("propose_master_change", "proposal:create", args, async (company, token) => {
    const proposal = createMcpProposal(company, token, "master", args.summary, args.change);
    return { accepted: true, posted: false, proposalId: proposal.id, approvalAvailable: false,
      message: "This master proposal is stored for review and cannot be committed by MCP." };
  }),
);

server.registerTool(
  "validate_proposal",
  {
    title: "Validate a proposal shape",
    description: "Run bounded structural and balance validation without writing a proposal or opening SQLite.",
    inputSchema: companyInput.extend({ kind: z.enum(["voucher", "master"]), payload: z.unknown() }),
    annotations: { readOnlyHint: true },
  },
  async (args) => scoped("validate_proposal", "proposal:create", args, async (company) => ({
    company, kind: args.kind, ...validateProposal(args.kind, args.payload),
  })),
);

server.registerTool(
  "list_proposals",
  {
    title: "List this token's proposals",
    description: "List bounded inert proposals created by this exact paired token.",
    inputSchema: companyInput,
    annotations: { readOnlyHint: true },
  },
  async (args) => scoped("list_proposals", "proposal:read", args, async (company, token) => ({
    company,
    proposals: listTokenProposals(company, token.id).map((proposal) => ({
      id: proposal.id, createdAt: proposal.createdAt, status: proposal.status,
      summary: proposal.summary, proposalKind: proposal.proposalKind, posted: false,
    })),
  })),
);

server.registerTool(
  "discard_proposal",
  {
    title: "Discard this token's proposal",
    description: "Archive one inert proposal created by this exact token; accounting books are untouched.",
    inputSchema: companyInput.extend({ proposalId: z.string().min(1).max(240) }),
    annotations: { readOnlyHint: false, destructiveHint: true },
  },
  async (args) => scoped("discard_proposal", "proposal:discard", args, async (company, token) => {
    if (basename(args.proposalId) !== args.proposalId || !/^[a-zA-Z0-9._-]+\.json$/.test(args.proposalId))
      throw new ContractError("INVALID_RESOURCE", ERROR_CODES.INVALID_RESOURCE);
    const proposalRoot = secureProposalDirectory(company);
    if (!proposalRoot) throw new ContractError("INVALID_RESOURCE", "Proposal no longer exists.");
    const masterDir = secureProposalDirectory(company, "mcp-master");
    const candidates = [join(proposalRoot, args.proposalId), ...(masterDir ? [join(masterDir, args.proposalId)] : [])];
    const path = candidates.find((candidate) => existsSync(candidate) && boundedProposal(company, candidate, token.id));
    if (!path) throw new ContractError("INVALID_RESOURCE", "Proposal was not created by this paired token or no longer exists.");
    const proposal = boundedProposal(company, path, token.id);
    if (!proposal) throw new ContractError("INVALID_RESOURCE", ERROR_CODES.INVALID_RESOURCE);
    const discardedDir = secureProposalDirectory(company, "discarded-mcp", true);
    renameSync(path, join(discardedDir, `${Date.now()}-${proposal.id}`));
    return { company, proposalId: proposal.id, discarded: true, posted: false };
  }),
);

server.registerResource(
  "mcp-contract-v1",
  "total://contract/v1",
  {
    title: "Total MCP contract v1",
    description: "Stable tools, scopes, units and structured error codes.",
    mimeType: "application/json",
  },
  async (uri) => ({
    contents: [
      {
        uri: uri.href,
        mimeType: "application/json",
        text: JSON.stringify(CONTRACT, null, 2),
      },
    ],
  }),
);

server.registerResource(
  "current-company-metadata",
  "total://company/current",
  {
    title: "Paired company metadata",
    description: "Non-financial metadata for the company bound to the current token.",
    mimeType: "application/json",
  },
  async (uri) => {
    const token = authorize("companies:list", null);
    await requireAppPresence(token, "companies:list");
    const company = registry().companies.find((row) => row.slug === token.company);
    if (!company) throw new ContractError("COMPANY_NOT_FOUND", ERROR_CODES.COMPANY_NOT_FOUND);
    return { contents: [{ uri: uri.href, mimeType: "application/json", text: JSON.stringify({
      slug: company.slug, name: company.name, lastOpenedAt: company.lastOpenedAt ?? null,
    }, null, 2) }] };
  },
);

server.registerResource(
  "accounting-schema-docs",
  "total://docs/accounting-schema",
  {
    title: "Total accounting schema",
    description: "Stable concepts and units exposed to agent clients.",
    mimeType: "text/markdown",
  },
  async (uri) => ({ contents: [{ uri: uri.href, mimeType: "text/markdown", text:
    "# Total accounting schema\n\nSQLite is authoritative. Money is integer paise and quantity is integer thousandths. Vouchers use stable numeric IDs and balanced debit/credit lines. Generated mirrors are read-only snapshots. MCP proposals are inert and never commit accounting changes.\n" }] }),
);

server.registerResource(
  "mirror-manifest",
  "total://mirror/manifest",
  {
    title: "Current mirror manifest",
    description: "Digest-bound metadata for the paired company's current generated mirror.",
    mimeType: "application/json",
  },
  async (uri) => {
    const token = authorize("mirror:read", null);
    await requireAppPresence(token, "mirror:read");
    const data = readMirror(token.company, "meta.json");
    return { contents: [{ uri: uri.href, mimeType: "application/json", text: JSON.stringify(data, null, 2) }] };
  },
);

server.registerResource(
  "report-definitions",
  "total://reports/definitions",
  {
    title: "Supported report definitions",
    description: "Reports available through run_report and their snapshot semantics.",
    mimeType: "application/json",
  },
  async (uri) => ({ contents: [{ uri: uri.href, mimeType: "application/json", text: JSON.stringify({
    reports: [
      { id: "trial_balance", source: "voucher_lines", amountUnit: "paise", parameters: ["asOn"] },
      { id: "outstandings", source: "voucher_lines_and_bill_refs", amountUnit: "paise", parameters: ["asOn"] },
    ],
    execution: "generated_snapshot",
    refreshRequiresOwnerApproval: true,
  }, null, 2) }] }),
);

server.registerResource(
  "product-help",
  "total://help/product",
  {
    title: "Total product help",
    description: "Safe MCP workflow guidance for local-first accounting.",
    mimeType: "text/markdown",
  },
  async (uri) => ({ contents: [{ uri: uri.href, mimeType: "text/markdown", text:
    "# Using Total through MCP\n\nGenerate a mirror in Total before reading books. Use read tools for snapshots and validate_proposal before proposing a voucher. Every proposal must be reviewed in Total. MCP cannot post, modify SQLite, access credentials, or bypass permissions and period locks.\n" }] }),
);

server.registerResource(
  "voucher-schema",
  "total://schema/voucher",
  {
    title: "Total voucher proposal schema",
    description: "Canonical JSON schema for inert voucher proposals.",
    mimeType: "application/schema+json",
  },
  async (uri) => {
    const candidates = [
      join(scriptDir, "voucher.schema.json"),
      join(process.cwd(), "agent-skill", "voucher.schema.json"),
      join(
        typeof process.resourcesPath === "string" ? process.resourcesPath : "",
        "agent-skill",
        "voucher.schema.json",
      ),
    ];
    const path = candidates.find(existsSync);
    const text = path
      ? readFileSync(path, "utf8")
      : JSON.stringify({ error: "voucher.schema.json is unavailable" });
    return {
      contents: [{ uri: uri.href, mimeType: "application/schema+json", text }],
    };
  },
);

await server.connect(new StdioServerTransport());
