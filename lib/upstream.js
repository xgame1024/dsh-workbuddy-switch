/**
 * WorkBuddy (Tencent CodeBuddy) upstream wire client.
 *
 * This module owns every HTTP shape and header set: OAuth device authorization,
 * token refresh, chat completions (SSE), account profile, and the live model
 * catalog. It never stores credentials — callers pass them in and persist the
 * rotated bundle.
 *
 * The protocol is the non-public one used by the official WorkBuddy desktop
 * client and the CLI; see README "Upstream protocol" for the source references.
 *
 * @module dsh-workbuddy-switch/upstream
 */

import { createHash, randomBytes } from 'node:crypto'
import { LlmError, attributionHeaders } from '@deepseek-ai/dsh-llm'
import { REALM_BASE_URLS, REALM_BILLING_URLS, REALM_ORIGINS, REALM_PRODUCT_URLS } from './config.js'
import { activePromotionFor, buildPriceInfo, normalizePromotion, parseCreditMultiplier, promoteForDisplay } from './pricing.js'

/** OAuth/state/token API version path. */
const AUTH_PATH = '/v2/plugin/auth'
/** Login identity path. */
const LOGIN_PATH = '/v2/plugin/login'
/** Chat completions path shared by both realms. */
const CHAT_PATH = '/v2/chat/completions'
/** Live catalog path (UA-sensitive). */
const CONFIG_PATH = '/v3/config'
/** Enterprise personal-model catalog path. */
const ENTERPRISE_MODELS_PATH = '/console/enterprises/personal/models'

/** UA used by the OAuth/login legs. */
const LOGIN_UA = 'CLI/2.63.2 CodeBuddy/2.63.2'
/** UA used by the `/v3/config` catalog probe; it must name a CodeBuddy version. */
const IDE_UA = 'CodeBuddyIDE/4.12.0 CodeBuddy/4.12.0'

/**
 * User agents the `/v3/config` probe tries, in order. The upstream answers with
 * a **different catalogue per channel**: the desktop UA returns the WorkBuddy
 * product catalogue (more models, `credits` list prices and `modelPromotions`,
 * e.g. the deepseek off-peak discount), the IDE UA returns the CodeBuddy one.
 * Probing both and merging keeps the WorkBuddy prices while still learning any
 * capability field only the IDE response carries.
 */
function catalogUserAgents(config, realm) {
  const desktop = chatUA(config, realm)
  if (typeof config.userAgent === 'string' && config.userAgent.length > 0) return [desktop]
  return [desktop, IDE_UA]
}

/** Hex sha256. */
function sha256Hex(value) {
  return createHash('sha256').update(value, 'utf8').digest('hex')
}

/** Random lowercase hex of `bytes` bytes. */
export function randomHex(bytes) {
  return randomBytes(bytes).toString('hex')
}

