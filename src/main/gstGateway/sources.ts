// Where every gateway call's shape comes from (Phase 4). Tax rules and API contracts are never
// written from memory: each call cites the official page it follows, and anything read only in a
// secondary source (or not read at all) is in GATEWAY_UNVERIFIED with the URL it came from.
//
// The e-invoice / e-way bill calls are the WP 3.5 NIC client's (services/nic.ts header; read
// 2026-10-07). The GSTN returns API pages on developer.gst.gov.in (Taxpayer API → Returns /
// Authentication) render their content only for signed-in developers — on 7 Nov 2026 the public
// fetch returned the navigation shell only — so EVERY returns shape below is UNVERIFIED until a
// GSP's sandbox (or the signed-in portal) confirms it. The adapter contract keeps those shapes
// behind the adapter: a real GSP adapter maps them onto its own documented request.

export interface GatewayCallSource {
  call: string
  /** The official page(s) the shape follows. */
  official: string[]
  /** What could not be confirmed there, with the secondary source it was read in. */
  unverified?: string[]
}

export const NIC_SOURCES = {
  AUTH: 'https://einv-apisandbox.nic.in/version1.04/authentication.html',
  GEN: 'https://einv-apisandbox.nic.in/version1.03/generate-irn.html',
  CNL: 'https://einv-apisandbox.nic.in/version1.03/cancel-irn.html',
  GET: 'https://einv-apisandbox.nic.in/version1.03/get-eInvoicedetails.html',
  EWB: 'https://einv-apisandbox.nic.in/version1.03/ewaybill-generation-irn.html',
  CEWB: 'https://einv-apisandbox.nic.in/version1.03/cancel-eway-bill.html',
  EXT: 'https://docs.ewaybillgst.gov.in/apidocs/version1.03/extend-validity.html',
  IRN: 'https://einv-apisandbox.nic.in/irn.html',
  MASTER: 'https://docs.ewaybillgst.gov.in/apidocs/master-codes-list.html',
  ERR: 'https://einvoice1.gst.gov.in/others/geterrorcodes/VITAL'
} as const

export const GSTN_SOURCES = {
  /** The official GSTN developer portal (content behind sign-in). */
  RETURNS: 'https://developer.gst.gov.in/apiportal/taxpayer/returns',
  AUTH: 'https://developer.gst.gov.in/apiportal/taxpayer/tauthentication',
  /** Secondary: a GSP's write-up of the EVC filing flow (OTP to the registered mobile / e-mail, then file). */
  SANDBOX_BLOG: 'https://medium.com/blog-by-sandbox/file-gst-returns-using-sandbox-apis-be560f528ae7',
  /** Secondary: a GSP's GSTR-3B offset-liability page. */
  OFFSET_GSP: 'https://developers.qodex.ai/sandbox-api/gst-compliance/taxpayer-returns-file-gstr-3b/gstr-3b-offset-liability',
  /** Secondary: ClearTax on the GSTR-3B API filing sequence (auto-calc → offset → file). */
  CLEARTAX_3B: 'https://news.cleartax.in/fresh-updates-on-interest-liability-auto-computation-in-gstr-3b-apis/7324/amp',
  /** Secondary: a GSP's GSTR-2B route (rtnprd, itcsumm, docdata). */
  VAYANA_2B: 'https://docs.enriched-api.vayana.com/routes/basic/gstn/apis/returns/Gstr-Download-Lite-Api/gstr-2b/'
} as const

export const GATEWAY_SOURCES: GatewayCallSource[] = [
  { call: 'generateIrn', official: [NIC_SOURCES.GEN, NIC_SOURCES.IRN], unverified: ['2150 InfoDtls shape [{InfCd:"DUPIRN", Desc:{AckNo, AckDt, Irn}}] (nicFake.testutil.ts list)'] },
  { call: 'getIrn', official: [NIC_SOURCES.GET], unverified: ['"not found" code 3001'] },
  { call: 'cancelIrn', official: [NIC_SOURCES.CNL], unverified: ['"already cancelled" code 9999', 'CancelDate always present'] },
  { call: 'generateEwbByIrn', official: [NIC_SOURCES.EWB] },
  { call: 'extendEwb', official: [NIC_SOURCES.EXT, NIC_SOURCES.MASTER], unverified: ['EXTENDVALIDITY accepted on the IRP\'s /ewaybillapi route', 'window error code (the generic 240)'] },
  { call: 'cancelEwb', official: [NIC_SOURCES.CEWB, NIC_SOURCES.MASTER] },
  { call: 'requestOtp / signIn', official: [GSTN_SOURCES.AUTH], unverified: ['OTPREQUEST / AUTHTOKEN actions and fields, OTP lifetime, session length (6 h simulated) — portal page behind sign-in'] },
  { call: 'saveReturn (RETSAVE)', official: [GSTN_SOURCES.RETURNS], unverified: [`request = the offline-tool JSON gst.ts exports; reference_id in the answer — ${GSTN_SOURCES.SANDBOX_BLOG}`] },
  { call: 'returnStatus (RETSTATUS)', official: [GSTN_SOURCES.RETURNS], unverified: ['status codes P / PE / ER / IP and error_report [{error_cd, error_msg}]'] },
  { call: 'offsetLiability (RETOFFSET)', official: [GSTN_SOURCES.RETURNS], unverified: [`the request layout (Total sends neutral paise figures; a real adapter maps them) — ${GSTN_SOURCES.OFFSET_GSP}, ${GSTN_SOURCES.CLEARTAX_3B}`] },
  { call: 'requestEvcOtp / fileReturn (RETFILE, EVC)', official: [GSTN_SOURCES.RETURNS], unverified: [`EVC = PAN + OTP sent to the authorised signatory; ARN as ack_num; filed_on dd-MM-yyyy — ${GSTN_SOURCES.SANDBOX_BLOG}`, 'ARN layout (normalizeArn checks letters / digits only)'] },
  { call: 'fetchGstr2b (GET2B)', official: [GSTN_SOURCES.RETURNS], unverified: [`route and envelope; the document fields follow the portal's GSTR-2B JSON download that parseGstr2b reads — ${GSTN_SOURCES.VAYANA_2B}`, 'generation on the 14th of the next month (shared/assistantSources.ts)'] }
]

/** Everything not confirmed in an official text, for the PR and the Settings card. */
export const GATEWAY_UNVERIFIED: readonly string[] = GATEWAY_SOURCES.flatMap((s) => (s.unverified ?? []).map((u) => `${s.call}: ${u}`))
