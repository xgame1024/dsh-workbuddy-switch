/**
 * Multi-account store and pool for the WorkBuddy provider.
 *
 * Accounts are durable credential records owned by this plugin
 * (`llm-workbuddy/<id>`): each record holds the access/refresh token bundle and
 * the account identity needed for request headers. Configuration may also
 * declare bootstrap accounts whose tokens resolve through credential
 * references, which is convenient for headless or CI use.
 *
 * The pool owns per-account token rotation (single-flight refresh), account
 * selection, and failure cooldowns. It never writes credentials anywhere except
 * the DSH credential store.
 *
 * @module dsh-workbuddy-switch/accounts
 */

import { LlmError } from '@deepseek-ai/dsh-llm'
import { credentialKey, credentialRef } from '@deepseek-ai/dsh-credentials'
import { CREDENTIAL_SCOPE, REALM_UTC_OFFSET_MS, SETTINGS_SCOPE } from './config.js'
import {
  fetchCheckin,
  fetchLiveModels,
  fetchLoginAccount,
  fetchProfile,
  fetchQuota,
  pollLogin,
  refreshAccessToken,
  startLogin,
} from './upstream.js'

/** Account ids are credential-key segments: lowercase letters, digits, hyphens. */
const ACCOUNT_ID_PATTERN = /^[a-z][a-z0-9-]*$/u
/** How long a browser authorization attempt stays pollable. */
const LOGIN_TTL_MS = 15 * 60 * 1000
/** Poll cadence for one login attempt. */
const LOGIN_POLL_INTERVAL_MS = 3000
/** Stagger between two accounts during one check-in sweep (upstream anti-burst). */
const CHECKIN_ACCOUNT_GAP_MS = 500
/** How many days of check-in history the settings record keeps. */
const CHECKIN_HISTORY_DAYS = 7
/** Check-in statuses that need no further automatic attempt for the day. */
const CHECKIN_SETTLED = new Set(['ok', 'already', 'unsupported'])
/**
 * How long `most-credits` selection waits for missing credit snapshots before
 * ranking with what it has. Balance probes run in parallel and are cached for
 * `quotaRefreshMs`, so only a cold process pays this cost (once).
 */
const CREDIT_RANKING_WAIT_MS = 2000
/** Ranking tier for an account whose balance is unlimited (enterprise quota). */
const CREDIT_TIER_UNLIMITED = 0
/** Ranking tier for an account known to hold credits. */
const CREDIT_TIER_FUNDED = 1
/** Ranking tier for a balance that cannot be read (no meter, probe failed). */
const CREDIT_TIER_UNKNOWN = 2
/** Ranking tier for a balance known to be empty: tried last, as a last resort. */
const CREDIT_TIER_EMPTY = 3

/** Cooldown windows after one classified account failure. */
const COOLDOWN_MS = Object.freeze({
  AUTH: 10 * 60 * 1000,
  RATE_LIMIT: 2 * 60 * 1000,
  SERVER: 60 * 1000,
  TRANSPORT: 30 * 1000,
})

/** Current time in milliseconds. */
function now() {
  return Date.now()
}

/** The upstream calendar day key (`YYYY-MM-DD`, UTC+8) used for once-per-day work. */
export function localDayKey(date = new Date()) {
  return new Date(date.getTime() + REALM_UTC_OFFSET_MS).toISOString().slice(0, 10)
}

/** Derive a stable, credential-key-safe account id from a WorkBuddy uid. */
export function accountIdFromUid(uid) {
  const sanitized = String(uid)
    .toLowerCase()
    .replace(/[^a-z0-9-]+/gu, '-')
    .replace(/-+/gu, '-')
    .replace(/^-|-$/gu, '')
  const body = sanitized.length > 0 ? sanitized : 'account'
  return ACCOUNT_ID_PATTERN.test(body) ? body : `u-${body}`
}

/** Infer a realm from an account domain, mirroring the official client. */
export function realmOf(domain, fallback) {
  if (typeof domain === 'string' && domain.length > 0) {
    const normalized = domain.trim().toLowerCase()
    if (normalized === 'workbuddy.ai' || normalized.endsWith('.workbuddy.ai')) return 'global'
    if (normalized.length > 0) return 'cn'
  }
  return fallback === 'global' ? 'global' : 'cn'
}

/** Drop undefined values so a payload is valid JSON for the credential store. */
function compact(object) {
  const result = {}
  for (const [key, value] of Object.entries(object)) {
    if (value === undefined || value === null) continue
    result[key] = value
  }
  return result
}

/** Read a record payload as an object (the store may hand back JSON text). */
function payloadObject(record) {
  if (record === undefined) return undefined
  const payload = record.payload
  if (typeof payload === 'string') {
    try {
      return JSON.parse(payload)
    } catch {
      return undefined
    }
  }
  return typeof payload === 'object' && payload !== null ? payload : undefined
}

/** A stored account id, or `''` when the field is missing or malformed. */
function accountIdOf(value) {
  return typeof value === 'string' && ACCOUNT_ID_PATTERN.test(value) ? value : ''
}

/** Convert one stored payload into the pool's account shape. */
function accountFromPayload(id, payload) {
  if (payload === undefined) return undefined
  const accessToken = typeof payload.accessToken === 'string' && payload.accessToken.length > 0 ? payload.accessToken : undefined
  const refreshToken = typeof payload.refreshToken === 'string' && payload.refreshToken.length > 0 ? payload.refreshToken : undefined
  if (accessToken === undefined && refreshToken === undefined && typeof payload.uid !== 'string') return undefined
  return {
    id,
    source: 'record',
    uid: typeof payload.uid === 'string' && payload.uid.length > 0 ? payload.uid : undefined,
    nickname: typeof payload.nickname === 'string' && payload.nickname.length > 0 ? payload.nickname : undefined,
    accessToken,
    refreshToken,
    expiresAt: Number.isFinite(payload.expiresAt) ? payload.expiresAt : 0,
    domain: typeof payload.domain === 'string' && payload.domain.length > 0 ? payload.domain : undefined,
    realm: realmOf(payload.domain, payload.realm),
    enterpriseId: typeof payload.enterpriseId === 'string' ? payload.enterpriseId : '',
    deviceToken: typeof payload.deviceToken === 'string' && payload.deviceToken.length > 0 ? payload.deviceToken : undefined,
    updatedAt: Number.isFinite(payload.updatedAt) ? payload.updatedAt : 0,
  }
}

/** Convert one config bootstrap account into the pool's account shape. */
function accountFromConfig(entry, options) {
  return {
    id: entry.id,
    source: 'config',
    uid: entry.uid,
    nickname: entry.nickname,
    accessToken: undefined,
    refreshToken: undefined,
    accessTokenEnv: entry.accessTokenEnv,
    refreshTokenEnv: entry.refreshTokenEnv,
    expiresAt: 0,
    domain: entry.domain,
    realm: entry.realm ?? options.realm,
    enterpriseId: entry.enterpriseId ?? '',
    deviceToken: entry.deviceToken,
    updatedAt: 0,
    config: entry,
  }
}

/** Build the credential-store key for one account id. */
function keyOf(id) {
  return credentialKey(CREDENTIAL_SCOPE, id)
}

/** Whether a stored token is close enough to expiry to refresh. */
function needsRefresh(account, skewMs) {
  if (account.expiresAt === 0) return false
  return account.expiresAt - now() <= skewMs
}

