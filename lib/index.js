/**
 * `llm-workbuddy`: a DeepSeek Harness model provider for WorkBuddy (Tencent
 * CodeBuddy) accounts.
 *
 * The plugin registers one LLM adapter route (`workbuddy`) that streams through
 * WorkBuddy's OpenAI-compatible chat endpoint, plus two model-facing account
 * tools. Accounts are durable credential records owned by this plugin, so
 * several WorkBuddy accounts can be signed in at once and are selected per
 * request by the account pool.
 *
 * @module dsh-workbuddy-switch
 */

import { resolveImageAttachmentAccess } from '@deepseek-ai/dsh-llm'
import { Config, PROVIDER, resolveOptions } from './config.js'
import { AccountPool, summarizeCheckins } from './accounts.js'
import { WorkBuddyAdapter } from './adapter.js'
import { registerAccountTools } from './tools.js'
import { startCheckinScheduler } from './checkin.js'

/** Plugin name used by the loader and settings diagnostics. */
export const name = 'llm-workbuddy'

/** Services required before this plugin mounts. */
export const inject = ['llm']

export { Config }

/** Stable JSON comparison for live retry-policy updates. */
function sameJson(left, right) {
  return JSON.stringify(left) === JSON.stringify(right)
}

/**
 * Same-origin endpoint the client decorations and the Settings page read.
 */
export const QUOTA_ROUTE = '/llm-workbuddy/quota'

/** Account-management endpoints behind the Settings → WorkBuddy page. */
export const ACCOUNT_ROUTES = Object.freeze({
  quota: '/llm-workbuddy/accounts/quota',
  pin: '/llm-workbuddy/accounts/pin',
  unpin: '/llm-workbuddy/accounts/unpin',
  remove: '/llm-workbuddy/accounts/remove',
  loginStart: '/llm-workbuddy/login/start',
  loginStatus: '/llm-workbuddy/login/status',
})

/** Manual daily check-in endpoint (also used by the Settings page button). */
export const CHECKIN_ROUTE = '/llm-workbuddy/checkin'

/** Parse the request URL without trusting the Host header. */
function requestUrl(request) {
  return new URL(typeof request.url === 'string' ? request.url : '/', 'http://localhost')
}

/** Reject cross-origin mutations; same-origin GETs may omit Origin. */
function sameOrigin(request) {
  const origin = request.headers?.origin
  if (typeof origin !== 'string' || origin.length === 0) return true
  try {
    return new URL(origin).host === request.headers.host
  } catch {
    return false
  }
}

/** Read one JSON request body (bounded). */
async function readJsonBody(request, limit = 64 * 1024) {
  const chunks = []
  let size = 0
  for await (const chunk of request) {
    size += chunk.length
    if (size > limit) throw new Error('request body too large')
    chunks.push(chunk)
  }
  const text = Buffer.concat(chunks).toString('utf8')
  if (text.trim().length === 0) return {}
  return JSON.parse(text)
}