/** Deterministic UUID-shaped value (8-4-4-4-12) from a seed. */
export function seededUuid(seed) {
  const hex = sha256Hex(seed).slice(0, 32)
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`
}

/** The exact realm chat/login root for one account. */
export function realmBaseURL(config, realm) {
  if (typeof config.baseURL === 'string' && config.baseURL.length > 0) return config.baseURL
  return REALM_BASE_URLS[realm === 'global' ? 'global' : 'cn']
}

/** The origin/referer sent with an account's requests. */
export function realmOrigin(config, realm) {
  if (typeof config.baseURL === 'string' && config.baseURL.length > 0) {
    try {
      return new URL(config.baseURL).origin
    } catch {
      return REALM_ORIGINS[realm === 'global' ? 'global' : 'cn']
    }
  }
  return REALM_ORIGINS[realm === 'global' ? 'global' : 'cn']
}

/**
 * The product/web domain used for the account profile endpoint.
 *
 * A `baseURL` override (a mock, a corporate gateway) wins, so the profile leg
 * follows the same host as the rest of the request instead of jumping back out
 * to the public domain and failing there.
 */
export function realmProductURL(config, realm) {
  if (typeof config.baseURL === 'string' && config.baseURL.length > 0) {
    try {
      return new URL(config.baseURL).origin
    } catch {
      // Fall through to the realm default for an unparseable override; the
      // config layer already reports that as an error before we get here.
    }
  }
  return REALM_PRODUCT_URLS[realm === 'global' ? 'global' : 'cn']
}

/**
 * The `X-Domain` host for chat and catalog calls: always the realm product
 * domain the official desktop client uses (`www.workbuddy.cn` for CN,
 * `www.workbuddy.ai` for global).
 *
 * The desktop derives it from `auth.domain`, which for WorkBuddy resolves to the
 * product host; this plugin logs in against the same host (see
 * `REALM_BASE_URLS`), so the two agree. Accounts imported from an earlier
 * CodeBuddy-domain login still send the product host on chat — verified accepted
 * (`code 11102` model lookup answers identically), while auth legs keep their own
 * stored `domain` because those must match the session that issued the token.
 *
 * @returns the bare authority to send, e.g. `www.workbuddy.cn`.
 */
export function chatDomainHost(realm) {
  return REALM_PRODUCT_URLS[realm === 'global' ? 'global' : 'cn'].replace(/^https?:\/\//u, '')
}

/** The realm login UA (`CLI/<cli> CodeBuddy/<cli>`). */
export function loginUA(config) {
  if (typeof config.userAgent === 'string' && config.userAgent.length > 0) return config.userAgent
  return config.loginUserAgent || LOGIN_UA
}

/** The chat UA, which differs per realm for the platform product segment. */
export function chatUA(config, realm) {
  if (typeof config.userAgent === 'string' && config.userAgent.length > 0) return config.userAgent
  const product = realm === 'global' ? 'workbuddy-ai' : 'WorkBuddy'
  return `WorkBuddy/${config.clientVersion} ${product}/${config.clientVersion} CLI/${config.cliVersion}`
}

/** Bearer token and account identity headers, shared by the chat, quota, and refresh legs. */
function applyIdentityHeaders(headers, account, accessToken) {
  if (typeof accessToken === 'string' && accessToken.length > 0) headers.authorization = `Bearer ${accessToken}`
  if (typeof account.uid === 'string' && account.uid.length > 0) headers['x-user-id'] = account.uid
  if (typeof account.enterpriseId === 'string' && account.enterpriseId.length > 0) {
    headers['x-enterprise-id'] = account.enterpriseId
    headers['x-tenant-id'] = account.enterpriseId
  }
}

/** Headers every WorkBuddy API call carries. */
function commonHeaders(config, realm) {
  const origin = realmOrigin(config, realm)
  return {
    accept: 'application/json, text/plain, */*',
    'x-requested-with': 'XMLHttpRequest',
    origin,
    referer: `${origin}/`,
    'user-agent': loginUA(config),
    'x-codebuddy-request': '1',
    'accept-language': realm === 'global' ? 'en-US' : 'zh-CN',
  }
}

/** Headers for the two unauthenticated OAuth legs. */
function loginHeaders(config, realm) {
  return {
    ...commonHeaders(config, realm),
    'content-type': 'application/json',
  }
}

/**
 * Headers for one model request, matching the official desktop client's chat
 * shape as read out of the shipped bundles (WorkBuddy 5.9.x, bundled CLI
 * `codebuddy-lite-wb.mjs`: header enum in module 63355, assignment in the model
 * provider):
 *
 * Only what the request needs is sent. Measured on 2026-11-17 with
 * `tools/header-probe.mjs` against a real signed-in account: dropping the brand
 * family (`X-Product`, `X-IDE-*`), the agent family (`X-Agent-*`), the
 * tracing family (B3/traceparent/`X-Trace-Id`), the extra framework headers
 * (`X-Private-Data`, `X-Requested-With`) and the OpenAI SDK fingerprint
 * (`X-Stainless-*`) all still answered `200`, so none of them is required.
 * The client identity claims are gone on purpose: this plugin is not the
 * official desktop client shape, and sending its brand headers buys nothing.
 *
 * Kept: bearer/identity/`X-Domain` (auth and routing), `X-Private-Data` (a
 * privacy flag the service honours — cheap to keep even though a request
 * without it is accepted), the conversation ids (plain ids, no brand), and the
 * per-request id the stream is correlated by.
 *
 * `User-Agent` is deleted before sending, including the harness attribution UA,
 * so the wire request carries no UA at all. The catalog probe keeps an explicit
 * UA: there it selects which product catalogue the upstream returns.
 */
export function chatHeaders({ config, account, accessToken, id, deviceToken }) {
  const realm = account.realm === 'global' ? 'global' : 'cn'
  const headers = {
    accept: 'application/json',
    'content-type': 'application/json',
    'x-private-data': 'true',
    'x-conversation-id': id.conversationId,
    'x-conversation-request-id': id.conversationRequestId,
    'x-conversation-message-id': id.messageId,
    'x-request-id': id.messageId,
  }
  applyIdentityHeaders(headers, account, accessToken)
  headers['x-domain'] = chatDomainHost(realm)
  const device = deviceToken || account.deviceToken || config.deviceToken
  if (typeof device === 'string' && device.length > 0) headers['x-device-token'] = device
  const merged = { ...attributionHeaders(), ...headers }
  // The client deletes the UA before sending; attributionHeader() is one too, so
  // dropping only ours would leave `deepseek-harness/…` on the wire.
  delete merged['user-agent']
  return merged
}

/**
 * Headers for the refresh leg (never carries the bearer token in chat form).
 * Official shape: request-framework headers + X-Domain + X-Refresh-Token +
 * X-Auth-Refresh-Source: plugin.
 *
 * `X-Domain` is the WorkBuddy product domain, like every other leg: the refresh
 * endpoint lives on the same product host and rejects a domain that does not
 * match the deployment it was reached through.
 */
export function refreshHeaders(config, account) {
  if (typeof account.refreshToken !== 'string' || account.refreshToken.length === 0) {
    // Sending the literal string "undefined" upstream only produces a confusing
    // 401; say what the user has to do instead.
    throw new LlmError(`llm-workbuddy: account "${account.id}" has no refresh token; sign in again`, 'AUTH')
  }
  const realm = account.realm === 'global' ? 'global' : 'cn'
  const domain = chatDomainHost(realm)
  const headers = {
    accept: 'application/json, text/plain, */*',
    'accept-encoding': 'gzip, compress, deflate, br',
    'content-type': 'application/json',
    'x-requested-with': 'XMLHttpRequest',
    'x-request-id': randomHex(16),
    'x-product': 'SaaS',
    'user-agent': chatUA(config, realm),
    'x-domain': domain,
    'x-auth-refresh-source': 'plugin',
    'x-refresh-token': account.refreshToken,
  }
  applyIdentityHeaders(headers, account, account.accessToken)
  return { ...attributionHeaders(), ...headers }
}

/** Headers for the live catalog probe. `userAgent` selects the product channel. */
function catalogHeaders(config, account, accessToken, userAgent) {
  const realm = account.realm === 'global' ? 'global' : 'cn'
  const headers = {
    ...commonHeaders(config, realm),
    'user-agent': userAgent,
    authorization: `Bearer ${accessToken}`,
    'x-user-id': account.uid,
    'x-product': 'SaaS',
  }
  headers['x-domain'] = chatDomainHost(realm)
  return { ...attributionHeaders(), ...headers }
}

/**
 * Fetch with a header deadline, honoring the caller's abort signal.
 * @returns the response.
 */
async function fetchTimed(url, init, { headerTimeoutMs, signal, context }) {
  const controller = new AbortController()
  let timedOut = false
  const timer = setTimeout(() => {
    timedOut = true
    controller.abort()
  }, headerTimeoutMs)
  const combined = signal === undefined ? controller.signal : AbortSignal.any([controller.signal, signal])
  try {
    return await fetch(url, { ...init, signal: combined, redirect: 'error' })
  } catch (error) {
    if (signal?.aborted) throw new LlmError(`llm-workbuddy: ${context} aborted`, 'ABORTED', { cause: error })
    if (timedOut) throw new LlmError(`llm-workbuddy: ${context} timed out after ${headerTimeoutMs}ms`, 'TIMEOUT', { cause: error })
    throw new LlmError(`llm-workbuddy: ${context} transport failed`, 'TRANSPORT', { cause: error })
  } finally {
    clearTimeout(timer)
  }
}

/**
 * Read a JSON body, mapping invalid JSON to a stable failure.
 *
 * The header deadline in {@link fetchTimed} is cleared as soon as the response
 * arrives, so the body needs its own deadline: a peer that sends headers and
 * then stalls would otherwise hang login, refresh, quota, catalog and check-in
 * forever with no error to report.
 */
async function readJson(response, context, { bodyTimeoutMs = 30000, signal } = {}) {
  const deadline = AbortSignal.timeout(bodyTimeoutMs)
  const combined = signal === undefined ? deadline : AbortSignal.any([deadline, signal])
  let text
  try {
    text = await raceBody(response.text(), combined)
  } catch (error) {
    // The request signal aborts the body read too, and that arrives as an
    // AbortError even when this call was given no signal of its own.
    if (signal?.aborted || error?.name === 'AbortError') {
      throw new LlmError(`llm-workbuddy: ${context} aborted`, 'ABORTED', { cause: error })
    }
    if (deadline.aborted) throw new LlmError(`llm-workbuddy: ${context} body stalled after ${bodyTimeoutMs}ms`, 'TIMEOUT', { cause: error })
    throw new LlmError(`llm-workbuddy: ${context} transport failed while reading the body`, 'TRANSPORT', { cause: error })
  }
  if (text.length === 0) return {}
  try {
    return JSON.parse(text)
  } catch (error) {
    throw new LlmError(`llm-workbuddy: ${context} returned invalid JSON (HTTP ${response.status})`, 'MALFORMED_RESPONSE', {
      status: response.status,
      cause: error,
    })
  }
}

/** Resolve `promise`, or reject as soon as `signal` aborts. */
function raceBody(promise, signal) {
  if (signal === undefined) return promise
  if (signal.aborted) return Promise.reject(signal.reason ?? new Error('aborted'))
  return new Promise((resolvePromise, rejectPromise) => {
    const onAbort = () => rejectPromise(signal.reason ?? new Error('aborted'))
    signal.addEventListener('abort', onAbort, { once: true })
    promise.then(
      (value) => {
        signal.removeEventListener('abort', onAbort)
        resolvePromise(value)
      },
      (error) => {
        signal.removeEventListener('abort', onAbort)
        rejectPromise(error)
      },
    )
  })
}

/** Extract the business code/message from a response envelope. */
function envelopeOf(body) {
  if (typeof body !== 'object' || body === null) return {}
  const record = body
  const error = typeof record.error === 'object' && record.error !== null ? record.error : undefined
  const code = record.code ?? error?.code
  const message = record.msg ?? record.message ?? error?.message
  return {
    code,
    message: typeof message === 'string' ? message : undefined,
    requestId: typeof record.requestId === 'string' ? record.requestId : typeof error?.requestId === 'string' ? error.requestId : undefined,
  }
}

/** Parse the reset wall clock in a rate-limit message (always UTC+8). */
function parseResetDelayMs(message) {
  if (typeof message !== 'string' || message.length === 0) return undefined
  const match =
    /将在\s*(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2})/u.exec(message) ??
    /reset at (\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2})/iu.exec(message)
  if (match === null) return undefined
  const at = Date.parse(`${match[1]} GMT+0800`)
  if (!Number.isFinite(at)) return undefined
  return Math.max(1000, at - Date.now())
}

/**
 * Retry-After / Retry-After-Ms / X-Ratelimit-Reset header delay.
 *
 * Accepts the HTTP-date form as well as delta-seconds: a proxy or CDN in front
 * of the upstream answers with the date form, and ignoring it made the retry
 * loop fire immediately.
 */
function retryAfterMs(headers) {
  const ms = headers?.get('retry-after-ms')
  if (ms !== null && ms !== undefined && /^\d+$/u.test(ms)) return Math.max(1000, Number(ms))
  const retry = headers?.get('retry-after')
  if (retry !== null && retry !== undefined && /^\d+(?:\.\d+)?$/u.test(retry)) return Math.max(1000, Number(retry) * 1000)
  if (retry !== null && retry !== undefined) {
    const at = Date.parse(retry)
    if (Number.isFinite(at)) return Math.max(1000, at - Date.now())
  }
  const reset = headers?.get('x-ratelimit-reset')
  if (reset !== null && reset !== undefined && /^\d+$/u.test(reset)) {
    const seconds = Number(reset)
    return seconds > 1e12 ? Math.max(1000, seconds - Date.now()) : Math.max(1000, seconds * 1000)
  }
  return undefined
}

/** Cap a provider-suggested delay (two hours by default; model limits allow longer). */
function capDelay(ms, maxMs = 2 * 60 * 60 * 1000) {
  return ms === undefined ? undefined : Math.min(Math.max(1000, ms), maxMs)
}

/**
 * Bound and de-identify an upstream message before it becomes an error text.
 *
 * A gateway answers 5xx with a whole HTML page, and a rejected image request can
 * echo the base64 payload back; both end up in the error, which the adapter
 * writes to the log. Truncate, and drop any inline data URL.
 */
function redactDetail(text) {
  if (typeof text !== 'string' || text.length === 0) return ''
  const stripped = text.replace(/data:[^;,\s]*;base64,[A-Za-z0-9+/=]+/gu, 'data:<redacted>')
  return stripped.length > 300 ? `${stripped.slice(0, 300)}…` : stripped
}

/**
 * Build the terminal failure for one non-2xx chat response.
 * @returns the LlmError to throw.
 */
export function classifyChatFailure({ status, headers, bodyText }) {
  let body
  try {
    body = JSON.parse(bodyText)
  } catch {
    body = undefined
  }
  const envelope = envelopeOf(body)
  const code = envelope.code === undefined ? '' : String(envelope.code)
  const message = redactDetail(envelope.message ?? bodyText ?? '')
  const detail = `${code} ${message}`.trim()
  const rawDelay = retryAfterMs(headers) ?? parseResetDelayMs(detail)
  const delay = capDelay(rawDelay)
  const modelDelay = capDelay(rawDelay, 24 * 60 * 60 * 1000)
  const hasEnvelope = envelope.code !== undefined || envelope.message !== undefined
  // The upstream channel check rejects the prompt, not the account, and this
  // plugin forwards the prompt as assembled: name that, so a bare 11128 does not
  // send the user looking for a setting that does not exist.
  const hint = failureHint(code, detail)
  const failure = (failureCode, retryDelay = delay) =>
    new LlmError(`llm-workbuddy: WorkBuddy request failed (HTTP ${status}${code.length > 0 ? `, code ${code}` : ''}): ${message || 'no response body'}${hint}`, failureCode, {
      status,
      ...retryDelay === undefined ? {} : { providerRetryAfterMs: retryDelay },
      ...envelope.requestId === undefined ? {} : { requestId: envelope.requestId },
    })
  if (status === 402 || code === '14018') return failure('QUOTA')
  // 6004 (model usage limit) and 6021 (queue full) are channel-wide: switching
  // accounts cannot clear them, so they get their own failure code and a
  // cooldown bounded by the reported reset instead of a two-hour cap.
  if (code === '6004' || code === '6021') return failure('MODEL_RATE_LIMIT', modelDelay)
  if (status === 401 || status === 403) {
    if (status === 403 && !hasEnvelope) return failure('SERVER')
    return failure('AUTH')
  }
  if (status === 429) return failure('RATE_LIMIT')
  if (status === 400 || status === 404 || status === 413) {
    if (/prompt is too long|context.*(length|window)|too long/iu.test(detail)) return failure('CONTEXT_WINDOW_EXCEEDED')
    return failure('INVALID_REQUEST')
  }
  if (status >= 500) return failure('SERVER')
  return failure(`HTTP_${status}`)
}

/**
 * Build the terminal failure for an in-band SSE `error` frame. WorkBuddy may
 * answer HTTP 200 and stream a structured error frame instead of a chunk.
 */
export function classifyStreamError(raw, { signal } = {}) {
  const envelope = envelopeOf(raw)
  const record = typeof raw === 'object' && raw !== null ? raw : {}
  const error = typeof record.error === 'object' && record.error !== null ? record.error : {}
  const code = envelope.code === undefined ? '' : String(envelope.code)
  const message = envelope.message ?? 'WorkBuddy stream error'
  const detail = `${code} ${message}`.trim()
  const rawDelay = parseResetDelayMs(detail)
  const delay = capDelay(rawDelay)
  const modelDelay = capDelay(rawDelay, 24 * 60 * 60 * 1000)
  const failure = (failureCode, retryDelay = delay) =>
    new LlmError(`llm-workbuddy: WorkBuddy stream error${code.length > 0 ? ` (code ${code})` : ''}: ${message}`, failureCode, {
      ...retryDelay === undefined ? {} : { providerRetryAfterMs: retryDelay },
      ...typeof error.requestId === 'string' ? { requestId: error.requestId } : {},
    })
  if (signal?.aborted) return new LlmError('llm-workbuddy: WorkBuddy request aborted', 'ABORTED')
  if (code === '6004' || code === '6021') return failure('MODEL_RATE_LIMIT', modelDelay)
  if (/rate.?limit|too many requests/iu.test(detail)) return failure('RATE_LIMIT')
  if (code === '14018' || /insufficient|quota|credits?/iu.test(detail)) return failure('QUOTA')
  if (code === '11128') return failure('INVALID_REQUEST')
  if (code === '11140' || code === '12153') return failure('AUTH')
  if (code === '11115') return failure('CONTEXT_WINDOW_EXCEEDED')
  return failure('SERVER')
}

/** The actionable sentence appended to one classified chat failure. */
function failureHint(code, detail) {
  if (code === '11128') {
    return ' — upstream rejected the system prompt (channel check 11128). This plugin sends the prompt through unchanged and offers no override, so there is no local workaround: try another model'
  }
  if (code === '11135') {
    return ' — upstream rejected the image payload (11135 invalid_image_data). Attach a PNG, JPEG, WebP, or GIF under the size limits and retry'
  }
  if (code === '11133' && /image/iu.test(detail)) {
    return ' — upstream rejected the image for this model (11133 model_param_invalid); switch to a model whose catalog entry sets `supportsImages: true`'
  }
  return ''
}

/** Whether one business envelope reports success: no code, or code 0. */
function envelopeOk(envelope) {
  return envelope.code === undefined || Number(envelope.code) === 0
}

/** Ensure a business envelope reports success; throws the classified failure otherwise. */
function assertEnvelopeOk(body, context, response) {
  const envelope = envelopeOf(body)
  if (envelope.code === undefined || Number(envelope.code) === 0) return
  throw new LlmError(
    `llm-workbuddy: ${context} failed (code ${String(envelope.code)}): ${envelope.message ?? 'no message'}`,
    'SERVER',
    { status: response?.status },
  )
}

/** Consume a chat response as decoded SSE JSON frames. */
async function* parseChatSSE(response, { idleTimeoutMs, signal, context }) {
  if (response.body === null) throw new LlmError(`llm-workbuddy: ${context} returned no response body`, 'EMPTY_RESPONSE')
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  try {
    for (;;) {
      let idleTimer
      const idle = new Promise((_, reject) => {
        idleTimer = setTimeout(() => {
          reject(new LlmError(`llm-workbuddy: ${context} stream idle for ${idleTimeoutMs}ms`, 'TIMEOUT'))
        }, idleTimeoutMs)
      })
      let chunk
      try {
        chunk = await Promise.race([reader.read(), idle])
      } finally {
        clearTimeout(idleTimer)
      }
      if (signal?.aborted) throw new LlmError(`llm-workbuddy: ${context} aborted`, 'ABORTED')
      if (chunk.done) break
      buffer += decoder.decode(chunk.value, { stream: true })
      let newline
      while ((newline = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, newline).replace(/\r$/u, '')
        buffer = buffer.slice(newline + 1)
        if (line.length === 0) continue
        if (!line.startsWith('data:')) continue
        const payload = line.slice(5).trim()
        if (payload.length === 0) continue
        if (payload === '[DONE]') {
          yield { done: true }
          return
        }
        let frame
        try {
          frame = JSON.parse(payload)
        } catch {
          continue
        }
        yield { frame }
      }
    }
    const rest = buffer.trim()
    if (rest.startsWith('data:')) {
      const payload = rest.slice(5).trim()
      if (payload === '[DONE]') {
        yield { done: true }
        return
      }
      try {
        yield { frame: JSON.parse(payload) }
      } catch {
        // Trailing partial frame is not model content.
      }
    }
  } finally {
    try {
      await reader.cancel()
    } catch {
      // The transport may already be closed.
    }
  }
}

/** Perform one streaming chat request. Yields decoded frames (`{frame}` or `{done:true}`). */
export async function* streamChat({ config, account, accessToken, body, id, signal }) {
  const realm = account.realm === 'global' ? 'global' : 'cn'
  const url = `${realmBaseURL(config, realm)}${CHAT_PATH}`
  const response = await fetchTimed(
    url,
    {
      method: 'POST',
      headers: chatHeaders({ config, account, accessToken, id, deviceToken: config.deviceToken }),
      body: JSON.stringify(body),
    },
    { headerTimeoutMs: config.requestHeaderTimeoutMs, signal, context: 'WorkBuddy chat request' },
  )
  if (!response.ok) {
    // Same body deadline as readJson: a 4xx/5xx whose body stalls must end the
    // turn with a failure, not hang it forever.
    const deadline = AbortSignal.timeout(30000)
    const combined = signal === undefined ? deadline : AbortSignal.any([deadline, signal])
    const text = await raceBody(response.text(), combined).catch(() => '')
    throw classifyChatFailure({ status: response.status, headers: response.headers, bodyText: text })
  }
  yield* parseChatSSE(response, { idleTimeoutMs: config.streamIdleTimeoutMs, signal, context: 'WorkBuddy chat stream' })
}

/**
 * Step 1 of the device-authorization flow: ask the server for a state and the
 * browser authorization URL.
 */
export async function startLogin({ config, realm, signal }) {
  const normalizedRealm = realm === 'global' ? 'global' : 'cn'
  const url = `${realmBaseURL(config, normalizedRealm)}${AUTH_PATH}/state?platform=CLI`
  const response = await fetchTimed(
    url,
    { method: 'POST', headers: loginHeaders(config, normalizedRealm), body: '{}' },
    { headerTimeoutMs: config.requestHeaderTimeoutMs, signal, context: 'WorkBuddy login start' },
  )
  const body = await readJson(response, 'WorkBuddy login start')
  if (!response.ok) {
    const envelope = envelopeOf(body)
    throw new LlmError(
      `llm-workbuddy: starting login failed (HTTP ${response.status}): ${envelope.message ?? 'no message'}`,
      response.status === 401 || response.status === 403 ? 'AUTH' : 'SERVER',
      { status: response.status },
    )
  }
  assertEnvelopeOk(body, 'login-start', response)
  const data = typeof body?.data === 'object' && body.data !== null ? body.data : {}
  if (typeof data.state !== 'string' || data.state.length === 0 || typeof data.authUrl !== 'string' || data.authUrl.length === 0) {
    throw new LlmError('llm-workbuddy: login start response carried no state/authUrl', 'MALFORMED_RESPONSE', { status: response.status })
  }
  return { state: data.state, authUrl: data.authUrl, realm: normalizedRealm }
}

/** Step 2 of the flow: poll the token endpoint once. */
export async function pollLogin({ config, realm, state, signal }) {
  const normalizedRealm = realm === 'global' ? 'global' : 'cn'
  const url = `${realmBaseURL(config, normalizedRealm)}${AUTH_PATH}/token?state=${encodeURIComponent(state)}`
  const response = await fetchTimed(
    url,
    { method: 'GET', headers: loginHeaders(config, normalizedRealm) },
    { headerTimeoutMs: config.requestHeaderTimeoutMs, signal, context: 'WorkBuddy login poll' },
  )
  const body = await readJson(response, 'WorkBuddy login poll')
  if (!response.ok) {
    if (response.status === 401 || response.status === 403) return { status: 'pending' }
    const envelope = envelopeOf(body)
    throw new LlmError(
      `llm-workbuddy: login poll failed (HTTP ${response.status}): ${envelope.message ?? 'no message'}`,
      'SERVER',
      { status: response.status },
    )
  }
  const envelope = envelopeOf(body)
  if (!envelopeOk(envelope)) {
    return { status: 'pending', code: String(envelope.code), message: envelope.message }
  }
  const data = typeof body?.data === 'object' && body.data !== null ? body.data : undefined
  if (data === undefined || typeof data.accessToken !== 'string' || data.accessToken.length === 0) {
    return { status: 'pending' }
  }
  return {
    status: 'connected',
    bundle: {
      accessToken: data.accessToken,
      refreshToken: typeof data.refreshToken === 'string' ? data.refreshToken : undefined,
      expiresIn: Number.isFinite(data.expiresIn) ? Number(data.expiresIn) : 0,
      domain: typeof data.domain === 'string' ? data.domain : undefined,
    },
  }
}

/** Step 3 of the flow: fetch the account identity bound to the authorization. */
export async function fetchLoginAccount({ config, realm, state, accessToken, signal }) {
  const normalizedRealm = realm === 'global' ? 'global' : 'cn'
  const url = `${realmBaseURL(config, normalizedRealm)}${LOGIN_PATH}/account?state=${encodeURIComponent(state)}`
  const response = await fetchTimed(
    url,
    {
      method: 'GET',
      headers: { ...loginHeaders(config, normalizedRealm), authorization: `Bearer ${accessToken}` },
    },
    { headerTimeoutMs: config.requestHeaderTimeoutMs, signal, context: 'WorkBuddy login account' },
  )
  const body = await readJson(response, 'WorkBuddy login account')
  if (!response.ok) {
    const envelope = envelopeOf(body)
    throw new LlmError(
      `llm-workbuddy: reading the authorized account failed (HTTP ${response.status}): ${envelope.message ?? 'no message'}`,
      'SERVER',
      { status: response.status },
    )
  }
  const envelope = envelopeOf(body)
  if (!envelopeOk(envelope)) {
    throw new LlmError(`llm-workbuddy: reading the authorized account failed: ${envelope.message ?? String(envelope.code)}`, 'SERVER')
  }
  const data = typeof body?.data === 'object' && body.data !== null ? body.data : {}
  const uid = typeof data.uid === 'string' ? data.uid : undefined
  if (uid === undefined) throw new LlmError('llm-workbuddy: the authorization returned no account uid', 'MALFORMED_RESPONSE')
  return {
    uid,
    enterpriseId: typeof data.enterpriseId === 'string' ? data.enterpriseId : '',
    nickname: typeof data.nickname === 'string' ? data.nickname : undefined,
  }
}

/** Validate a token and read the account profile from the product web endpoint. */
export async function fetchProfile({ config, realm, accessToken, signal }) {
  const normalizedRealm = realm === 'global' ? 'global' : 'cn'
  const url = `${realmProductURL(config, normalizedRealm)}/console/account`
  const response = await fetchTimed(
    url,
    {
      method: 'GET',
      headers: {
        accept: 'application/json, text/plain, */*',
        authorization: `Bearer ${accessToken}`,
        'x-client-platform': 'web',
        origin: realmProductURL(config, normalizedRealm),
        referer: `${realmProductURL(config, normalizedRealm)}/profile/account-settings`,
        'user-agent': loginUA(config),
      },
    },
    { headerTimeoutMs: config.requestHeaderTimeoutMs, signal, context: 'WorkBuddy profile request' },
  )
  const body = await readJson(response, 'WorkBuddy profile')
  if (!response.ok) {
    throw classifyProfileFailure(response.status, body)
  }
  const envelope = envelopeOf(body)
  if (!envelopeOk(envelope)) throw classifyProfileFailure(200, body)
  const data = typeof body?.data === 'object' && body.data !== null ? body.data : {}
  const uid = typeof data.uid === 'string' ? data.uid : undefined
  if (uid === undefined) throw new LlmError('llm-workbuddy: the profile response carried no uid', 'MALFORMED_RESPONSE')
  return { uid, nickname: typeof data.nickname === 'string' ? data.nickname : undefined }
}

/** Classify a profile-endpoint failure (token validity check). */
function classifyProfileFailure(status, body) {
  const envelope = envelopeOf(body)
  if (status === 401 || status === 403 || /invalid_token|12153/iu.test(`${envelope.code} ${envelope.message}`)) {
    return new LlmError('llm-workbuddy: the supplied access token was rejected', 'AUTH', { status })
  }
  return new LlmError(
    `llm-workbuddy: validating the access token failed (HTTP ${status}): ${envelope.message ?? 'no message'}`,
    'SERVER',
    { status },
  )
}

/** Rotate one account's access/refresh token pair. */
export async function refreshAccessToken({ config, account, signal }) {
  const realm = account.realm === 'global' ? 'global' : 'cn'
  const url = `${realmBaseURL(config, realm)}${AUTH_PATH}/token/refresh`
  const response = await fetchTimed(
    url,
    { method: 'POST', headers: refreshHeaders(config, account) },
    { headerTimeoutMs: config.requestHeaderTimeoutMs, signal, context: 'WorkBuddy token refresh' },
  )
  const body = await readJson(response, 'WorkBuddy token refresh')
  if (!response.ok) {
    throw classifyChatFailure({ status: response.status, headers: response.headers, bodyText: JSON.stringify(body) })
  }
  const envelope = envelopeOf(body)
  if (!envelopeOk(envelope)) {
    if (String(envelope.code) === '12153') {
      throw new LlmError('llm-workbuddy: the session is offline; sign the account in again', 'AUTH')
    }
    throw new LlmError(
      `llm-workbuddy: token refresh failed (code ${String(envelope.code)}): ${envelope.message ?? 'no message'}`,
      'SERVER',
    )
  }
  const data = typeof body?.data === 'object' && body.data !== null ? body.data : {}
  if (typeof data.accessToken !== 'string' || data.accessToken.length === 0) {
    throw new LlmError('llm-workbuddy: token refresh returned no accessToken; sign in again', 'AUTH')
  }
  return {
    accessToken: data.accessToken,
    refreshToken: typeof data.refreshToken === 'string' && data.refreshToken.length > 0 ? data.refreshToken : undefined,
    expiresIn: Number.isFinite(data.expiresIn) ? Number(data.expiresIn) : 0,
    domain: typeof data.domain === 'string' && data.domain.length > 0 ? data.domain : undefined,
  }
}

/**
 * Normalize one `/v3/config` model entry into the adapter's live-catalog shape.
 *
 * Price facts are display-only: `credits` is the list price multiplier the
 * upstream publishes, `promotion` is the campaign covering the model right now,
 * and `priceLabel` is the compact string the model picker shows. Billing is
 * decided upstream per model and wall clock; nothing here reaches the request.
 */
function normalizeLiveModel(raw, { promotions = [], now = Date.now() } = {}) {
  if (typeof raw !== 'object' || raw === null) return undefined
  const id = typeof raw.id === 'string' ? raw.id.trim() : ''
  if (id.length === 0) return undefined
  if (/^(nes-|completion-|codewise-)/u.test(id)) return undefined
  if (Number.isFinite(raw.maxOutputTokens) && raw.maxOutputTokens > 0 && raw.maxOutputTokens <= 256) return undefined
  const tags = Array.isArray(raw.tags) ? raw.tags.map(String) : []
  if (tags.some((tag) => /(?:text|image)-to-(?:image|video)/u.test(tag))) return undefined
  const reasoning = typeof raw.reasoning === 'object' && raw.reasoning !== null ? raw.reasoning : undefined
  const supportedEfforts = Array.isArray(reasoning?.supportedEfforts)
    ? reasoning.supportedEfforts.map((effort) => String(effort).trim()).filter((effort) => effort.length > 0)
    : undefined
  const disable = reasoning?.canDisableThinking !== false
  let efforts = null
  if (raw.supportsReasoning !== false && supportedEfforts !== undefined) {
    efforts = disable ? [...new Set(['off', ...supportedEfforts])] : [...new Set(supportedEfforts)]
  }
  const requestedEffort =
    typeof reasoning?.defaultEffort === 'string' && reasoning.defaultEffort.length > 0
      ? reasoning.defaultEffort
      : reasoning?.effort
  const defaultEffort = typeof requestedEffort === 'string' && requestedEffort.length > 0 ? requestedEffort : undefined
  const credits = parseCreditMultiplier(raw.credits)
  const promotion = activePromotionFor(id, promotions)
  const price = buildPriceInfo({ credits, promotion })
  return {
    id,
    name: typeof raw.name === 'string' && raw.name.length > 0 ? raw.name : id,
    description: typeof raw.descriptionZh === 'string' && raw.descriptionZh.length > 0 ? raw.descriptionZh : undefined,
    contextWindow: Number.isFinite(raw.maxInputTokens) && raw.maxInputTokens > 0 ? Math.floor(raw.maxInputTokens) : undefined,
    maxTokens: Number.isFinite(raw.maxOutputTokens) && raw.maxOutputTokens > 0 ? Math.floor(raw.maxOutputTokens) : undefined,
    reasoningEfforts: efforts,
    defaultReasoningEffort: defaultEffort,
    supportsToolCall: raw.supportsToolCall !== false,
    supportsImages: raw.supportsImages === true,
    ...(credits === undefined ? {} : { credits }),
    ...(price.effectiveCredits === undefined ? {} : { effectiveCredits: price.effectiveCredits }),
    ...(price.priceLabel === undefined ? {} : { priceLabel: price.priceLabel }),
    ...(promotion === undefined ? {} : { promotion: promoteForDisplay(promotion) }),
    trial: false,
  }
}

/** Merge two live catalogs by model id, preferring the first list's fields. */
function mergeLiveCatalogs(primary, secondary) {
  const byId = new Map()
  for (const entry of primary) byId.set(entry.id, entry)
  for (const entry of secondary) if (!byId.has(entry.id)) byId.set(entry.id, entry)
  return [...byId.values()]
}

/**
 * Probe the live model catalog for one signed-in account.
 *
 * Every advertised channel UA is probed (desktop first, so its list prices win),
 * then the enterprise whitelist is consulted for the authoritative model set.
 *
 * @returns live model entries.
 */
export async function fetchLiveModels({ config, account, accessToken, signal }) {
  const realm = account.realm === 'global' ? 'global' : 'cn'
  const base = realmBaseURL(config, realm)
  const configURL = `${base}${CONFIG_PATH}`
  const enterpriseURL = `${realm === 'global' ? `${base}/v2/enterprises/personal/models` : `${base}${ENTERPRISE_MODELS_PATH}`}`
  const now = Date.now()
  const probes = []
  const promotions = []
  // Every probe refusing the token is an AUTH problem, not an empty catalog;
  // reporting EMPTY_RESPONSE there hides a signed-out account behind "no models".
  let authFailures = 0
  let answered = 0
  for (const userAgent of catalogUserAgents(config, realm)) {
    try {
      // eslint-disable-next-line no-await-in-loop
      const response = await fetchTimed(
        configURL,
        { method: 'GET', headers: catalogHeaders(config, account, accessToken, userAgent) },
        { headerTimeoutMs: config.requestHeaderTimeoutMs, signal, context: 'WorkBuddy model catalog' },
      )
      if (!response.ok) {
        answered += 1
        if (response.status === 401 || response.status === 403) authFailures += 1
        continue
      }
      // eslint-disable-next-line no-await-in-loop
      const body = await readJson(response, 'WorkBuddy model catalog')
      const envelope = envelopeOf(body)
      if (!envelopeOk(envelope)) continue
      answered += 1
      const models = Array.isArray(body?.data?.models) ? body.data.models : []
      // Only the first response carrying promotions wins; the other channel
      // publishes a different campaign set for the same models.
      if (promotions.length === 0 && Array.isArray(body?.data?.modelPromotions)) {
        promotions.push(...body.data.modelPromotions.map((entry) => normalizePromotion(entry, now)).filter(Boolean))
      }
      probes.push(models.map((model) => normalizeLiveModel(model, { promotions, now })).filter(Boolean))
    } catch {
      // A failed channel probe falls through to the next UA.
    }
  }
  try {
    const response = await fetchTimed(
      enterpriseURL,
      { method: 'GET', headers: catalogHeaders(config, account, accessToken, chatUA(config, realm)) },
      { headerTimeoutMs: config.requestHeaderTimeoutMs, signal, context: 'WorkBuddy model whitelist' },
    )
    if (response.ok) {
      const body = await readJson(response, 'WorkBuddy model whitelist')
      const envelope = envelopeOf(body)
      if (envelopeOk(envelope)) {
        const models = Array.isArray(body?.data?.models) ? body.data.models : []
        const agents = Array.isArray(body?.data?.agents) ? body.data.agents : []
        const cli = agents.find((agent) => agent?.name === 'cli')
        const whitelist = Array.isArray(cli?.models) ? new Set(cli.models.map(String)) : undefined
        const normalized = models
          .map((model) => normalizeLiveModel(model, { promotions, now }))
          .filter(Boolean)
          .filter((model) => whitelist === undefined || whitelist.has(model.id))
        probes.push(normalized)
      }
    }
  } catch {
    // Either probe is optional; the catalog probe above usually answers.
  }
  const merged = probes.reduce((catalog, list) => mergeLiveCatalogs(catalog, list), [])
  if (merged.length === 0) {
    if (answered > 0 && authFailures === answered) {
      throw new LlmError(`llm-workbuddy: the model catalog rejected the access token for account "${account.id}" (HTTP 401/403); sign in again`, 'AUTH')
    }
    throw new LlmError('llm-workbuddy: the live model catalog is empty', 'EMPTY_RESPONSE')
  }
  return merged
}

/**
 * Billing paths for the personal meter: CN serves the `/v2` spelling, global
 * tries the bare one first and only falls back on 404 (upstream kept both
 * spellings while the endpoint migrated).
 */
const USER_RESOURCE_PATHS = Object.freeze({
  cn: ['/v2/billing/meter/get-user-resource'],
  global: ['/billing/meter/get-user-resource', '/v2/billing/meter/get-user-resource'],
})
/** Enterprise cycle usage; upstream serves this one path for both realms. */
const ENTERPRISE_USAGE_PATH = '/v2/billing/meter/get-enterprise-user-usage'
/** Product code the personal meter filters packages on. */
const PRODUCT_CODE = 'p_tcaca'

/**
 * Daily check-in paths per realm.
 *
 * Only CN accounts have a check-in system: the endpoint exists solely as
 * `/v2/billing/meter/daily-checkin` and global accounts are skipped entirely
 * (three independent client implementations agree; the un-prefixed spelling is
 * dead code upstream). The array shape mirrors the quota paths so the caller
 * stays realm-agnostic.
 */
const CHECKIN_PATHS = Object.freeze({
  cn: ['/v2/billing/meter/daily-checkin'],
  global: [],
})

/**
 * Upstream text markers that mean "already checked in today" (idempotent
 * success). Code 10001 carries a double meaning upstream: today's check-in AND
 * "签到失败，请稍后重试" — the message decides, never the code alone.
 */
// No bare `already`: it matched every English failure sentence that happened to
// contain the word, turning a real failure into "already checked in".
const ALREADY_CHECKIN_MARKERS = ['已签到', '已经签到', 'already checked in', 'already signed in', 'already checkin']
/** Upstream markers that the account type has no check-in system at all. */
const ENTERPRISE_CHECKIN_MARKERS = ['企业账号', 'enterprise']

/** Normalize a business code to its string spelling. */
function businessCode(value) {
  return value === undefined || value === null ? '' : String(value).trim()
}

/** Whether one check-in envelope means "already signed in today". */
function isAlreadyCheckin(code, message) {
  const normalized = businessCode(code)
  if (normalized !== '10001' && normalized !== '14001') return false
  const text = typeof message === 'string' ? message.trim() : ''
  // An empty message on 10001/14001 is the idempotent-rejection shape; the
  // failure shape always carries text ("签到失败，请稍后重试").
  if (text.length === 0) return true
  const lower = text.toLowerCase()
  if (ENTERPRISE_CHECKIN_MARKERS.some((marker) => lower.includes(marker.toLowerCase()))) return false
  return ALREADY_CHECKIN_MARKERS.some((marker) => text.includes(marker) || lower.includes(marker.toLowerCase()))
}

/** Whether one check-in envelope means "this account type has no check-in". */
function isEnterpriseCheckin(message) {
  const text = typeof message === 'string' ? message.toLowerCase() : ''
  return ENTERPRISE_CHECKIN_MARKERS.some((marker) => text.includes(marker.toLowerCase()))
}

/** Classify one non-idempotent check-in failure. */
function classifyCheckinFailure({ status, code, message }) {
  const detail = `${businessCode(code)} ${message ?? ''}`.trim()
  const failure = (kind) =>
    new LlmError(
      `llm-workbuddy: the daily check-in failed (HTTP ${status}${detail.length > 0 ? `: ${detail}` : ''})`,
      kind,
      { status },
    )
  if (status === 401 || status === 403) return failure('AUTH')
  if (status === 429 || businessCode(code) === '14018') return failure('RATE_LIMIT')
  if (status >= 500 || businessCode(code) === '10000') return failure('SERVER')
  // 10001 with a "try again later" message is a transient upstream refusal, not
  // a permanent client error: surface it as SERVER so the retry sweep tries again.
  if (businessCode(code) === '10001' || businessCode(code) === '14001') return failure('SERVER')
  return failure('INVALID_REQUEST')
}

/**
 * Perform one daily check-in for a WorkBuddy account.
 *
 * The request mirrors the official desktop client's billing family: `POST
 * {billing}/v2/billing/meter/daily-checkin` with a literal `{}` body and the
 * billing header set (bearer token, identity headers, single-segment UA).
 *
 * @returns `{status, path?, message?, credit?, streakDays?, isStreakDay?}` where
 * status is `ok` (signed in now), `already` (idempotent rejection), or
 * `unsupported` (realm/account type has no check-in system). Non-idempotent
 * failures throw an `LlmError`. The reward fields come from the observed live
 * payload `{credit, streak_days, is_streak_day}` and are omitted when absent.
 */
export async function fetchCheckin({ config, account, accessToken, signal }) {
  const realm = account.realm === 'global' ? 'global' : 'cn'
  const paths = CHECKIN_PATHS[realm]
  // Global workbuddy.ai accounts have no check-in system; don't even fire a
  // request (the un-prefixed path in old gateways was dead code).
  if (paths.length === 0) return { status: 'unsupported', reason: 'the global realm has no daily check-in' }
  const base = billingBaseURL(config, realm)
  const headers = quotaHeaders({ config, account, accessToken })
  const body = '{}'
  const headerTimeoutMs = config.checkinTimeoutMs ?? config.quotaTimeoutMs ?? config.requestHeaderTimeoutMs
  let lastStatus = 0
  for (const path of paths) {
    // eslint-disable-next-line no-await-in-loop
    const response = await fetchTimed(
      `${base}${path}`,
      { method: 'POST', headers, body },
      { headerTimeoutMs, signal, context: 'WorkBuddy daily check-in request' },
    )
    lastStatus = response.status
    if (response.status === 404) continue
    // eslint-disable-next-line no-await-in-loop
    const payload = await readJson(response, 'WorkBuddy daily check-in')
    const envelope = envelopeOf(payload)
    const code = envelope.code
    const message = typeof envelope.message === 'string' ? envelope.message : ''
    const okEnvelope = response.ok && envelopeOk(envelope)
    if (okEnvelope) {
      const data = typeof payload?.data === 'object' && payload.data !== null ? payload.data : undefined
      const detail = typeof data?.message === 'string' ? data.message : ''
      const credit = billingNumber(data?.credit)
      const streakDays = billingNumber(data?.streak_days) ?? billingNumber(data?.streakDays)
      const isStreakDay = typeof data?.is_streak_day === 'boolean' ? data.is_streak_day : undefined
      return {
        status: 'ok',
        path,
        ...(detail.length === 0 ? {} : { message: detail }),
        ...(credit === undefined ? {} : { credit }),
        ...(streakDays === undefined ? {} : { streakDays }),
        ...(isStreakDay === undefined ? {} : { isStreakDay }),
      }
    }
    if (isEnterpriseCheckin(message)) {
      return { status: 'unsupported', path, reason: 'the account type has no daily check-in system', message: message || undefined }
    }
    if (isAlreadyCheckin(code, message)) {
      return { status: 'already', path, ...(message.length === 0 ? {} : { message }) }
    }
    throw classifyCheckinFailure({ status: response.status, code, message })
  }
  throw new LlmError(
    `llm-workbuddy: the daily check-in endpoint answered HTTP ${lastStatus} on every known path`,
    'INVALID_REQUEST',
    { status: lastStatus },
  )
}

/** The billing root for one realm (credits / quota meter). */
export function billingBaseURL(config, realm) {
  if (typeof config.billingBaseURL === 'string' && config.billingBaseURL.length > 0) return config.billingBaseURL
  return REALM_BILLING_URLS[realm === 'global' ? 'global' : 'cn']
}

/**
 * The UA the billing family sends: one `<product>/<clientVersion>` segment and
 * no CLI part. Derived from the chat UA so the product spelling stays in one
 * place; a configured `userAgent` wins.
 */
function billingUA(config, realm) {
  if (typeof config.userAgent === 'string' && config.userAgent.length > 0) return config.userAgent
  const chat = chatUA(config, realm)
  const first = chat.split(/\s+/u)[0]
  return first.length > 0 ? first : chat
}

/**
 * Headers for the billing family (`get-user-resource`, enterprise usage).
 *
 * The official client's billing shape differs from chat: bearer token,
 * `X-CodeBuddy-Request: 1`, language, single-segment UA, identity headers (with
 * `X-Tenant-Id` duplicating `X-Enterprise-Id`), the WorkBuddy product domain, and
 * the device token. It sends no Origin/Referer/X-Product/X-Requested-With.
 *
 * The product domain answers for every account regardless of the domain it
 * signed in through (verified on the personal meter), so legacy CodeBuddy-domain
 * accounts keep working without a re-login.
 */
export function quotaHeaders({ config, account, accessToken }) {
  const realm = account.realm === 'global' ? 'global' : 'cn'
  const domain = chatDomainHost(realm)
  const headers = {
    accept: 'application/json',
    'accept-encoding': 'gzip, compress, deflate, br',
    'accept-language': realm === 'global' ? 'en-US' : 'zh-CN',
    'content-type': 'application/json',
    'x-codebuddy-request': '1',
    'x-request-id': randomHex(16),
    'user-agent': billingUA(config, realm),
    'x-domain': domain,
  }
  const device = config.deviceToken || account.deviceToken
  if (typeof device === 'string' && device.length > 0) headers['x-device-token'] = device
  applyIdentityHeaders(headers, account, accessToken)
  return { ...attributionHeaders(), ...headers }
}

/** Classify one billing-response failure. */
function classifyQuotaFailure({ status, body }) {
  const envelope = envelopeOf(body)
  const detail = `${envelope.code ?? ''} ${envelope.message ?? ''}`.trim()
  const failure = (code) =>
    new LlmError(
      `llm-workbuddy: reading the account quota failed (HTTP ${status}${detail.length > 0 ? `: ${detail}` : ''})`,
      code,
      { status, ...envelope.requestId === undefined ? {} : { requestId: envelope.requestId } },
    )
  if (status === 402 || String(envelope.code) === '14018') return failure('QUOTA')
  if (status === 401 || status === 403) return failure('AUTH')
  if (status === 429) return failure('RATE_LIMIT')
  if (status >= 500) return failure('SERVER')
  return failure('INVALID_REQUEST')
}

/** Parse one upstream wall clock (`YYYY-MM-DD HH:mm:ss`, UTC+8) into ISO. */
function parseBillingTime(value) {
  if (typeof value !== 'string' || value.length === 0) return undefined
  const at = Date.parse(`${value.replace(' ', 'T')}+08:00`)
  return Number.isFinite(at) ? new Date(at).toISOString() : undefined
}

/** Format one epoch-millisecond instant as the billing wall clock (UTC+8). */
function formatBillingTime(ms) {
  const at = new Date(ms + 8 * 60 * 60 * 1000)
  const pad = (value) => String(value).padStart(2, '0')
  return `${at.getUTCFullYear()}-${pad(at.getUTCMonth() + 1)}-${pad(at.getUTCDate())} ${pad(at.getUTCHours())}:${pad(at.getUTCMinutes())}:${pad(at.getUTCSeconds())}`
}

/**
 * A finite number, or undefined.
 *
 * `null`, `''` and `false` are treated as absent: `Number(null)` is 0, which
 * would report a null credit balance as "0 remaining" and cool the account down
 * as if it were exhausted.
 */
function billingNumber(value) {
  if (value === null || value === undefined || value === '' || typeof value === 'boolean') return undefined
  const number = Number(value)
  return Number.isFinite(number) ? number : undefined
}

/**
 * Normalize one resource package of the personal meter.
 *
 * The meter prefers the rolling `Cycle*` window when the package has one and
 * falls back to the absolute `Capacity*` triple; `used` is derived from the size
 * and the remaining value the endpoint reports.
 */
function normalizeQuotaPackage(raw) {
  if (typeof raw !== 'object' || raw === null) return undefined
  const cycleSize = billingNumber(raw.CycleCapacitySize) ?? 0
  const absoluteSize = billingNumber(raw.CapacitySize) ?? 0
  const useCycle = cycleSize > 0
  const sizeRaw = useCycle ? cycleSize : absoluteSize
  const remainRaw = useCycle ? billingNumber(raw.CycleCapacityRemain) : billingNumber(raw.CapacityRemain)
  if (sizeRaw === undefined && remainRaw === undefined) return undefined
  let total = sizeRaw
  let remaining = remainRaw
  if (total !== undefined && remaining !== undefined) remaining = Math.min(Math.max(0, remaining), total)
  let used = useCycle ? billingNumber(raw.CycleCapacityUsed) : billingNumber(raw.CapacityUsed)
  if (used === undefined && total !== undefined && remaining !== undefined) used = Math.max(0, total - remaining)
  if (used !== undefined && total !== undefined && remaining !== undefined && used > total - remaining) {
    remaining = Math.max(0, total - used)
  }
  const deductionEnd = billingNumber(raw.DeductionEndTime)
  const expiresAt =
    deductionEnd !== undefined && deductionEnd > 0 && Number.isFinite(new Date(deductionEnd).getTime())
      ? new Date(deductionEnd).toISOString()
      : parseBillingTime(raw.ExpiredTime)
  const resetAt = parseBillingTime(raw.CycleEndTime) ?? parseBillingTime(raw.PackageEndTime)
  return {
    ...(typeof raw.PackageName === 'string' && raw.PackageName.length > 0 ? { name: raw.PackageName } : {}),
    ...(total === undefined ? {} : { total }),
    ...(remaining === undefined ? {} : { remaining }),
    ...(used === undefined ? {} : { used }),
    ...(resetAt === undefined ? {} : { resetAt }),
    ...(expiresAt === undefined ? {} : { expiresAt }),
  }
}

/**
 * Normalize the personal `get-user-resource` payload (`data.Response.Data`).
 *
 * Units are integer credits. `TotalDosage` is the server-side aggregate and can
 * exceed the per-package sum, so it lifts the total when it is larger.
 */
export function normalizeQuota(payload) {
  const data = typeof payload?.Response?.Data === 'object' && payload.Response.Data !== null ? payload.Response.Data : payload
  let rows = []
  if (Array.isArray(data?.Accounts)) rows = data.Accounts
  else if (Array.isArray(data?.accounts)) rows = data.accounts
  else if (Array.isArray(data)) rows = data
  const packs = rows.map(normalizeQuotaPackage).filter((pack) => pack !== undefined)
  if (packs.length === 0) return { kind: 'personal', supported: false, packs: [] }
  const sum = (key) => packs.reduce((total, pack) => total + (billingNumber(pack[key]) ?? 0), 0)
  let total = sum('total')
  const remaining = sum('remaining')
  const used = sum('used')
  const dosage = billingNumber(data?.TotalDosage)
  if (dosage !== undefined && dosage > total) total = dosage
  const resets = packs.map((pack) => pack.resetAt).filter((value) => typeof value === 'string')
  resets.sort()
  const packageCount = billingNumber(data?.TotalCount)
  return {
    kind: 'personal',
    supported: true,
    unit: 'credits',
    total,
    remaining,
    used,
    ...(packs.length === 1 && packs[0].name !== undefined ? { packName: packs[0].name } : {}),
    // Each package refreshes on its own cycle; the aggregate reset is the NEXT
    // one (earliest boundary), not the last package expiry (that used to show a
    // 2027 date while credits refresh next week).
    ...(resets.length === 0 ? {} : { resetAt: resets[0] }),
    ...(packageCount === undefined ? {} : { packageCount }),
    packs: packs.slice(0, 12),
  }
}

/**
 * Normalize the enterprise usage payload: `credit` is the credits consumed this
 * cycle and `limitNum` the allocation (`-1` = unlimited). Snake_case aliases are
 * accepted because the endpoint has served both spellings.
 */
export function normalizeEnterpriseQuota(payload) {
  const data = typeof payload?.Response?.Data === 'object' && payload.Response.Data !== null ? payload.Response.Data : payload
  const used = billingNumber(data?.credit) ?? billingNumber(data?.used_num)
  const limit = billingNumber(data?.limitNum) ?? billingNumber(data?.limit_num)
  if (used === undefined && limit === undefined) return { kind: 'enterprise', supported: false }
  const unlimited = limit === -1
  const roundedUsed = used === undefined ? undefined : Math.round(used)
  const remain = unlimited || limit === undefined || roundedUsed === undefined ? undefined : Math.max(0, limit - roundedUsed)
  const resetAt = parseBillingTime(data?.cycleResetTime) ?? parseBillingTime(data?.cycleEndTime)
  return {
    kind: 'enterprise',
    supported: true,
    unit: 'credits',
    ...(unlimited ? { unlimited: true } : {}),
    ...(limit === undefined || unlimited ? {} : { total: limit }),
    ...(roundedUsed === undefined ? {} : { used: roundedUsed }),
    ...(remain === undefined ? {} : { remaining: remain }),
    ...(resetAt === undefined ? {} : { resetAt }),
  }
}

/**
 * Read one account's credits/quota from the personal billing meter.
 *
 * Only a 404 moves to the sibling path spelling; every other failure is final
 * and classified like a chat failure so the caller can tell a bad credential
 * (`AUTH`) from an exhausted balance (`QUOTA`). Enterprise accounts answer the
 * personal meter with an empty package list, so their cycle quota is fetched
 * from the dedicated usage endpoint instead.
 * @returns `{quota, path, status}` where `quota` is a normalized view.
 */
export async function fetchQuota({ config, account, accessToken, signal }) {
  const realm = account.realm === 'global' ? 'global' : 'cn'
  const base = billingBaseURL(config, realm)
  const headers = quotaHeaders({ config, account, accessToken })
  const at = Date.now()
  const body = JSON.stringify({
    PageNumber: 1,
    PageSize: 100,
    ProductCode: PRODUCT_CODE,
    Status: [0, 3],
    PackageEndTimeRangeBegin: formatBillingTime(at),
    PackageEndTimeRangeEnd: formatBillingTime(at + 101 * 365 * 24 * 60 * 60 * 1000),
  })
  let lastStatus = 0
  for (const path of USER_RESOURCE_PATHS[realm]) {
    // eslint-disable-next-line no-await-in-loop
    const response = await fetchTimed(
      `${base}${path}`,
      { method: 'POST', headers, body },
      { headerTimeoutMs: config.quotaTimeoutMs ?? config.requestHeaderTimeoutMs, signal, context: 'WorkBuddy quota request' },
    )
    lastStatus = response.status
    if (response.status === 404) continue
    // eslint-disable-next-line no-await-in-loop
    const payload = await readJson(response, 'WorkBuddy quota')
    if (!response.ok) throw classifyQuotaFailure({ status: response.status, body: payload })
    const envelope = envelopeOf(payload)
    if (!envelopeOk(envelope)) {
      throw classifyQuotaFailure({ status: response.status, body: payload })
    }
    const personal = normalizeQuota(payload.data)
    if (personal.supported || (typeof account.enterpriseId === 'string' ? account.enterpriseId : '').length === 0) {
      return { quota: personal, path, status: response.status }
    }
    // eslint-disable-next-line no-await-in-loop
    const enterprise = await fetchEnterpriseQuota({ config, signal, headers, base })
    return { quota: enterprise ?? personal, path, status: response.status }
  }
  throw new LlmError(`llm-workbuddy: the billing endpoint answered HTTP ${lastStatus} on every known path`, 'INVALID_REQUEST', {
    status: lastStatus,
  })
}

/** Read one enterprise account's cycle quota; undefined when the endpoint is unavailable. */
async function fetchEnterpriseQuota({ config, signal, headers, base }) {
  const response = await fetchTimed(
    `${base}${ENTERPRISE_USAGE_PATH}`,
    { method: 'POST', headers, body: '{}' },
    { headerTimeoutMs: config.quotaTimeoutMs ?? config.requestHeaderTimeoutMs, signal, context: 'WorkBuddy enterprise quota request' },
  )
  if (!response.ok) return undefined
  const payload = await readJson(response, 'WorkBuddy enterprise quota')
  const envelope = envelopeOf(payload)
  if (!envelopeOk(envelope)) return undefined
  const quota = normalizeEnterpriseQuota(payload.data)
  return quota.supported ? quota : undefined
}
