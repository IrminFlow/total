// IPC channels of the GST gateway (Phase 4; src/main/gstGateway/). Registered from ipc.ts with its
// `handle` (role gate + { ok, data | error } envelope); every payload is Zod-parsed here (schemas
// in shared/gstGateway.ts). Write channels are mapped in auditCoverage.ts; like the NIC channels,
// every call that talks to a portal is owner-only (a company without users: anyone). In 1.0 every call goes
// to the built-in Test GSP — test mode, nothing is sent to the GST portal.
import type { DB } from './db/connection'
import type { CompanyInfo } from '@shared/domain'
import type { Role } from './services/roles'
import {
  gateway2bSchema, gatewayCancelSchema, gatewayExtendSchema, gatewayFileSchema, gatewayOtpSchema, gatewayReturnSchema, gatewaySettingsSetSchema, gatewaySignInSchema,
  gatewayVoucherSchema
} from '@shared/gstGateway'
import { gatewayStatus, openGateway, setGatewaySettings } from './gstGateway'
import { cancelEwbFlow, cancelIrnFlow, edocRecord, extendEwbFlow, generateEwbFlow, generateIrnFlow } from './gstGateway/edocFlow'
import * as returns from './gstGateway/returnsFlow'

type Handle = (channel: string, fn: (payload: unknown) => unknown, minRole?: Role) => void
interface Company {
  slug: string
  db: DB
  info: CompanyInfo
}

export function registerGatewayIpc(handle: Handle, company: () => Company, userName: () => string | null): void {
  const open = () => {
    const c = company()
    return { c, g: openGateway(c.db, c.slug, c.info) }
  }

  // ---------- settings ----------
  handle('gateway:status', () => {
    const c = company()
    return gatewayStatus(c.db, c.slug)
  }, 'viewer')
  handle('gateway:settings:set', (p) => {
    const c = company()
    return setGatewaySettings(c.db, c.slug, gatewaySettingsSetSchema.parse(p))
  }, 'owner')

  // ---------- e-invoice / e-way bill ----------
  handle('gateway:edoc:record', (p) => {
    const { voucherId } = gatewayVoucherSchema.parse(p)
    const { c, g } = open()
    return { test: g.test, record: edocRecord(c.db, g.store, voucherId, g.now()) }
  }, 'viewer')
  handle('gateway:irn:generate', async (p) => {
    const { voucherId } = gatewayVoucherSchema.parse(p)
    const { c, g } = open()
    return { test: g.test, ...(await generateIrnFlow(c.db, c.info, voucherId, g)) }
  }, 'owner')
  handle('gateway:irn:cancel', async (p) => {
    const { voucherId, reason, remark } = gatewayCancelSchema.parse(p)
    const { c, g } = open()
    return { test: g.test, ...(await cancelIrnFlow(c.db, voucherId, reason, remark ?? '', g)) }
  }, 'owner')
  handle('gateway:ewb:generate', async (p) => {
    const { voucherId } = gatewayVoucherSchema.parse(p)
    const { c, g } = open()
    return { test: g.test, ...(await generateEwbFlow(c.db, c.info, voucherId, g)) }
  }, 'owner')
  handle('gateway:ewb:cancel', async (p) => {
    const { voucherId, reason, remark } = gatewayCancelSchema.parse(p)
    const { c, g } = open()
    return { test: g.test, ...(await cancelEwbFlow(c.db, voucherId, reason, (remark ?? '').slice(0, 50), g)) }
  }, 'owner')
  handle('gateway:ewb:extend', async (p) => {
    const { voucherId, ...input } = gatewayExtendSchema.parse(p)
    const { c, g } = open()
    return { test: g.test, ...(await extendEwbFlow(c.db, voucherId, input, g)) }
  }, 'owner')

  // ---------- GSTN returns ----------
  handle('gateway:otp:request', async (p) => {
    const { purpose, form, period } = gatewayOtpSchema.parse(p)
    const { c, g } = open()
    if (purpose === 'signin') return returns.requestSignInOtp(g)
    if (!form || !period) throw new Error('Say which return the EVC OTP is for')
    return returns.requestEvcOtp(c.db, c.info, g, form, period)
  }, 'owner')
  handle('gateway:signIn', async (p) => {
    const { otp } = gatewaySignInSchema.parse(p)
    return returns.signIn(open().g, otp)
  }, 'owner')
  handle('gateway:return:get', (p) => {
    const { form, period } = gatewayReturnSchema.parse(p)
    const { c, g } = open()
    return returns.returnRecord(c.db, g, form, period)
  }, 'viewer')
  handle('gateway:return:save', async (p) => {
    const { form, period } = gatewayReturnSchema.parse(p)
    const { c, g } = open()
    return returns.saveReturn(c.db, c.info, g, form, period)
  }, 'owner')
  handle('gateway:return:status', async (p) => {
    const { form, period } = gatewayReturnSchema.parse(p)
    const { c, g } = open()
    return returns.refreshReturnStatus(c.db, g, form, period)
  }, 'owner')
  handle('gateway:return:offset', async (p) => {
    const { period } = gatewayReturnSchema.parse({ ...(p as object), form: 'gstr3b' })
    const { c, g } = open()
    return returns.offsetLiability(c.db, c.info, g, period)
  }, 'owner')
  handle('gateway:return:file', async (p) => {
    const { form, period, otp } = gatewayFileSchema.parse(p)
    const { c, g } = open()
    return returns.fileReturn(c.db, c.info, g, form, period, otp, userName())
  }, 'owner')
  handle('gateway:2b:fetch', async (p) => {
    const { period } = gateway2bSchema.parse(p)
    const { c, g } = open()
    return returns.fetchGstr2b(c.db, g, period, userName())
  }, 'owner')
}
