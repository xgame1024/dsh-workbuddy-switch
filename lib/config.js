/**
 * Configuration schema, defaults, and validation for the WorkBuddy provider.
 *
 * The plugin config deliberately carries no account credentials: access and
 * refresh tokens live in credential records owned by this plugin
 * (`llm-workbuddy/<account>`), written by the login tools or a manually
 * prepared credentials document. The one secret-shaped key left in config is
 * `deviceToken` (the optional desktop `X-Device-Token`), kept for
 * compatibility; prefer `accounts[].accessTokenEnv` references over plaintext.
 *
 * @module dsh-workbuddy-switch/config
 */

import z from '@deepseek-ai/schemastery'
import { resolveRetryPolicy } from '@deepseek-ai/dsh-llm'

/** Provider route this plugin owns. */
export const PROVIDER = 'workbuddy'

/** Credential-record scope this plugin owns. */
export const CREDENTIAL_SCOPE = 'llm-workbuddy'

/**
 * Credential-record scope holding this plugin's own preferences (the pinned
 * account). Kept in a sibling scope so account enumeration, which only walks
 * `CREDENTIAL_SCOPE/…` keys, never mistakes a preference for an account.
 */
export const SETTINGS_SCOPE = 'llm-workbuddy-settings'

/** Chat/login/model roots for the two WorkBuddy realms. */
export const REALM_BASE_URLS = Object.freeze({
  cn: 'https://www.workbuddy.cn',
  global: 'https://www.workbuddy.ai',
})

/** Browser/authorization origins for the two realms. */
export const REALM_ORIGINS = Object.freeze({
  cn: 'https://www.workbuddy.cn',
  global: 'https://www.workbuddy.ai',
})

/** Product (web) domains used for the CN account profile endpoint. */
export const REALM_PRODUCT_URLS = Object.freeze({
  cn: 'https://www.workbuddy.cn',
  global: 'https://www.workbuddy.ai',
})

/**
 * The upstream's day boundary: every WorkBuddy daily reset (check-in, credit
 * refill at 04:00, quota window) follows the UTC+8 natural day regardless of
 * where the client runs. Shared by the account pool and the check-in scheduler
 * so the two can never disagree about which day it is.
 */
export const REALM_UTC_OFFSET_MS = 8 * 60 * 60 * 1000

/**
 * Official client versions echoed in the `WorkBuddy/<version>` and
 * `CLI/<version>` UA segments. Single source: the config defaults and
 * `resolveOptions` both read it, so the schema default and the runtime fallback
 * can never drift apart. A stale value shows up as an upstream channel check
 * (`11128`) rather than as a UA error.
 */
export const DEFAULT_CLIENT_VERSION = '5.9.3'
export const DEFAULT_CLI_VERSION = '2.165.0'

/**
 * Billing roots (credits / quota meter / check-in). Both realms serve billing
 * from their product host; CN used to answer on `www.codebuddy.cn` as well, and
 * `www.workbuddy.cn` returns the same payload (verified 2026-11-11).
 */
export const REALM_BILLING_URLS = Object.freeze({
  cn: 'https://www.workbuddy.cn',
  global: 'https://www.workbuddy.ai',
})

/**
 * Static reasoning-effort catalog shared by every catalog entry. Effort ids are
 * opaque adapter-owned identifiers; they are also the wire spelling WorkBuddy
 * accepts in `reasoning_effort`.
 */
export const EFFORT_CATALOG = Object.freeze({
  off: { name: 'Off', description: 'Disable thinking for simple tasks.' },
  minimal: { name: 'Minimal', description: 'Lowest supported thinking budget.' },
  low: { name: 'Low', description: 'Prefer for routine or latency-sensitive tasks.' },
  medium: { name: 'Medium', description: 'Balanced thinking budget.' },
  high: { name: 'High', description: 'The default balance for most tasks.' },
  xhigh: { name: 'Extra high', description: 'More thinking for harder tasks.' },
  max: { name: 'Max', description: 'Reserve for the hardest quality-first tasks.' },
})

/**
 * Built-in CN model catalog. Values are conservative upper bounds from the
 * WorkBuddy `/v3/config` catalog where known; live discovery replaces them at
 * runtime when an account is available (`discoverModels`).
 */
