#!/usr/bin/env node
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, extname, join, resolve, sep } from "node:path";
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
    : "0.5.0");
const root = resolve(
  process.env.TOTAL_DATA_DIR || join(homedir(), "Documents", "total"),
);
const scriptDir = dirname(fileURLToPath(import.meta.url));
const registryPath = join(root, "total.json");
const accessPath = join(root, "mcp-access.json");
const clientName = (process.env.TOTAL_MCP_CLIENT || "local-mcp-client").slice(
  0,
  80,
);

const SCOPES = [
  "companies:list",
  "mirror:read",
  "attachment:read",
  "proposal:create",
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
  moneyUnit: "integer paise",
  quantityUnit: "integer thousandths",
  mirrorSchemaVersions: [1],
  scopes: SCOPES,
  tools: {
    get_capabilities: { scope: null, mutatesBooks: false },
    list_companies: { scope: "companies:list", mutatesBooks: false },
    get_mirror_status: { scope: "mirror:read", mutatesBooks: false },
    get_book_snapshot: { scope: "mirror:read", mutatesBooks: false },
    search_books: { scope: "mirror:read", mutatesBooks: false },
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

function sameHash(left, right) {
  const a = Buffer.from(left, "hex");
  const b = Buffer.from(right, "hex");
  return a.length === b.length && a.length > 0 && timingSafeEqual(a, b);
}

function authorize(scope, requestedCompany) {
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
    generatedAt,
    schemaVersion: Number.isInteger(meta.schemaVersion)
      ? meta.schemaVersion
      : null,
    ageSeconds,
    stale: ageSeconds === null || ageSeconds > 600,
    files: Array.isArray(meta.files)
      ? meta.files.filter((file) => typeof file === "string")
      : [],
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
  if (statSync(path).size > 10 * 1024 * 1024)
    throw new ContractError(
      "RESOURCE_LIMIT",
      "Mirror file exceeds the 10 MB limit.",
    );
  return JSON.parse(readFileSync(path, "utf8"));
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
    scoped("propose_voucher", "proposal:create", args, async (company) => {
      const serialized = JSON.stringify(args.voucher);
      if (Buffer.byteLength(serialized) > 512 * 1024)
        throw new ContractError(
          "RESOURCE_LIMIT",
          "Voucher proposal exceeds 512 KB.",
        );
      const dir = join(root, "companies", company, "proposals");
      mkdirSync(dir, { recursive: true });
      const createdAt = new Date().toISOString();
      const id = `${createdAt.replace(/[:.]/g, "-")}-${randomUUID()}.json`;
      const proposal = {
        version: 1,
        id,
        createdAt,
        source: "mcp",
        status: "pending",
        summary: args.summary,
        voucher: args.voucher,
      };
      writeFileSync(join(dir, id), JSON.stringify(proposal, null, 2), {
        flag: "wx",
        mode: 0o600,
      });
      return {
        accepted: true,
        posted: false,
        proposalId: id,
        message: "Review this draft in Total > Settings > Agent access.",
      };
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