/** Next 04:00 UTC+8, the WorkBuddy hard-cooldown boundary for exhausted credits. */
function nextLocalFourAM() {
  const shifted = now() + REALM_UTC_OFFSET_MS
  const at = new Date(shifted)
  at.setUTCHours(4, 0, 0, 0)
  if (at.getTime() <= shifted) at.setUTCDate(at.getUTCDate() + 1)
  return at.getTime() - REALM_UTC_OFFSET_MS
}

/** Sleep that honors an abort signal. */
function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new LlmError('llm-workbuddy: operation aborted', 'ABORTED'))
      return
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener?.('abort', onAbort)
      resolve()
    }, ms)
    const onAbort = () => {
      clearTimeout(timer)
      reject(new LlmError('llm-workbuddy: operation aborted', 'ABORTED'))
    }
    signal?.addEventListener?.('abort', onAbort, { once: true })
  })
}

/**
 * Wait for a group of probes, but no longer than `ms`.
 *
 * The timeout timer is cleared as soon as the probes settle (and unref'ed so a
 * headless run is never held open), which keeps one cold ranking pass from
 * leaving a stray timer behind.
 */
function boundedWait(promises, ms) {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms)
    timer.unref?.()
    Promise.allSettled(promises).then(() => {
      clearTimeout(timer)
      resolve()
    })
  })
}

/**
 * One plugin instance's account store, selection policy, and pending logins.
 */
export class AccountPool {
  /** @type {Map<string, Promise<object>>} in-flight refreshes, one per account. */
  #refreshes = new Map()

  /**
   * Ids removed during this process's lifetime, so an in-flight refresh or
   * hydration cannot write the record back after `removeAccount` deleted it.
   * Cleared when the same id signs in again.
   */
  #removed = new Set()
  /** @type {Map<string, {until: number, modelUntil: Map<string, number>, modelCause?: Map<string, string>, failures: number, cause?: string}>} */
  #state = new Map()
  /** Account id that served the last request (footer pill's "current account"). */
  #lastUsedId = undefined
  /** @type {Map<string, {realm: string, createdAt: number}>} */
  #logins = new Map()
  /** @type {{at: number, models: object[]} | undefined} */
  #discovered
  /** @type {Promise<object[]> | undefined} in-flight live catalog probe. */
  #discovering
  /** Runtime pin override: `undefined` follows the stored/config value, `''` means auto. */
  #pinned
  /** @type {{loaded: boolean, decided: boolean, pinnedAccount: string, previousAccount: string} | undefined} */
  #preference
  /** @type {Map<string, {at: number, value: object}>} quota snapshots per account. */
  #quotas = new Map()
  /** @type {Map<string, Promise<object>>} in-flight quota probes per account. */
  #quotaProbes = new Map()
  /** @type {Set<string>} pinned ids already reported as unavailable. */
  #pinWarned = new Set()
  /** @type {Map<string, {day: string, status: string, at: number, attempts: number, reason?: string, error?: string}>} */
  #checkins = new Map()
  /** Whether the persisted check-in record has been loaded. */
  #checkinsLoaded = false
  /** @type {Promise<void> | undefined} in-flight load of the check-in record. */
  #checkinsLoading
  /** @type {Promise<object> | undefined} in-flight all-account check-in sweep. */
  #checkinSweep
  /** @type {Map<string, Promise<object>>} in-flight check-ins per account. */
  #checkinProbes = new Map()
  /** @type {Promise<unknown> | undefined} serialized check-in state persistence. */
  #checkinSave

  /**
   * @param {object} deps
   * @param {object} deps.ctx plugin context (services via `ctx.get`).
   * @param {() => object} deps.options resolved plugin options reader.
   * @param {object} deps.logger cordis logger.
   */
  constructor({ ctx, options, logger }) {
    this.ctx = ctx
    this.options = options
    this.logger = logger
  }