export const DEFAULT_MODELS = Object.freeze([
  {
    id: 'deepseek-v4.1-flash',
    name: 'DeepSeek V4.1 Flash',
    contextWindow: 1000000,
    maxTokens: 384000,
    reasoningEfforts: ['off', 'low', 'high', 'max'],
    defaultReasoningEffort: 'high',
    supportsToolCall: true,
    supportsImages: true,
  },
  {
    id: 'deepseek-v4-flash',
    name: 'DeepSeek V4 Flash',
    contextWindow: 1000000,
    maxTokens: 384000,
    reasoningEfforts: ['off', 'low', 'high', 'max'],
    defaultReasoningEffort: 'high',
    supportsToolCall: true,
    supportsImages: true,
  },
  {
    id: 'deepseek-v4-pro',
    name: 'DeepSeek V4 Pro',
    contextWindow: 1000000,
    maxTokens: 384000,
    reasoningEfforts: ['off', 'low', 'high', 'xhigh'],
    defaultReasoningEffort: 'high',
    supportsToolCall: true,
    supportsImages: true,
  },
  {
    id: 'glm-5.3',
    name: 'GLM 5.3',
    contextWindow: 200000,
    maxTokens: 128000,
    reasoningEfforts: ['off', 'low', 'high', 'max'],
    defaultReasoningEffort: 'high',
    supportsToolCall: true,
    supportsImages: true,
  },
  {
    id: 'glm-5.3-flash',
    name: 'GLM 5.3 Flash',
    contextWindow: 200000,
    maxTokens: 128000,
    reasoningEfforts: ['off', 'low', 'high', 'max'],
    defaultReasoningEffort: 'high',
    supportsToolCall: true,
    supportsImages: true,
  },
  {
    id: 'glm-5.2',
    name: 'GLM 5.2',
    contextWindow: 200000,
    maxTokens: 128000,
    reasoningEfforts: ['off', 'high', 'xhigh'],
    defaultReasoningEffort: 'high',
    supportsToolCall: true,
    supportsImages: true,
  },
  {
    id: 'kimi-k3-1',
    name: 'Kimi K3.1',
    contextWindow: 262144,
    maxTokens: 32768,
    reasoningEfforts: ['off', 'medium'],
    supportsToolCall: true,
    supportsImages: true,
  },
  {
    id: 'minimax-m3',
    name: 'MiniMax M3',
    contextWindow: 262144,
    maxTokens: 65536,
    reasoningEfforts: ['off', 'medium'],
    supportsToolCall: true,
  },
  {
    id: 'hy4-preview',
    name: 'Hunyuan 4 Preview',
    contextWindow: 131072,
    maxTokens: 65536,
    reasoningEfforts: ['off', 'high'],
    defaultReasoningEffort: 'high',
    supportsToolCall: true,
    supportsImages: true,
  },
  {
    id: 'hy3',
    name: 'Hunyuan 3',
    contextWindow: 131072,
    maxTokens: 32768,
    reasoningEfforts: ['off', 'low', 'high'],
    defaultReasoningEffort: 'high',
    supportsToolCall: true,
    supportsImages: true,
  },
])

/** One catalog entry: the model ids and capabilities the picker advertises. */
export const ModelEntry = z.object({
  id: z.string().required().description('Wire model id, e.g. "deepseek-v4.1-flash".'),
  name: z.string().description('Display name; defaults to the id.'),
  description: z.string().description('Optional one-line catalog description.'),
  contextWindow: z.number().description('Context window in tokens.'),
  maxTokens: z.number().description('Default output-token cap.'),
  reasoningEfforts: z
    .union([z.const(false), z.array(z.string())])
    .description("Supported reasoning-effort ids, or false for a non-reasoning model. Include 'off' to allow disabling thinking."),
  defaultReasoningEffort: z.string().description('Effort selected when a session has no explicit choice.'),
  supportsToolCall: z.boolean().description('Whether the model accepts tool declarations (advisory).'),
  supportsImages: z
    .boolean()
    .description(
      'Whether the model accepts image input. Unset adopts the live WorkBuddy catalog (text-only until an account confirms it); `true` advertises vision on every realm, `false` forces a text-only route.',
    ),
})