/** The account / credit / session snapshot the page and the pill both render. */
async function quotaPayload({ pool, options, adapter, sessionId }) {
  const accounts = await pool.accountViews({ quota: true })
  const checkins = await pool.checkinViews()
  const checkinSummary = summarizeCheckins(checkins)
  let autoCheckin = { enabled: false, hour: 8 }
  try {
    const current = options()
    autoCheckin = { enabled: current.autoCheckin, hour: current.autoCheckinHour }
  } catch {
    // Keep the read-only route usable while the live configuration is invalid.
  }
  // The pill's "本会话" number is durable: let a cold process finish restoring
  // the record before answering, so the first render after a restart already
  // shows the accumulated spend instead of 0.
  await adapter?.ready?.()
  const session = await adapter?.sessionUsage?.(sessionId)
  const lastUsedAccountId = pool.lastUsedAccountId?.()
  // The pin decides which account the conversations started from now on use;
  // the lock below decides the one a conversation already under way keeps.
  // `previous` is the pin that one replaced; `auto` is who the pool would pick.
  let pinnedAccountId
  let previousAccountId
  try {
    const pinned = await pool.pinnedAccountId()
    if (typeof pinned === 'string' && pinned.length > 0) pinnedAccountId = pinned
    const previous = await pool.previousAccountId?.()
    // A stale id (that account was removed) is dropped here rather than cleaned
    // up on write: rewriting the record to clear bookkeeping would persist
    // `decided: true` and freeze the configured pin into a user decision.
    if (typeof previous === 'string' && previous.length > 0 && accounts.some((account) => account.id === previous)) previousAccountId = previous
  } catch {
    // A configuration error must not take the read-only snapshot down; the page
    // then reads as automatic selection.
  }
  const autoAccountId = await pool.autoAccountId?.()
  const sessionAccountId = sessionId === undefined ? undefined : adapter?.sessionLockOf?.(sessionId)
  return {
    updatedAt: new Date().toISOString(),
    ...(lastUsedAccountId === undefined ? {} : { lastUsedAccountId }),
    ...(pinnedAccountId === undefined ? {} : { pinnedAccountId }),
    ...(previousAccountId === undefined ? {} : { previousAccountId }),
    ...(typeof autoAccountId !== 'string' || autoAccountId.length === 0 ? {} : { autoAccountId }),
    ...(sessionAccountId === undefined ? {} : { sessionAccountId }),
    ...(session === undefined ? {} : { session }),
    checkin: { ...checkinSummary, auto: autoCheckin, accounts: checkins },
    accounts: accounts.map((account) => ({
      id: account.id,
      ...(account.uid === undefined ? {} : { uid: account.uid }),
      ...(account.nickname === undefined ? {} : { nickname: account.nickname }),
      pinned: account.pinned === true,
      cooling: account.coolingUntil !== undefined,
      ...(account.realm === undefined ? {} : { realm: account.realm }),
      enterprise: account.enterprise === true,
      ...(account.expiresAt === undefined ? {} : { expiresAt: account.expiresAt }),
      ...(account.expiresInSeconds === undefined ? {} : { expiresInSeconds: account.expiresInSeconds }),
      ...(account.coolingUntil === undefined ? {} : { coolingUntil: account.coolingUntil }),
      ...(account.quota === undefined ? {} : { quota: account.quota }),
      ...(account.quotaError === undefined ? {} : { error: account.quotaError }),
    })),
  }
}

/** Write one JSON response. */
function sendJson(response, status, payload) {
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
  response.end(JSON.stringify(payload))
}

/** A required non-empty string field of a JSON body. */
function requireId(body, field = 'accountId') {
  const value = body?.[field]
  if (typeof value !== 'string' || value.length === 0) throw new Error(`${field} is required`)
  return value
}