  /** The credential service, or a diagnostic. */
  #credentials() {
    const credentials = this.ctx.get('credentials')
    if (credentials === undefined) {
      throw new LlmError(
        'llm-workbuddy: this composition has no credentials service; mount @deepseek-ai/dsh-credentials-local',
        'MISSING_CREDENTIAL',
      )
    }
    return credentials
  }

  /** Clean up expired login attempts. */
  #pruneLogins() {
    const cutoff = now() - LOGIN_TTL_MS
    for (const [state, attempt] of this.#logins) if (attempt.createdAt < cutoff) this.#logins.delete(state)
  }

  /** Every account this plugin can see: stored records plus config bootstrap entries. */
  async listAccounts() {
    const options = this.options()
    const credentials = this.#credentials()
    const accounts = new Map()
    let records = []
    try {
      records = await credentials.listRecords()
    } catch (error) {
      this.logger.warn(error)
    }
    for (const record of records) {
      const key = String(record.key)
      if (!key.startsWith(`${CREDENTIAL_SCOPE}/`)) continue
      const id = key.slice(CREDENTIAL_SCOPE.length + 1)
      if (!ACCOUNT_ID_PATTERN.test(id)) continue
      const stored = await credentials.readRecord(record.key)
      const account = accountFromPayload(id, payloadObject(stored))
      if (account !== undefined) accounts.set(id, account)
    }
    for (const entry of options.accounts) {
      const existing = accounts.get(entry.id)
      const configured = accountFromConfig(entry, options)
      accounts.set(entry.id, existing === undefined ? configured : { ...configured, ...existing, config: entry, source: 'record' })
    }
    return [...accounts.values()]
  }

  /** One account by id, or undefined. */
  async getAccount(id) {
    const accounts = await this.listAccounts()
    return accounts.find((account) => account.id === id)
  }

  /** Locate an existing account id for a uid, if one is stored. */
  async findByUid(uid) {
    const accounts = await this.listAccounts()
    return accounts.find((account) => account.uid === uid)
  }

  /** Credential key of the plugin's own preference record (never an account). */
  #preferenceKey() {
    return credentialKey(SETTINGS_SCOPE, 'preferences')
  }

  /** Load the persisted preference record once per process. */
  async #preferenceState() {
    if (this.#preference !== undefined) return this.#preference
    const credentials = this.#credentials()
    let stored
    try {
      const records = await credentials.listRecords()
      const key = this.#preferenceKey()
      const hit = records.find((record) => String(record.key) === key)
      if (hit !== undefined) stored = payloadObject(await credentials.readRecord(hit.key))
    } catch (error) {
      this.logger.warn(error)
    }
    const pinnedAccount = accountIdOf(stored?.pinnedAccount)
    const previousStored = accountIdOf(stored?.previousAccount)
    const previousAccount = previousStored === pinnedAccount ? '' : previousStored
    // `decided` separates "the user chose automatic" from "nothing is recorded
    // yet". A record written before the field existed only means something when
    // it carries an id, so it keeps deciding by that id. The previous pin is
    // history, never a decision: it must not enter this test.
    const decided = stored?.decided === true || pinnedAccount.length > 0
    this.#preference = { loaded: true, decided, pinnedAccount, previousAccount }
    return this.#preference
  }

  /**
   * Persist the choice: a pinned account id, or `''` for automatic pool
   * selection. Both are explicit decisions, so an empty id must win over the
   * configured `pinnedAccount` after a restart instead of falling back to it.
   *
   * `previousAccount` is the pin this one replaced, kept so the page can still
   * say "last used" after a reload. Omitting it keeps whatever the record
   * already holds; an id equal to `pinnedAccount` is stored as `''`, because one
   * account cannot be both the current and the previous choice.
   */
  async #savePreference({ pinnedAccount, previousAccount }) {
    const credentials = this.#credentials()
    let kept = (await this.#preferenceState()).previousAccount
    try {
      await credentials.modifyRecord(this.#preferenceKey(), async (current) => {
        // Merge onto the record as it is on disk: another window or the model
        // tool may have written it since this process loaded its copy, and a
        // whole-record overwrite would erase their change.
        const onDisk = accountIdOf(payloadObject(current)?.previousAccount)
        const next = previousAccount === undefined ? onDisk : previousAccount
        kept = next === pinnedAccount ? '' : next
        return { kind: 'grant', payload: { version: 3, decided: true, pinnedAccount, previousAccount: kept, updatedAt: now() } }
      })
    } catch (error) {
      this.logger.warn(`llm-workbuddy: could not persist the account pin: ${error.message}`)
    }
    this.#preference = { loaded: true, decided: true, pinnedAccount, previousAccount: kept === pinnedAccount ? '' : kept }
  }

  /**
   * The account every request should prefer: the runtime pin, then the stored
   * pin, then the configured `pinnedAccount` (empty = the pool picks).
   */
  async pinnedAccountId() {
    if (typeof this.#pinned === 'string') return this.#pinned
    const preference = await this.#preferenceState()
    if (preference.decided) return preference.pinnedAccount
    return this.options().pinnedAccount
  }

  /**
   * The account the current pin replaced, for the row the page labels "last
   * used". Empty until a switch has happened. It may name an account that has
   * since been removed; `quotaPayload` drops those before the page sees them.
   */
  async previousAccountId() {
    const preference = await this.#preferenceState()
    return preference.previousAccount
  }

  /**
   * The account the pool would pick with no pin — what the page labels
   * "current (automatic)". Ranked over the credit snapshots and no probe: by
   * the time the payload is assembled `accountViews({ quota: true })` has
   * already filled them, and a stale snapshot is still closer to the truth
   * than a second ranking rule written on the client.
   */
  async autoAccountId() {
    const accounts = await this.listAccounts()
    const [best] = this.#rankByCredits(accounts.filter((account) => this.#cooling(account.id, undefined) !== true))
    return best === undefined ? '' : best.account.id
  }

  /** Pin one signed-in account for every request, persisting the choice. */
  async pinAccount(id) {
    const account = await this.getAccount(id)
    if (account === undefined) {
      throw new LlmError(
        `llm-workbuddy: account "${id}" is not signed in; workbuddy_account action="list" shows the available ids`,
        'INVALID_REQUEST',
      )
    }
    // Read the pin being replaced before overwriting it: `pinnedAccountId()`
    // prefers the runtime field that the next line sets. With no pin the live
    // account is the pool's own pick — the row the page marks "current", and so
    // the one the person is switching away from.
    const replaced = (await this.pinnedAccountId()) || (await this.autoAccountId())
    this.#pinned = id
    this.#pinWarned.clear()
    await this.#savePreference({ pinnedAccount: id, previousAccount: replaced.length > 0 && replaced !== id ? replaced : undefined })
    return account
  }

  /**
   * Return to automatic pool selection, persisting that choice.
   *
   * The account being released becomes the page's "last used", so the page can
   * offer a way back to it. `remember: false` is for a removal: that id is
   * about to stop existing and must not become history — and whatever history
   * the record already holds stays, because releasing one pin is no reason to
   * forget an earlier one.
   */
  async unpinAccount({ remember = true } = {}) {
    const released = await this.pinnedAccountId()
    this.#pinned = ''
    this.#pinWarned.clear()
    await this.#savePreference({ pinnedAccount: '', previousAccount: remember && released.length > 0 ? released : undefined })
  }

  /** Persist the durable part of one account payload. */
  async saveAccount(id, payload) {
    // An in-flight refresh or hydration must not resurrect an account the user
    // just removed: the write would put its plaintext token back on disk.
    if (this.#removed.has(id)) {
      throw new LlmError(`llm-workbuddy: account "${id}" was removed while it was being refreshed`, 'MISSING_CREDENTIAL')
    }
    const credentials = this.#credentials()
    const cleaned = compact({ version: 1, ...payload, updatedAt: now() })
    await credentials.modifyRecord(keyOf(id), async () => ({ kind: 'grant', payload: cleaned }))
    return this.getAccount(id)
  }

  /** Remove one account record (config bootstrap entries remain). */
  async removeAccount(id) {
    const credentials = this.#credentials()
    this.#removed.add(id)
    await credentials.deleteRecord(keyOf(id))
    this.#state.delete(id)
    this.invalidateQuota(id)
    if ((await this.pinnedAccountId()) === id) await this.unpinAccount({ remember: false })
  }

  /** Resolve a credential reference to its current value. */
  async #resolveRef(name) {
    if (typeof name !== 'string' || name.length === 0) return undefined
    const credentials = this.ctx.get('credentials')
    if (credentials !== undefined) {
      try {
        const hit = await credentials.resolve(credentialRef(name))
        if (hit !== undefined && hit.value.length > 0) return hit.value
      } catch (error) {
        this.logger.warn(error)
      }
    }
    const ambient = process.env[name]
    return typeof ambient === 'string' && ambient.length > 0 ? ambient : undefined
  }

  /** Merge configuration-supplied credentials and identity into one account view. */
  async #hydrate(account) {
    const options = this.options()
    const merged = { ...account }
    if (merged.accessToken === undefined && merged.accessTokenEnv !== undefined) {
      merged.accessToken = await this.#resolveRef(merged.accessTokenEnv)
    }
    if (merged.refreshToken === undefined && merged.refreshTokenEnv !== undefined) {
      merged.refreshToken = await this.#resolveRef(merged.refreshTokenEnv)
    }
    if (merged.realm === undefined) merged.realm = options.realm
    // Fill a missing identity from the cheap profile endpoint, and persist it so
    // later requests carry request headers without a probe.
    if (merged.uid === undefined && merged.accessToken !== undefined) {
      try {
        const profile = await fetchProfile({ config: options, realm: merged.realm, accessToken: merged.accessToken })
        merged.uid = profile.uid
        merged.nickname = profile.nickname ?? merged.nickname
        // Config bootstrap accounts keep their secret in the credential
        // reference: persist identity only, never a copy of the env token.
        const payload =
          merged.source === 'config'
            ? compact({ uid: merged.uid, nickname: merged.nickname, domain: merged.domain, realm: merged.realm, enterpriseId: merged.enterpriseId })
            : this.#payloadOf(merged)
        await this.saveAccount(merged.id, payload)
      } catch (error) {
        this.logger.warn(`llm-workbuddy: could not resolve the profile for account "${merged.id}": ${error.message}`)
      }
    }
    return merged
  }

  /** The persisted part of one account view. */
  #payloadOf(account) {
    return compact({
      accessToken: account.accessToken,
      refreshToken: account.refreshToken,
      expiresAt: account.expiresAt,
      uid: account.uid,
      nickname: account.nickname,
      domain: account.domain,
      realm: account.realm,
      enterpriseId: account.enterpriseId,
      deviceToken: account.deviceToken,
    })
  }

  /** Single-flight token refresh for one account id. */
  #refresh(account) {
    const existing = this.#refreshes.get(account.id)
    if (existing !== undefined) return existing
    const options = this.options()
    const promise = (async () => {
      const refreshed = await refreshAccessToken({ config: options, account })
      const expiresAt = refreshed.expiresIn > 0 ? now() + refreshed.expiresIn * 1000 : account.expiresAt
      const domain = refreshed.domain ?? account.domain
      const next = {
        ...account,
        accessToken: refreshed.accessToken,
        refreshToken: refreshed.refreshToken ?? account.refreshToken,
        expiresAt,
        domain,
        realm: realmOf(domain, account.realm),
      }
      // The refresh already rotated the token upstream: if the write fails, the
      // caller must still get the new token, or the account is left holding a
      // persisted refresh token the upstream has already invalidated.
      try {
        await this.saveAccount(next.id, this.#payloadOf(next))
        this.logger.info(
          `llm-workbuddy: refreshed the token for account "${next.id}" (expires ${new Date(expiresAt).toISOString()})`,
        )
      } catch (error) {
        if (error?.code === 'MISSING_CREDENTIAL') throw error
        this.logger.warn(
          `llm-workbuddy: refreshed the token for "${next.id}" but could not persist it (${error?.message ?? String(error)}); the new token is used for this process only`,
        )
      }
      return next
    })().finally(() => this.#refreshes.delete(account.id))
    this.#refreshes.set(account.id, promise)
    return promise
  }

  /**
   * Resolve a usable access token for one account, refreshing it when it is
   * close to expiry.
   * @returns {{accessToken: string, account: object}}
   */
  async getAccessToken(id, { force = false } = {}) {
    const options = this.options()
    const stored = await this.getAccount(id)
    if (stored === undefined) {
      throw new LlmError(`llm-workbuddy: account "${id}" is not configured`, 'MISSING_CREDENTIAL')
    }
    let account = await this.#hydrate(stored)
    if (
      account.refreshToken !== undefined &&
      (force || account.accessToken === undefined || needsRefresh(account, options.refreshSkewMs))
    ) {
      try {
        account = await this.#hydrate(await this.#refresh(account))
      } catch (error) {
        if (account.accessToken !== undefined && !needsRefresh(account, 0)) {
          this.logger.warn(`llm-workbuddy: token refresh for "${id}" failed, using the still-valid access token: ${error.message}`)
        } else if (error instanceof LlmError) {
          throw error
        } else {
          throw new LlmError(`llm-workbuddy: refreshing account "${id}" failed: ${error.message}`, 'AUTH', { cause: error })
        }
      }
    }
    if (account.accessToken === undefined) {
      throw new LlmError(
        `llm-workbuddy: account "${id}" has no usable credential. Sign in again with the workbuddy_login tool (action "start" then "finish") or import a token with action "token".`,
        'MISSING_CREDENTIAL',
      )
    }
    return { accessToken: account.accessToken, account }
  }

  /**
   * Cached credits/quota snapshot for one account.
   * @param {string} id account id.
   * @param {{force?: boolean}} [input] `force` bypasses the snapshot cache.
   */
  async quotaFor(id, { force = false } = {}) {
    const options = this.options()
    const cached = this.#quotas.get(id)
    if (!force && cached !== undefined && now() - cached.at < options.quotaRefreshMs) {
      if (cached.error !== undefined) throw cached.error
      return cached.value
    }
    const inFlight = this.#quotaProbes.get(id)
    if (inFlight !== undefined) return inFlight
    const probe = (async () => {
      try {
        const { accessToken, account } = await this.getAccessToken(id)
        const result = await fetchQuota({ config: options, account, accessToken })
        const value = { ...result.quota, fetchedAt: new Date(now()).toISOString(), endpoint: result.path }
        this.#quotas.set(id, { at: now(), value })
        return value
      } catch (error) {
        // Cache the failure for one TTL so a passive `list` cannot hammer the meter.
        this.#quotas.set(id, { at: now(), error })
        throw error
      }
    })().finally(() => this.#quotaProbes.delete(id))
    this.#quotaProbes.set(id, probe)
    return probe
  }

  /** Drop cached quota snapshots (one account, or every account). */
  invalidateQuota(id) {
    if (typeof id === 'string' && id.length > 0) this.#quotas.delete(id)
    else this.#quotas.clear()
  }

  /* ── daily check-in ───────────────────────────────────────────── */

  /** Credential key of the plugin's own check-in record (never an account). */
  #checkinKey() {
    return credentialKey(SETTINGS_SCOPE, 'checkin')
  }

  /**
   * Load the persisted check-in history once per process.
   *
   * The record holds only public status data (`day`, `status`, `attempts`,
   * a short upstream error string) so a restart neither re-signs in nor loses
   * today's result. Tokens never touch it.
   */
  async #checkinState() {
    // Await the same load promise rather than a boolean: a second caller used to
    // return immediately with an empty map and treat today's settled accounts as
    // pending, which sent duplicate check-ins upstream.
    if (this.#checkinsLoading !== undefined) return this.#checkinsLoading
    if (this.#checkinsLoaded) return
    const credentials = this.ctx.get('credentials')
    if (credentials === undefined) return
    this.#checkinsLoading = this.#loadCheckins(credentials).finally(() => {
      this.#checkinsLoading = undefined
    })
    return this.#checkinsLoading
  }

  /** Read the persisted per-account check-in record into memory once. */
  async #loadCheckins(credentials) {
    this.#checkinsLoaded = true
    let stored
    try {
      const records = await credentials.listRecords()
      const key = this.#checkinKey()
      const hit = records.find((record) => String(record.key) === key)
      if (hit !== undefined) stored = payloadObject(await credentials.readRecord(hit.key))
    } catch (error) {
      this.logger.warn(`llm-workbuddy: could not read the check-in record: ${error.message}`)
    }
    const accounts = typeof stored?.accounts === 'object' && stored.accounts !== null ? stored.accounts : {}
    for (const [id, entry] of Object.entries(accounts)) {
      if (!ACCOUNT_ID_PATTERN.test(id) || typeof entry !== 'object' || entry === null) continue
      this.#checkins.set(id, {
        day: typeof entry.day === 'string' ? entry.day : '',
        status: typeof entry.status === 'string' ? entry.status : 'unknown',
        at: Number.isFinite(entry.at) ? entry.at : 0,
        attempts: Number.isFinite(entry.attempts) ? entry.attempts : 0,
        reason: typeof entry.reason === 'string' && entry.reason.length > 0 ? entry.reason : undefined,
        error: typeof entry.error === 'string' && entry.error.length > 0 ? entry.error : undefined,
        credit: Number.isFinite(entry.credit) ? entry.credit : undefined,
        streakDays: Number.isFinite(entry.streakDays) ? entry.streakDays : undefined,
        isStreakDay: typeof entry.isStreakDay === 'boolean' ? entry.isStreakDay : undefined,
      })
    }
  }

  /** Persist the check-in record; writes are serialized and pruned by age. */
  #queueCheckinSave() {
    const run = async () => {
      const credentials = this.ctx.get('credentials')
      if (credentials === undefined) return
      const cutoffDay = localDayKey(new Date(now() - CHECKIN_HISTORY_DAYS * 24 * 60 * 60 * 1000))
      const accounts = {}
      for (const [id, entry] of this.#checkins) {
        if (!ACCOUNT_ID_PATTERN.test(id)) continue
        if (entry.day.length > 0 && entry.day < cutoffDay) continue
        accounts[id] = {
          day: entry.day,
          status: entry.status,
          at: entry.at,
          attempts: entry.attempts,
          ...(entry.reason === undefined ? {} : { reason: entry.reason }),
          ...(entry.error === undefined ? {} : { error: entry.error }),
          ...(entry.credit === undefined ? {} : { credit: entry.credit }),
          ...(entry.streakDays === undefined ? {} : { streakDays: entry.streakDays }),
          ...(entry.isStreakDay === undefined ? {} : { isStreakDay: entry.isStreakDay }),
        }
      }
      await credentials.modifyRecord(this.#checkinKey(), async () => ({
        kind: 'grant',
        payload: { version: 1, accounts, updatedAt: now() },
      }))
    }
    this.#checkinSave = (this.#checkinSave ?? Promise.resolve())
      .then(run, run)
      .catch((error) => this.logger.warn(`llm-workbuddy: could not persist the check-in record: ${error.message}`))
    return this.#checkinSave
  }

  /** Record one check-in outcome and persist it. */
  async #recordCheckin(id, entry) {
    await this.#checkinState()
    const previous = this.#checkins.get(id)
    const sameDay = previous?.day === entry.day
    let attempts = 0
    if (entry.status === 'failed') attempts = entry.attempts ?? (sameDay ? previous.attempts + 1 : 1)
    else if (sameDay) attempts = previous.attempts ?? 0
    this.#checkins.set(
      id,
      compact({
        day: entry.day,
        status: entry.status,
        at: now(),
        attempts,
        reason: entry.reason,
        error: entry.error,
        credit: entry.credit,
        streakDays: entry.streakDays,
        isStreakDay: entry.isStreakDay,
      }),
    )
    await this.#queueCheckinSave()
  }

  /** Today's check-in view for one account (no network). */
  #checkinView(account, day = localDayKey()) {
    if ((account.realm ?? 'cn') === 'global') {
      return { accountId: account.id, status: 'unsupported', reason: 'the global realm has no daily check-in' }
    }
    if ((account.enterpriseId ?? '').length > 0) {
      return { accountId: account.id, status: 'unsupported', reason: 'enterprise accounts have no daily check-in system' }
    }
    const entry = this.#checkins.get(account.id)
    if (entry === undefined || entry.day !== day) return { accountId: account.id, status: 'pending' }
    return {
      accountId: account.id,
      status: entry.status,
      ...(entry.at > 0 ? { at: new Date(entry.at).toISOString() } : {}),
      ...(entry.attempts > 0 ? { attempts: entry.attempts } : {}),
      ...(entry.reason === undefined ? {} : { reason: entry.reason }),
      ...(entry.error === undefined ? {} : { error: entry.error }),
      ...(entry.credit === undefined ? {} : { credit: entry.credit }),
      ...(entry.streakDays === undefined ? {} : { streakDays: entry.streakDays }),
      ...(entry.isStreakDay === undefined ? {} : { isStreakDay: entry.isStreakDay }),
    }
  }

  /** Today's cached check-in status for every account (no upstream traffic). */
  async checkinViews() {
    await this.#checkinState()
    const accounts = await this.listAccounts()
    const day = localDayKey()
    return accounts.map((account) => this.#checkinView(account, day))
  }

  /**
   * Run the daily check-in for one account.
   *
   * Settled statuses (`ok` / `already` / `unsupported`) are served from today's
   * cache unless `force` is set. Enterprise and global-realm accounts are marked
   * unsupported without an upstream request. Upstream failures are recorded as
   * `failed` (never thrown) so a sweep can continue with the next account.
   */
  async checkinFor(id, { force = false } = {}) {
    await this.#checkinState()
    const account = await this.getAccount(id)
    if (account === undefined) {
      throw new LlmError(`llm-workbuddy: no WorkBuddy account "${id}"`, 'INVALID_REQUEST')
    }
    const day = localDayKey()
    const cached = this.#checkinView(account, day)
    if (!force && CHECKIN_SETTLED.has(cached.status)) return cached
    const inFlight = this.#checkinProbes.get(id)
    if (inFlight !== undefined) return inFlight
    const options = this.options()
    const promise = (async () => {
      try {
        const { accessToken, account: live } = await this.getAccessToken(id)
        const result = await fetchCheckin({ config: options, account: live, accessToken })
        if (result.status === 'unsupported') {
          await this.#recordCheckin(id, {
            day,
            status: 'unsupported',
            reason: result.reason ?? 'daily check-in is not supported for this account',
          })
        } else {
          await this.#recordCheckin(id, {
            day,
            status: result.status,
            ...(result.credit === undefined ? {} : { credit: result.credit }),
            ...(result.streakDays === undefined ? {} : { streakDays: result.streakDays }),
            ...(result.isStreakDay === undefined ? {} : { isStreakDay: result.isStreakDay }),
          })
          // Credits just changed: drop the cached balance so the next quota view
          // shows the post-check-in number instead of a pre-check-in snapshot.
          this.invalidateQuota(id)
          this.logger.info(
            `llm-workbuddy: daily check-in for account "${id}" ${result.status === 'already' ? 'was already done today' : 'succeeded'}`,
          )
        }
      } catch (error) {
        const previous = this.#checkins.get(id)
        const attempts = previous?.day === day ? (previous.attempts ?? 0) + 1 : 1
        const message = String(error?.message ?? error)
        await this.#recordCheckin(id, {
          day,
          status: 'failed',
          attempts,
          error: message.length > 300 ? `${message.slice(0, 300)}…` : message,
        })
        this.logger.warn(`llm-workbuddy: daily check-in for account "${id}" failed: ${message}`)
      }
      return this.#checkinView(account, day)
    })().finally(() => this.#checkinProbes.delete(id))
    this.#checkinProbes.set(id, promise)
    return promise
  }

  /**
   * Run today's check-in for every account (or one account).
   *
   * Concurrent full sweeps share one promise; per-account calls are single-flight
   * inside `checkinFor`, so an automatic sweep and a manual click never sign in
   * twice. Accounts are staggered to avoid an upstream burst.
   */
  async checkinAll({ accountId, force = false } = {}) {
    await this.#checkinState()
    const accounts = await this.listAccounts()
    const targetId = typeof accountId === 'string' && accountId.length > 0 ? accountId : undefined
    if (accounts.length === 0) {
      if (targetId !== undefined) throw new LlmError(`llm-workbuddy: no WorkBuddy account "${targetId}"`, 'INVALID_REQUEST')
      return { views: [], summary: summarizeCheckins([]) }
    }
    let targets = accounts
    if (targetId !== undefined) {
      targets = accounts.filter((account) => account.id === targetId)
      if (targets.length === 0) throw new LlmError(`llm-workbuddy: no WorkBuddy account "${targetId}"`, 'INVALID_REQUEST')
    } else if (this.#checkinSweep !== undefined) {
      return this.#checkinSweep
    }
    const sweep = (async () => {
      const views = []
      for (const account of targets) {
        // eslint-disable-next-line no-await-in-loop
        views.push(await this.checkinFor(account.id, { force }))
        if (views.length < targets.length) {
          // eslint-disable-next-line no-await-in-loop
          await sleep(CHECKIN_ACCOUNT_GAP_MS)
        }
      }
      return { views, summary: summarizeCheckins(views) }
    })()
    if (targetId !== undefined) return sweep
    this.#checkinSweep = sweep.finally(() => {
      this.#checkinSweep = undefined
    })
    return this.#checkinSweep
  }

  /** Whether any account still needs an automatic check-in attempt today. */
  async checkinPending({ maxAttempts = 4 } = {}) {
    await this.#checkinState()
    const accounts = await this.listAccounts()
    const day = localDayKey()
    for (const account of accounts) {
      const view = this.#checkinView(account, day)
      if (CHECKIN_SETTLED.has(view.status)) continue
      if (view.status === 'failed' && (view.attempts ?? 0) >= maxAttempts) continue
      return true
    }
    return false
  }

  /** The mutable failure state of one account, created on demand. */
  #stateOf(id) {
    const existing = this.#state.get(id)
    if (existing !== undefined) return existing
    const created = { until: 0, modelUntil: new Map(), failures: 0 }
    this.#state.set(id, created)
    return created
  }

  /** Record one success for an account, clearing its cooldowns. */
  markSuccess(id) {
    const state = this.#state.get(id)
    if (state !== undefined) {
      state.failures = 0
      state.until = 0
    }
  }

  /** Record one classified failure and put the account in cooldown. */
  markFailure(id, { model, failure }) {
    const code = failure?.code ?? 'SERVER'
    // 6004/6021 limits one model for one account at a time: cool that account
    // for that model only, so the pool can try the next account for it and other
    // models on the same account stay usable.
    if (code === 'MODEL_RATE_LIMIT') {
      const state = this.#stateOf(id)
      state.failures += 1
      state.cause = code
      if (model !== undefined) {
        const until = now() + Math.max(60 * 1000, failure?.providerRetryAfterMs ?? 10 * 60 * 1000)
        state.modelUntil.set(model, Math.max(state.modelUntil.get(model) ?? 0, until))
        this.#noteModelCause(state, model, code)
        this.logger.warn(
          `llm-workbuddy: account "${id}" is rate-limited for model "${model}" until ${new Date(until).toISOString()}; trying another account`,
        )
      }
      return
    }
    const state = this.#stateOf(id)
    state.failures += 1
    state.cause = code
    const hint = failure?.providerRetryAfterMs
    let delay
    // Floor at a minute: a quota failure one second before the reset would
    // otherwise cool the account for 1 ms and retry immediately in a tight loop.
    if (code === 'QUOTA' || code === 'ACCOUNT_QUOTA') delay = Math.max(60 * 1000, nextLocalFourAM() - now())
    else if (code === 'AUTH') delay = COOLDOWN_MS.AUTH
    else if (code === 'RATE_LIMIT') delay = Math.min(2 * 60 * 60 * 1000, (hint ?? COOLDOWN_MS.RATE_LIMIT) * Math.min(8, 2 ** (state.failures - 1)))
    else if (code === 'TRANSPORT') delay = COOLDOWN_MS.TRANSPORT
    else if (code === 'SERVER' || code === 'TIMEOUT') delay = COOLDOWN_MS.SERVER * Math.min(8, 2 ** (state.failures - 1))
    else delay = 0
    if (delay <= 0) return
    if (code === 'RATE_LIMIT' && model !== undefined) {
      state.modelUntil.set(model, now() + delay)
      this.#noteModelCause(state, model, code)
    } else {
      state.until = Math.max(state.until, now() + delay)
    }
    this.logger.warn(`llm-workbuddy: account "${id}" cooling down for ${Math.round(delay / 1000)}s after ${code}`)
  }

  /** Whether an account is cooling for one model. */
  #cooling(id, model) {
    const state = this.#state.get(id)
    if (state === undefined) return false
    if (state.until > now()) return true
    const until = state.modelUntil.get(model)
    if (until === undefined) return false
    if (until <= now()) {
      state.modelUntil.delete(model)
      return false
    }
    return true
  }

  /** Models every account is currently blocked for, for tools and the UI. */
  async modelLimits() {
    const accounts = await this.listAccounts()
    if (accounts.length === 0) return []
    const models = new Set()
    for (const account of accounts) {
      const state = this.#state.get(account.id)
      if (state === undefined) continue
      for (const [model, until] of state.modelUntil) if (until > now()) models.add(model)
    }
    const limits = []
    for (const model of models) {
      let until = Infinity
      let blockedForEveryAccount = true
      for (const account of accounts) {
        const accountUntil = this.#state.get(account.id)?.modelUntil.get(model) ?? 0
        if (accountUntil <= now()) {
          blockedForEveryAccount = false
          break
        }
        until = Math.min(until, accountUntil)
      }
      if (blockedForEveryAccount && Number.isFinite(until)) limits.push({ model, until: new Date(until).toISOString() })
    }
    return limits
  }

  /**
   * Select the next account to attempt for one model.
   *
   * Selection is always credit-first: the richest healthy account wins, so a
   * request drains the fullest balance first. A pinned account wins whenever it
   * is available; a pinned account that is cooling down, signed out, or already
   * attempted falls back to the pool so a temporary failure never hard-locks the
   * route.
   * @returns the account view, or undefined when no account can serve the request.
   */
  async selectAccount({ model, tried }) {
    const accounts = (await this.listAccounts()).filter((account) => !tried?.has(account.id))
    const usable = accounts.filter((account) => !this.#cooling(account.id, model))
    if (usable.length === 0) return undefined
    const pinnedId = await this.pinnedAccountId()
    if (pinnedId.length > 0) {
      const pinned = usable.find((account) => account.id === pinnedId)
      if (pinned !== undefined) return pinned
      if (!this.#pinWarned.has(pinnedId)) {
        this.#pinWarned.add(pinnedId)
        const known = accounts.some((account) => account.id === pinnedId)
        this.logger.warn(
          `llm-workbuddy: pinned account "${pinnedId}" ${known ? 'is cooling down' : 'is not signed in'}; falling back to the account pool`,
        )
      }
    }
    // Credits first: every request goes to the richest healthy account, and the
    // ranking is re-read after each failure, so the pool drains evenly.
    return this.#selectMostCredits(usable)
  }

  /**
   * Resolve the account one session is locked to.
   *
   * The caller must not fall back to another account: `prompt_cache_key` carries
   * the account uid, so switching costs a cold prefill and moves the spend to a
   * different balance. The answer therefore reports why the locked account cannot
   * serve instead of naming a substitute.
   * @param {{model: string, accountId: string}} input the model and the locked account id.
   * @returns {Promise<{account: object} | {blocked: {reason: string, code?: string, until?: number}}>}
   */
  async sessionAccount({ model, accountId }) {
    const account = await this.getAccount(accountId)
    if (account === undefined) return { blocked: { reason: 'signed-out' } }
    const state = this.#state.get(accountId)
    if (state === undefined) return { account }
    const nowMs = now()
    const modelUntil = state.modelUntil.get(model) ?? 0
    if (modelUntil > nowMs) return { blocked: { reason: 'model-limit', code: state.modelCause?.get(model), until: modelUntil } }
    if (state.until > nowMs) return { blocked: { reason: 'cooling', code: state.cause, until: state.until } }
    return { account }
  }

  /**
   * Record why one account is blocked for one model.
   *
   * `modelUntil` and the account-wide cooldown are independent, so the reason has
   * to travel with the model: a later failure on another model must not relabel
   * this one in the locked-session message.
   * @param {object} state one account's cooldown state.
   * @param {string} model the model the cooldown belongs to.
   * @param {string} code the failure code that caused it.
   */
  #noteModelCause(state, model, code) {
    state.modelCause ??= new Map()
    state.modelCause.set(model, code)
  }

  /**
   * Rank the usable accounts by their credit balance and return the richest.
   *
   * Balances come from cached billing snapshots: a request never blocks while a
   * fresh snapshot exists, a stale one is used while a refresh runs in the
   * background, and only a cold process (no snapshot at all) waits briefly for
   * the first probe so its very first pick is already right. Unlimited
   * enterprise quotas rank first, an unreadable balance ranks as unknown, and an
   * account known to be empty stays last so it is tried only as a last resort.
   */
  async #selectMostCredits(usable) {
    const options = this.options()
    const cold = usable.filter((account) => this.#quotas.get(account.id) === undefined)
    for (const account of usable) {
      const cached = this.#quotas.get(account.id)
      if (cached === undefined) continue
      if (now() - cached.at < options.quotaRefreshMs) continue
      if (this.#quotaProbes.has(account.id)) continue
      // Stale snapshot: refresh in the background and rank with the old value.
      this.quotaFor(account.id).catch(() => {})
    }
    if (cold.length > 0) {
      const probes = Promise.allSettled(cold.map((account) => this.quotaFor(account.id)))
      await boundedWait([probes], CREDIT_RANKING_WAIT_MS)
    }
    const ranked = this.#rankByCredits(usable)
    const best = ranked[0]
    if (best !== undefined) {
      this.logger.debug?.(`llm-workbuddy: most-credits picked "${best.account.id}" (${best.rank.label})`)
    }
    return best?.account
  }

  /**
   * Order accounts richest first. One rule, shared by account selection and the
   * page's "current (automatic)" row so the two can never disagree.
   * @param {object[]} accounts accounts to rank, in catalog order.
   */
  #rankByCredits(accounts) {
    return accounts
      .map((account, index) => ({ account, index, rank: this.#creditRankOf(account.id) }))
      .sort((left, right) => {
        if (left.rank.tier !== right.rank.tier) return left.rank.tier - right.rank.tier
        if (left.rank.remaining !== right.rank.remaining) return right.rank.remaining - left.rank.remaining
        // Equal balances keep the catalog's stable order.
        return left.index - right.index
      })
  }

  /**
   * One account's credit ranking: a tier plus a comparable remaining balance.
   * @returns `{tier: number, remaining: number, label: string}`
   */
  #creditRankOf(id) {
    const cached = this.#quotas.get(id)
    const quota = cached?.value
    if (quota === undefined) {
      return { tier: CREDIT_TIER_UNKNOWN, remaining: 0, label: 'balance not read' }
    }
    if (quota.unlimited === true) return { tier: CREDIT_TIER_UNLIMITED, remaining: 0, label: 'unlimited quota' }
    const remaining = Number.isFinite(quota.remaining) ? quota.remaining : undefined
    if (quota.supported === false || remaining === undefined) {
      return { tier: CREDIT_TIER_UNKNOWN, remaining: 0, label: 'balance unknown' }
    }
    if (remaining <= 0) return { tier: CREDIT_TIER_EMPTY, remaining: 0, label: '0 left' }
    return { tier: CREDIT_TIER_FUNDED, remaining, label: `${Math.round(remaining)} left` }
  }

  /**
   * Subtract the credits one finished request just spent from an account's
   * cached snapshot, so ranking tracks reality between billing probes.
   */
  noteCreditSpend(id, credits) {
    if (!Number.isFinite(credits) || credits <= 0) return
    const cached = this.#quotas.get(id)
    const quota = cached?.value
    if (quota === undefined || quota.unlimited === true || !Number.isFinite(quota.remaining)) return
    const remaining = Math.max(0, quota.remaining - credits)
    const next = { ...quota, remaining }
    if (Number.isFinite(quota.used)) next.used = quota.used + credits
    this.#quotas.set(id, { at: cached.at, value: next })
  }

  /** Remember the account that served this request (read back by the footer pill). */
  markUsed(id) {
    this.#lastUsedId = id
  }

  /** The account that served the most recent request, if any. */
  lastUsedAccountId() {
    return this.#lastUsedId
  }

  /** Human-readable account status rows for the tools. */
  async accountViews({ quota = false, forceQuota = false } = {}) {
    const accounts = await this.listAccounts()
    const pinnedId = await this.pinnedAccountId()
    return Promise.all(
      accounts.map(async (account) => {
        const state = this.#state.get(account.id)
        const coolingUntil = state?.until !== undefined && state.until > now() ? state.until : undefined
        const expiresAt = Number.isFinite(account.expiresAt) && account.expiresAt > 0 ? account.expiresAt : undefined
        let quotaView
        let quotaError
        if (quota) {
          try {
            quotaView = await this.quotaFor(account.id, { force: forceQuota })
          } catch (error) {
            quotaError = error?.message ?? String(error)
          }
        }
        return compact({
          id: account.id,
          uid: account.uid,
          nickname: account.nickname,
          realm: account.realm,
          enterprise: (account.enterpriseId ?? '').length > 0,
          source: account.source,
          configured: account.accessToken !== undefined || account.refreshToken !== undefined || account.accessTokenEnv !== undefined,
          pinned: account.id === pinnedId ? true : undefined,
          expiresAt: expiresAt === undefined ? undefined : new Date(expiresAt).toISOString(),
          expiresInSeconds: expiresAt === undefined ? undefined : Math.max(0, Math.round((expiresAt - now()) / 1000)),
          coolingUntil: coolingUntil === undefined ? undefined : new Date(coolingUntil).toISOString(),
          quota: quotaView,
          quotaError,
        })
      }),
    )
  }

  /** Store a login/import result as the account's durable record. */
  async storeLogin({ realm, bundle, identity, accountId }) {
    const options = this.options()
    const domain = bundle.domain ?? (realm === 'global' ? 'www.workbuddy.ai' : 'www.workbuddy.cn')
    const uid = identity.uid
    const id = accountId ?? (await this.findByUid(uid))?.id ?? accountIdFromUid(uid)
    if (!ACCOUNT_ID_PATTERN.test(id)) {
      throw new LlmError(`llm-workbuddy: account id "${id}" must be lowercase letters, digits, and hyphens`, 'INVALID_REQUEST')
    }
    // Signing in again is what un-does a removal for this id.
    this.#removed.delete(id)
    const expiresAt = bundle.expiresIn > 0 ? now() + bundle.expiresIn * 1000 : now() + 60 * 24 * 60 * 60 * 1000
    const account = await this.saveAccount(id, {
      accessToken: bundle.accessToken,
      refreshToken: bundle.refreshToken,
      expiresAt,
      uid,
      nickname: identity.nickname,
      domain,
      realm: realmOf(domain, realm ?? options.realm),
      enterpriseId: identity.enterpriseId ?? '',
    })
    // A fresh sign-in is a new chance for today's check-in: drop a failed
    // attempt record so the automatic sweep (or the next manual run) retries
    // instead of waiting for the daily attempt cap.
    await this.#checkinState()
    const priorCheckin = this.#checkins.get(id)
    if (priorCheckin !== undefined && priorCheckin.status === 'failed') {
      this.#checkins.delete(id)
      await this.#queueCheckinSave()
    }
    return account
  }

  /** Begin one browser authorization attempt; returns state and authorization URL. */
  async startLogin(realm) {
    this.#pruneLogins()
    const options = this.options()
    const normalized = realm === 'global' || realm === 'cn' ? realm : options.realm
    const started = await startLogin({ config: options, realm: normalized })
    this.#logins.set(started.state, { realm: normalized, createdAt: now() })
    return started
  }

  /** Poll one authorization attempt for up to `loginPollTimeoutMs`. */
  async finishLogin(state, { pollTimeoutMs } = {}) {
    const options = this.options()
    this.#pruneLogins()
    const attempt = this.#logins.get(state)
    if (attempt === undefined) {
      throw new LlmError('llm-workbuddy: unknown or expired login state; start the login again', 'INVALID_REQUEST')
    }
    const budget = Number.isFinite(pollTimeoutMs) ? Math.max(0, pollTimeoutMs) : options.loginPollTimeoutMs
    const deadline = now() + budget
    for (;;) {
      // eslint-disable-next-line no-await-in-loop
      const polled = await pollLogin({ config: options, realm: attempt.realm, state })
      if (polled.status === 'connected') {
        const identity = await this.#loginIdentity(attempt.realm, state, polled.bundle.accessToken)
        const account = await this.storeLogin({ realm: attempt.realm, bundle: polled.bundle, identity })
        this.#logins.delete(state)
        return { status: 'connected', account }
      }
      if (now() + LOGIN_POLL_INTERVAL_MS >= deadline) return { status: 'pending' }
      // eslint-disable-next-line no-await-in-loop
      await sleep(LOGIN_POLL_INTERVAL_MS)
    }
  }

  /** Fetch the identity for a completed authorization, with a fallback. */
  async #loginIdentity(realm, state, accessToken) {
    const options = this.options()
    try {
      return await fetchLoginAccount({ config: options, realm, state, accessToken })
    } catch (error) {
      this.logger.warn(`llm-workbuddy: the login account endpoint failed; falling back to the profile endpoint: ${error.message}`)
      return fetchProfile({ config: options, realm, accessToken })
    }
  }

  /** Import an existing token bundle (the "token login" path). */
  async importToken({ realm, accessToken, refreshToken, identity, accountId }) {
    const options = this.options()
    const normalized = realm === 'global' || realm === 'cn' ? realm : options.realm
    let resolvedIdentity = identity
    if (resolvedIdentity?.uid === undefined) {
      const profile = await fetchProfile({ config: options, realm: normalized, accessToken })
      resolvedIdentity = { uid: profile.uid, nickname: profile.nickname ?? identity?.nickname, enterpriseId: identity?.enterpriseId ?? '' }
    }
    const bundle = {
      accessToken,
      refreshToken,
      expiresIn: 0,
      domain: identity?.domain ?? (normalized === 'global' ? 'www.workbuddy.ai' : 'www.workbuddy.cn'),
    }
    return this.storeLogin({ realm: normalized, bundle, identity: resolvedIdentity, accountId })
  }

  /**
   * The catalog the adapter advertises: configured entries, with live entries
   * merged in when `discoverModels` is on and an account can answer.
   */
  async catalog({ signal } = {}) {
    const options = this.options()
    const fresh = this.#freshCatalog(options)
    if (fresh !== undefined) return fresh
    if (!options.discoverModels) return options.models
    // One probe at a time: a GUI catalog build resolves every advertised model
    // and must not fan out one upstream request per model.
    if (this.#discovering === undefined) {
      this.#discovering = this.#discoverCatalog({ signal }).finally(() => {
        this.#discovering = undefined
      })
    }
    return this.#discovering
  }

  /** Probe the live catalog through the first account that can answer. */
  async #discoverCatalog({ signal }) {
    const options = this.options()
    const accounts = await this.listAccounts()
    for (const account of accounts) {
      try {
        // eslint-disable-next-line no-await-in-loop
        const { accessToken } = await this.getAccessToken(account.id)
        // eslint-disable-next-line no-await-in-loop
        const live = await fetchLiveModels({ config: options, account, accessToken, signal })
        if (live.length > 0) {
          this.#discovered = { at: now(), models: live }
          return mergeCatalogs(options.models, live, options)
        }
      } catch (error) {
        this.logger.debug?.(`llm-workbuddy: live catalog probe through "${account.id}" failed: ${error.message}`)
      }
    }
    return options.models
  }

  /**
   * The catalog the adapter can read synchronously: the cached live entries
   * when they are still fresh, otherwise the configured list.
   *
   * `catalog()` is async because the first call probes the upstream, but a
   * request path that already has its catalog (`stream()`) must not fall back to
   * the configured list alone: a model that only the live catalog knows would
   * lose its image capability and its token limits.
   */
  catalogSnapshot() {
    const options = this.options()
    return this.#freshCatalog(options) ?? options.models
  }

  /** The merged catalog while the live copy is still fresh, or undefined. */
  #freshCatalog(options) {
    if (!options.discoverModels || this.#discovered === undefined) return undefined
    if (now() - this.#discovered.at >= options.discoveryCacheMs) return undefined
    return mergeCatalogs(options.models, this.#discovered.models, options)
  }

  /** Drop the live catalog cache (after login/removal). */
  invalidateCatalog() {
    this.#discovered = undefined
  }

  /** Dispose in-memory state; durable records are untouched. */
  dispose() {
    this.#refreshes.clear()
    this.#state.clear()
    this.#logins.clear()
    this.#discovered = undefined
    this.#discovering = undefined
    this.#quotas.clear()
    this.#quotaProbes.clear()
    this.#pinWarned.clear()
    this.#checkins.clear()
    this.#checkinProbes.clear()
    this.#checkinSweep = undefined
    this.#checkinSave = undefined
    this.#checkinsLoaded = false
    this.#pinned = undefined
    this.#preference = undefined
  }
}

/** Count one check-in sweep's outcomes for tools and the Settings page. */
export function summarizeCheckins(views) {
  const rows = Array.isArray(views) ? views : []
  let signed = 0
  let failed = 0
  let pending = 0
  let unsupported = 0
  for (const view of rows) {
    if (view?.status === 'ok' || view?.status === 'already') signed += 1
    else if (view?.status === 'failed') failed += 1
    else if (view?.status === 'unsupported') unsupported += 1
    else pending += 1
  }
  return { day: localDayKey(), total: rows.length, signed, failed, pending, unsupported }
}

/**
 * Merge configured catalog entries with live ones: configured fields win.
 *
 * Price facts come from the live catalog only (a configured entry never carries
 * them), so they are always adopted: `credits`/`effectiveCredits` are the list
 * and discounted multipliers, `priceLabel` the picker-facing string, and
 * `promotion` the campaign that produced it.
 */
export function mergeCatalogs(configured, live, options) {
  const fallbackContext = options?.defaultContextWindow ?? 1000000
  const fallbackMax = options?.defaultMaxTokens ?? 256000
  const priceFields = (entry) => ({
    ...(entry.credits === undefined ? {} : { credits: entry.credits }),
    ...(entry.effectiveCredits === undefined ? {} : { effectiveCredits: entry.effectiveCredits }),
    ...(entry.priceLabel === undefined ? {} : { priceLabel: entry.priceLabel }),
    ...(entry.promotion === undefined ? {} : { promotion: entry.promotion }),
  })
  const byId = new Map(configured.map((entry) => [entry.id, { ...entry }]))
  for (const entry of live) {
    const existing = byId.get(entry.id)
    if (existing === undefined) {
      byId.set(entry.id, {
        id: entry.id,
        name: entry.name ?? entry.id,
        description: entry.description,
        contextWindow: entry.contextWindow ?? fallbackContext,
        maxTokens: entry.maxTokens ?? fallbackMax,
        reasoningEfforts: entry.reasoningEfforts ?? null,
        defaultReasoningEffort: entry.defaultReasoningEffort,
        supportsToolCall: entry.supportsToolCall !== false,
        supportsImages: entry.supportsImages === true,
        ...priceFields(entry),
      })
      continue
    }
    existing.name = existing.name ?? entry.name
    existing.description = existing.description ?? entry.description
    existing.contextWindow = existing.contextWindow ?? entry.contextWindow
    existing.maxTokens = existing.maxTokens ?? entry.maxTokens
    existing.reasoningEfforts = existing.reasoningEfforts ?? entry.reasoningEfforts ?? null
    existing.defaultReasoningEffort = existing.defaultReasoningEffort ?? entry.defaultReasoningEffort
    // Vision is a live fact: an explicit configured choice wins, an unset one
    // adopts what the account's catalog reports.
    existing.supportsImages = existing.supportsImages ?? entry.supportsImages
    for (const [key, value] of Object.entries(priceFields(entry))) if (existing[key] === undefined) existing[key] = value
  }
  return [...byId.values()]
}