/** One bootstrap account declared in configuration instead of a credential record. */
export const ConfigAccount = z.object({
  id: z.string().required().description('Account id: lowercase letters, digits, and hyphens.'),
  uid: z.string().description('WorkBuddy account uid; fetched from the profile endpoint when omitted.'),
  nickname: z.string().description('Display name for the account.'),
  realm: z.union([z.const('cn'), z.const('global')]).description('Account realm; defaults to the provider realm.'),
  domain: z.string().description('Account product domain used for the `X-Domain` header.'),
  enterpriseId: z.string().description('Enterprise id, empty for personal accounts.'),
  deviceToken: z
    .string()
    .description('SECRET: optional desktop device token (`X-Device-Token`). Stored in the profile config in plaintext.'),
  accessTokenEnv: z.string().description('Credential reference (environment-variable name) holding the access token.'),
  refreshTokenEnv: z.string().description('Credential reference holding the refresh token.'),
})

/** Plugin configuration schema. */
export const Config = z.object({
  realm: z.union([z.const('cn'), z.const('global')]).default('cn').description('Default account realm; per-account values win.'),
  baseURL: z.string().default('').description('Override the realm chat/login root (testing or a proxy).'),
  billingBaseURL: z
    .string()
    .default('')
    .description(
      'Override the realm billing root used for quota lookups. Empty follows `baseURL` when that is set, else the realm default (CN `www.workbuddy.cn`, global `www.workbuddy.ai`).',
    ),
  clientVersion: z
    .string()
    .default(DEFAULT_CLIENT_VERSION)
    .description('`WorkBuddy/<clientVersion>` UA segment (official desktop version). A stale value surfaces as upstream code `11128`.'),
  cliVersion: z
    .string()
    .default(DEFAULT_CLI_VERSION)
    .description('`CLI/<cliVersion>` UA segment (official built-in CLI version). A stale value surfaces as upstream code `11128`.'),
  userAgent: z.string().default('').description('Override the whole User-Agent header.'),
  deviceToken: z
    .string()
    .default('')
    .description(
      'SECRET: default `X-Device-Token` for accounts that do not carry one. Stored in the profile config in plaintext; leave empty unless the upstream demands it.',
    ),
  discoverModels: z
    .boolean()
    .default(true)
    .description('Merge the live `/v3/config` catalog for the signed-in accounts into the advertised catalog.'),
  discoveryCacheMs: z.number().default(600000).description('How long a live catalog probe is reused.'),
  defaultContextWindow: z.number().default(1000000).description('Context capacity for models the catalog does not describe.'),
  defaultMaxTokens: z.number().default(256000).description('Output cap for models the catalog does not describe.'),
  defaultReasoningEffort: z.string().default('').description("Fallback default effort when a catalog entry names none."),
  imageInput: z
    .boolean()
    .default(true)
    .description(
      'ON by default: models that declare image support receive attached images as OpenAI-style `image_url` parts. Set false to force every route text-only (the harness then sends deterministic placeholders).',
    ),
  requestImagePixelBudget: z
    .number()
    .default(4194304)
    .description('Total-pixel budget one request image is resized to (same default as the other OpenAI-style routes: about 2048x2048).'),
  requestImageMaxBytes: z
    .number()
    .default(1048576)
    .description('Encoded-byte target for one request image (1 MiB); the encoder keeps the smallest quality-ladder output when none fits.'),
  maxRequestImageBytes: z
    .number()
    .default(20971520)
    .description('Aggregate base64 image budget for one request. Exceeding it fails with IMAGE_OFFLOAD_REQUIRED so the harness can offload the oldest images and retry.'),
  maxRequestImages: z.number().default(20).description('Maximum image occurrences one request may carry.'),
  imageOffloadCountQuantum: z
    .number()
    .default(5)
    .description('Minimum number of oldest images one image-offload retry removes, so a long history is not retried image by image.'),
  streamIdleTimeoutMs: z.number().default(300000).description('Maximum provider idle time between streamed chunks.'),
  requestHeaderTimeoutMs: z.number().default(120000).description('Deadline for response headers before a failure is surfaced.'),
  refreshSkewMs: z.number().default(600000).description('Refresh an account token this long before it expires.'),
  modelFallbacks: z
    .array(
      z.object({
        from: z.string().required().description('Model the request asked for.'),
        to: z.string().required().description('Unused; kept only so older profiles keep validating.'),
      }),
    )
    .default([])
    .description(
      'Deprecated since 0.7.0: the plugin no longer swaps models on its own. Accepted for compatibility and ignored — when every account rejects the selected model the request aborts with MODEL_UNAVAILABLE and asks the user to pick another model.',
    ),
  accountStrategy: z
    .union([z.const('sticky'), z.const('most-credits'), z.const('round-robin'), z.const('least-recently-used')])
    .default('most-credits')
    .description(
      'Deprecated since 0.7.0: account selection is always credit-first (the richest healthy account serves each request). The value is accepted for compatibility and ignored.',
    ),
  pinnedAccount: z
    .string()
    .default('')
    .description(
      'Account id that should serve every request. Empty = the pool stays in charge. The account tools and the Settings page can pin/unpin at runtime; an explicit choice (including handing selection back to the pool) wins over this value and is persisted in the credential store.',
    ),
  sessionAccountLock: z
    .union([z.const('hard'), z.const('off')])
    .default('hard')
    .description(
      'ON by default: the account that served a session keeps serving that session, so the prompt cache stays warm (the cache key carries the account uid) and the spend stays on one balance. When the locked account hits its quota or model limit the turn stops with an actionable error instead of quietly using another account, and the lock is dropped so the next request may pick one. "off" restores per-request pool selection.',
    ),
  quotaRefreshMs: z.number().default(60000).description('How long a fetched quota snapshot is reused before another billing probe.'),
  quotaTimeoutMs: z
    .number()
    .default(15000)
    .description('Header deadline for one billing probe. Quota display is a nicety, so it times out far sooner than a chat request.'),
  quotaInList: z.boolean().default(true).description('Include a quota snapshot in `workbuddy_account` list output (cached, failures degrade to "unknown").'),
  autoCheckin: z
    .boolean()
    .default(true)
    .description(
      'ON by default: after `autoCheckinHour` (UTC+8), the plugin runs the WorkBuddy daily check-in once per account per day, retrying a few times if the upstream is temporarily unavailable. Set false to disable automatic check-ins (manual check-in from the Settings page and the `workbuddy_account` tool still works).',
    ),
  autoCheckinHour: z
    .number()
    .default(8)
    .description('UTC+8 hour (0-23) after which the automatic daily check-in may run. When the harness starts later than this hour the check-in runs shortly after startup.'),
  checkinStartupDelayMs: z
    .number()
    .default(20000)
    .description('How long after the plugin mounts the first automatic check-in sweep runs (avoids competing with session startup).'),
  checkinRetryMinutes: z
    .number()
    .default(30)
    .description('Retry cadence for accounts whose check-in has not succeeded today. The sweep stops on its own once every account is signed in for the day.'),
  checkinMaxAttempts: z
    .number()
    .default(4)
    .description('Maximum automatic check-in attempts per account per day (manual check-ins are not capped).'),
  checkinTimeoutMs: z
    .number()
    .default(15000)
    .description('Header deadline for one daily check-in request. Check-in is a background nicety, so it times out far sooner than a chat request.'),
  promptCacheKey: z.boolean().default(true).description('Send a stable `prompt_cache_key` per account and session.'),
  loginPollTimeoutMs: z.number().default(20000).description('How long `workbuddy_login finish` waits for one authorization attempt.'),
  models: z
    .array(ModelEntry)
    .default([])
    .description(
      'Replace the built-in model catalog. Empty falls back to the built-in list. Declared here so a schema write-back does not drop it.',
    ),
  accounts: z.array(ConfigAccount).default([]).description('Bootstrap accounts whose tokens come from credential references.'),
  retryPolicy: z
    .object({
      mode: z.union([z.const('normal'), z.const('always')]),
      maxRetries: z.number(),
      retryableCodes: z.array(z.string()),
      backoff: z.object({ initialDelayMs: z.number(), maxDelayMs: z.number(), jitterRatio: z.number() }),
    })
    .description('Provider-owned retry policy executed by dsh-llm-retry.'),
})