/** An optional non-empty string field of a JSON body. */
function optionalId(body, field = 'accountId') {
  const value = body?.[field]
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

/** Wrap one route with method, same-origin, and error handling. */
function jsonRoute({ method, logger }, handler) {
  return async (request, response) => {
    if (request.method !== method) {
      response.writeHead(405, { allow: method })
      response.end()
      return
    }
    if (method !== 'GET' && sameOrigin(request) !== true) {
      sendJson(response, 403, { error: 'cross-origin request refused' })
      return
    }
    try {
      sendJson(response, 200, await handler(request))
    } catch (error) {
      logger?.warn?.(`llm-workbuddy: ${request.url} failed: ${error?.message ?? String(error)}`)
      sendJson(response, 400, { error: error?.message ?? 'request failed' })
    }
  }
}

/**
 * Mount the provider route and, when the tools registry is present, the
 * account tools.
 * @param {object} ctx cordis plugin context.
 * @param {object} config live plugin configuration.
 */
export function apply(ctx, config) {
  const options = () => resolveOptions(config)
  // Fail fast: an invalid catalog or account id must surface at load, not on
  // the first model request.
  options()
  const pool = new AccountPool({ ctx, options, logger: ctx.logger })
  const adapter = new WorkBuddyAdapter({
    options,
    pool,
    logger: ctx.logger,
    // The per-session credit spend keeps its durable copy in this plugin's own
    // settings record, next to the pinned account and the check-in history.
    credentials: () => ctx.get('credentials'),
    // Vision requests read the durable normalized attachment through the mounted
    // store; the fs provider only supplies the read-only path shown beside it.
    resolveAttachments: () => ctx.get('attachments'),
    resolveImageAccess: (attachments, ref) =>
      resolveImageAttachmentAccess(attachments, (hostPath) => ctx.get('fs')?.processPathFromHostPath(hostPath), ref),
  })
  let registeredPolicy = options().retryPolicy
  let registration
  ctx.effect(function* registerRoute() {
    registration = ctx.llm.registerAdapter([PROVIDER], adapter)
    yield () => {
      registration?.()
      // The spend record is written on a debounce; flush it before the route goes
      // away so a reload does not lose the last turn's credits.
      void adapter.flushCredits()
      pool.dispose()
    }
  })
  // A retry-policy edit applies without a module reload: re-register the route
  // in place so the runtime captures the new policy.
  ctx.on('loader/volatile-update', () => {
    let next
    try {
      next = options().retryPolicy
    } catch (error) {
      ctx.logger.warn(error)
      return
    }
    if (sameJson(next, registeredPolicy)) return
    try {
      registration.replace([PROVIDER])
      registeredPolicy = next
    } catch (error) {
      ctx.logger.warn(error)
    }
  })
  ctx.inject(['tools', 'credentials'], (child) => {
    child.effect(function* registerTools() {
      const disposers = registerAccountTools(child, { pool, options, adapter, logger: ctx.logger })
      yield () => {
        for (const dispose of disposers) dispose()
      }
    })
  })
  // Automatic daily check-in: one sweep after `autoCheckinHour` (UTC+8) plus
  // bounded retries until every account is settled for the day. The timers are
  // unref'ed, so a headless run is never held open by the scheduler.
  ctx.inject(['credentials'], (child) => {
    child.effect(() => {
      const scheduler = startCheckinScheduler({ pool, options, logger: ctx.logger })
      return () => scheduler.dispose()
    }, 'llm-workbuddy: auto check-in')
  })
  // Serve the credit balance to the conversation-footer decoration. The Web
  // composition provides `webServer`; the headless composition does not, so the
  // route simply never mounts there.
  ctx.inject(['webServer'], (web) => {
    web.effect(() => {
      const deps = { pool, options, adapter, logger: ctx.logger }
      const route = (method) => (handler) => jsonRoute({ method, logger: ctx.logger }, handler)
      const get = route('GET')
      const post = route('POST')
      const routes = [
        {
          kind: 'exact',
          path: QUOTA_ROUTE,
          handler: get(async (request) =>
            quotaPayload({ ...deps, sessionId: requestUrl(request).searchParams.get('session') ?? undefined }),
          ),
        },
        {
          kind: 'exact',
          path: CHECKIN_ROUTE,
          handler: post(async (request) => {
            const body = await readJsonBody(request)
            await pool.checkinAll({
              accountId: optionalId(body),
              force: body.force === true,
            })
            return quotaPayload(deps)
          }),
        },
        {
          kind: 'exact',
          path: ACCOUNT_ROUTES.quota,
          handler: post(async (request) => {
            const body = await readJsonBody(request)
            // One account (the row's "refresh" action) or the whole pool.
            const accountId = optionalId(body)
            if (accountId !== undefined) {
              await pool.quotaFor(accountId, { force: true })
              return quotaPayload(deps)
            }
            await pool.accountViews({ quota: true, forceQuota: true })
            return quotaPayload(deps)
          }),
        },
        {
          kind: 'exact',
          path: ACCOUNT_ROUTES.pin,
          handler: post(async (request) => {
            const accountId = requireId(await readJsonBody(request))
            await pool.pinAccount(accountId)
            return quotaPayload(deps)
          }),
        },
        {
          kind: 'exact',
          path: ACCOUNT_ROUTES.unpin,
          handler: post(async () => {
            await pool.unpinAccount()
            return quotaPayload(deps)
          }),
        },
        {
          kind: 'exact',
          path: ACCOUNT_ROUTES.remove,
          handler: post(async (request) => {
            const accountId = requireId(await readJsonBody(request))
            await pool.removeAccount(accountId)
            adapter?.releaseSessionLocks?.(accountId)
            pool.invalidateCatalog?.()
            return quotaPayload(deps)
          }),
        },
        {
          kind: 'exact',
          path: ACCOUNT_ROUTES.loginStart,
          handler: post(async (request) => {
            const body = await readJsonBody(request)
            const started = await pool.startLogin(body.realm === 'global' ? 'global' : 'cn')
            return { state: started.state, authUrl: started.authUrl }
          }),
        },
        {
          kind: 'exact',
          path: ACCOUNT_ROUTES.loginStatus,
          handler: get(async (request) => {
            const state = requestUrl(request).searchParams.get('state')
            if (state === null || state.length === 0) throw new Error('state is required')
            // One probe per call: the page polls every 2 seconds itself.
            const result = await pool.finishLogin(state, { pollTimeoutMs: 0 })
            if (result.status !== 'connected') return { status: 'pending' }
            return { status: 'connected', accountId: result.account?.id, nickname: result.account?.nickname }
          }),
        },
      ]
      const disposers = routes.map((route) => web.webServer.register(route))
      return () => {
        for (const dispose of disposers) {
          try {
            dispose?.()
          } catch {
            // The web server may already be gone.
          }
        }
      }
    }, 'llm-workbuddy: account routes')
  })
}