/** Whether a value is a positive finite number. */
function isPositiveNumber(value) {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
}

/** A non-empty string as itself, anything else as undefined. */
function str(value) {
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

/** Normalize one catalog entry; throws on a config the adapter cannot serve. */
export function normalizeModelEntry(raw, fallback) {
  const id = typeof raw?.id === 'string' ? raw.id.trim() : ''
  if (id.length === 0) throw new Error('llm-workbuddy: every `models` entry needs a non-empty id')
  const contextWindow = isPositiveNumber(raw.contextWindow) ? Math.floor(raw.contextWindow) : fallback.contextWindow
  const maxTokens = isPositiveNumber(raw.maxTokens) ? Math.floor(raw.maxTokens) : fallback.maxTokens
  const efforts = Array.isArray(raw.reasoningEfforts)
    ? raw.reasoningEfforts.map((effort) => String(effort).trim()).filter((effort) => effort.length > 0)
    : null
  return {
    id,
    name: typeof raw.name === 'string' && raw.name.trim().length > 0 ? raw.name.trim() : id,
    description: str(raw.description),
    contextWindow,
    maxTokens,
    reasoningEfforts: efforts !== null && efforts.length > 0 ? [...new Set(efforts)] : null,
    defaultReasoningEffort: str(raw.defaultReasoningEffort),
    supportsToolCall: raw.supportsToolCall !== false,
    supportsImages: typeof raw.supportsImages === 'boolean' ? raw.supportsImages : undefined,
  }
}

/**
 * Normalize one absolute http(s) root, dropping trailing slashes.
 * @param {string} value candidate root.
 * @param {string} label field name for diagnostics.
 * @returns the normalized root.
 */
function normalizeBaseURL(value, label) {
  const trimmed = String(value).replace(/\/+$/u, '')
  let parsed
  try {
    parsed = new URL(trimmed)
  } catch {
    throw new Error(`llm-workbuddy: ${label} ${JSON.stringify(trimmed)} is not an absolute http(s) URL`)
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    throw new Error(`llm-workbuddy: ${label} ${JSON.stringify(trimmed)} must use http(s)`)
  }
  return trimmed
}

/** Normalize the `models` list into the catalog and its id index. */
function normalizeModels(entries, fallback) {
  const models = entries.map((entry) => normalizeModelEntry(entry, fallback))
  const byId = new Map()
  for (const model of models) {
    if (byId.has(model.id)) throw new Error(`llm-workbuddy: duplicate model id "${model.id}" in \`models\``)
    byId.set(model.id, model)
  }
  return { models, byId }
}

/** Normalize the bootstrap `accounts` list, rejecting malformed or duplicate ids. */
function normalizeAccounts(entries, realm) {
  const seen = new Set()
  return entries.map((account) => {
    const id = typeof account.id === 'string' ? account.id.trim() : ''
    if (!/^[a-z][a-z0-9-]*$/u.test(id)) {
      throw new Error(`llm-workbuddy: account id ${JSON.stringify(id)} must match /^[a-z][a-z0-9-]*$/`)
    }
    if (seen.has(id)) throw new Error(`llm-workbuddy: duplicate account id "${id}"`)
    seen.add(id)
    return {
      id,
      uid: str(account.uid),
      nickname: str(account.nickname),
      realm: account.realm === 'global' || account.realm === 'cn' ? account.realm : realm,
      domain: str(account.domain),
      enterpriseId: typeof account.enterpriseId === 'string' && account.enterpriseId.length > 0 ? account.enterpriseId : '',
      deviceToken: str(account.deviceToken),
      accessTokenEnv: str(account.accessTokenEnv),
      refreshTokenEnv: str(account.refreshTokenEnv),
    }
  })
}

/** Resolve a whole plugin Config value into detached, validated options. */
export function resolveOptions(config, env = process.env) {
  if (config === undefined || config === null) throw new Error('llm-workbuddy: missing configuration')
  const realm = config.realm === 'global' ? 'global' : 'cn'
  const overrideBase = typeof config.baseURL === 'string' ? config.baseURL.trim() : ''
  const envBase = typeof env.WORKBUDDY_BASE_URL === 'string' ? env.WORKBUDDY_BASE_URL.trim() : ''
  const baseURL = normalizeBaseURL(overrideBase || envBase || REALM_BASE_URLS[realm], 'baseURL')
  // Quota lookups use the billing family, which lives on a different host than
  // chat for CN. `baseURL` overrides (tests/proxies) win so a single mock can
  // serve both families; otherwise the probe targets the realm's billing root.
  const overrideBilling = typeof config.billingBaseURL === 'string' ? config.billingBaseURL.trim() : ''
  const envBilling = typeof env.WORKBUDDY_BILLING_BASE_URL === 'string' ? env.WORKBUDDY_BILLING_BASE_URL.trim() : ''
  const billingBaseURL = normalizeBaseURL(
    overrideBilling || envBilling || (overrideBase || envBase ? baseURL : REALM_BILLING_URLS[realm]),
    'billingBaseURL',
  )
  const fallback = {
    contextWindow: Math.floor(isPositiveNumber(config.defaultContextWindow) ? config.defaultContextWindow : 1000000),
    maxTokens: Math.floor(isPositiveNumber(config.defaultMaxTokens) ? config.defaultMaxTokens : 256000),
  }
  const rawModels = Array.isArray(config.models) && config.models.length > 0 ? config.models : DEFAULT_MODELS
  const { models, byId } = normalizeModels(rawModels, fallback)
  const globalDefaultEffort = str(config.defaultReasoningEffort)
  const normalizedAccounts = normalizeAccounts(Array.isArray(config.accounts) ? config.accounts : [], realm)
  const pinnedAccount = typeof config.pinnedAccount === 'string' ? config.pinnedAccount.trim() : ''
  if (pinnedAccount.length > 0 && !/^[a-z][a-z0-9-]*$/u.test(pinnedAccount)) {
    throw new Error(`llm-workbuddy: pinnedAccount ${JSON.stringify(pinnedAccount)} must match /^[a-z][a-z0-9-]*$/`)
  }
  const rawRetryPolicy = config.retryPolicy
  const retryPolicyInput =
    typeof rawRetryPolicy === 'object' && rawRetryPolicy !== null && (rawRetryPolicy.mode === 'normal' || rawRetryPolicy.mode === 'always')
      ? rawRetryPolicy
      : undefined
  const maxRequestImages = Math.max(1, Math.floor(isPositiveNumber(config.maxRequestImages) ? config.maxRequestImages : 20))
  const imageOffloadCountQuantum = Math.min(
    maxRequestImages,
    Math.max(1, Math.floor(isPositiveNumber(config.imageOffloadCountQuantum) ? config.imageOffloadCountQuantum : 5)),
  )
  return {
    realm,
    baseURL,
    billingBaseURL,
    origin: REALM_ORIGINS[realm],
    productURL: REALM_PRODUCT_URLS[realm],
    clientVersion:
      typeof config.clientVersion === 'string' && config.clientVersion.length > 0 ? config.clientVersion : DEFAULT_CLIENT_VERSION,
    cliVersion: typeof config.cliVersion === 'string' && config.cliVersion.length > 0 ? config.cliVersion : DEFAULT_CLI_VERSION,
    userAgent: typeof config.userAgent === 'string' ? config.userAgent.trim() : '',
    deviceToken: typeof config.deviceToken === 'string' ? config.deviceToken.trim() : '',
    models,
    modelsById: byId,
    globalDefaultEffort,
    discoverModels: config.discoverModels !== false,
    discoveryCacheMs: Math.max(0, Number.isFinite(config.discoveryCacheMs) ? config.discoveryCacheMs : 600000),
    imageInput: config.imageInput !== false,
    requestImagePixelBudget: Math.floor(
      isPositiveNumber(config.requestImagePixelBudget) ? config.requestImagePixelBudget : 4194304,
    ),
    requestImageMaxBytes: Math.floor(isPositiveNumber(config.requestImageMaxBytes) ? config.requestImageMaxBytes : 1048576),
    maxRequestImageBytes: Math.floor(
      isPositiveNumber(config.maxRequestImageBytes) ? config.maxRequestImageBytes : 20971520,
    ),
    maxRequestImages,
    imageOffloadCountQuantum,
    defaultContextWindow: fallback.contextWindow,
    defaultMaxTokens: fallback.maxTokens,
    streamIdleTimeoutMs: Math.max(1000, Number.isFinite(config.streamIdleTimeoutMs) ? config.streamIdleTimeoutMs : 300000),
    requestHeaderTimeoutMs: Math.max(1000, Number.isFinite(config.requestHeaderTimeoutMs) ? config.requestHeaderTimeoutMs : 120000),
    refreshSkewMs: Math.max(0, Number.isFinite(config.refreshSkewMs) ? config.refreshSkewMs : 600000),
    pinnedAccount,
    sessionAccountLock: config.sessionAccountLock === 'off' ? 'off' : 'hard',
    quotaRefreshMs: Math.max(5000, Number.isFinite(config.quotaRefreshMs) ? config.quotaRefreshMs : 60000),
    quotaTimeoutMs: Math.max(2000, Number.isFinite(config.quotaTimeoutMs) ? config.quotaTimeoutMs : 15000),
    quotaInList: config.quotaInList !== false,
    autoCheckin: config.autoCheckin !== false,
    autoCheckinHour: Math.min(
      23,
      Math.max(0, Math.floor(Number.isFinite(config.autoCheckinHour) ? config.autoCheckinHour : 8)),
    ),
    checkinStartupDelayMs: Math.max(
      0,
      Number.isFinite(config.checkinStartupDelayMs) ? config.checkinStartupDelayMs : 20000,
    ),
    checkinRetryMinutes: Math.max(1, Number.isFinite(config.checkinRetryMinutes) ? config.checkinRetryMinutes : 30),
    checkinMaxAttempts: Math.max(
      1,
      Math.floor(Number.isFinite(config.checkinMaxAttempts) ? config.checkinMaxAttempts : 4),
    ),
    checkinTimeoutMs: Math.max(2000, Number.isFinite(config.checkinTimeoutMs) ? config.checkinTimeoutMs : 15000),
    promptCacheKey: config.promptCacheKey !== false,
    loginPollTimeoutMs: Math.max(3000, Number.isFinite(config.loginPollTimeoutMs) ? config.loginPollTimeoutMs : 20000),
    accounts: normalizedAccounts,
    retryPolicy: resolveRetryPolicy(retryPolicyInput, 'llm-workbuddy: retryPolicy'),
  }
}

/**
 * Resolve one catalog entry's effective capability facts, including the
 * catalog-relative reasoning choices surfaced to the model selector.
 */
export function resolveModelCapability(options, model) {
  const entry = options.modelsById.get(model)
  const contextWindow = entry?.contextWindow ?? options.defaultContextWindow
  const maxTokens = entry?.maxTokens ?? options.defaultMaxTokens
  const efforts = entry?.reasoningEfforts ?? null
  let reasoning
  if (efforts !== null && efforts.length > 0) {
    const effortList = efforts.map((id) => ({
      id,
      name: EFFORT_CATALOG[id]?.name ?? id,
      description: EFFORT_CATALOG[id]?.description,
    }))
    const offered = new Set(effortList.map((effort) => effort.id))
    const configuredDefault = entry?.defaultReasoningEffort ?? options.globalDefaultEffort
    const resolvedDefault =
      configuredDefault !== undefined && offered.has(configuredDefault)
        ? configuredDefault
        : effortList.find((effort) => effort.id !== 'off')?.id
    reasoning = resolvedDefault === undefined ? { efforts: effortList } : { efforts: effortList, defaultEffort: resolvedDefault }
  }
  return {
    entry,
    contextWindow,
    maxTokens,
    reasoning,
    inputModalities: options.imageInput !== false && entry?.supportsImages === true ? ['text', 'image'] : ['text'],
  }
}
