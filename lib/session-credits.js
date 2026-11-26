/**
 * Per-session credit spend with a durable copy.
 *
 * The footer pill reads one number per session ("本会话 3.2"): the sum of the
 * `usage.credit` every completion reports. It used to live in a single in-memory
 * Map, so restarting DSH threw the whole statistic away and a resumed session
 * started from 0 again. This store keeps the same view but writes it to the
 * plugin's own settings record, the way the check-in record is kept: only the
 * session id, the accumulated credits, the account and model that spent them,
 * and a timestamp — never a token.
 *
 * Freshness rules, all applied on write so the record cannot grow without bound:
 * at most `max` sessions and nothing whose last spend is older than `keepMs`.
 *
 * @module dsh-workbuddy-switch/session-credits
 */

/** Sessions kept in the record; the least recently active is dropped first. */
const MAX_SESSIONS = 200
/** A session whose last spend is older than this is pruned when the record is rewritten. */
const KEEP_MS = 30 * 24 * 60 * 60 * 1000
/** Session keys are harness session ids; anything else is not worth a record slot. */
const SESSION_KEY_PATTERN = /^[\w.:-]{1,200}$/u
/** Bucket used when the harness hands over no session id at all. */
const FALLBACK_KEY = 'unknown'
/** Window that coalesces spend writes: one record rewrite per window, not per turn. */
const SAVE_DEBOUNCE_MS = 2000

/** Read a record payload as an object (the store may hand back JSON text). */
function payloadObject(record) {
  if (record === undefined || record === null) return undefined
  const payload = record.payload
  if (typeof payload === 'string') {
    try {
      const parsed = JSON.parse(payload)
      return typeof parsed === 'object' && parsed !== null ? parsed : undefined
    } catch {
      return undefined
    }
  }
  return typeof payload === 'object' && payload !== null ? payload : undefined
}

/** Credits are shown with two decimals; keep the stored value on that grid. */
function round2(value) {
  return Math.round(value * 100) / 100
}

/** Bucket key for one session id, never throwing on an unexpected shape. */
function keyOf(sessionId) {
  if (sessionId === undefined || sessionId === null) return FALLBACK_KEY
  const raw = String(sessionId)
  return SESSION_KEY_PATTERN.test(raw) ? raw : FALLBACK_KEY
}

export class SessionCredits {
  /** @type {Map<string, {credits: number, accountId?: string, model?: string, updatedAt: number}>} */
  #entries = new Map()
  /** Most recently active bucket, for a reader that has no session id. */
  #latest
  /** Durable-copy reader, record key, logger and retention knobs. */
  #credentials
  #key
  #logger
  #now
  #max
  #keepMs
  #loaded = false
  #loading
  #saving
  #saveTimer

  /**
   * @param {object} input
   * @param {() => object | undefined} [input.credentials] live credential store reader.
   * @param {string} input.key credential-record key holding the durable copy.
   * @param {{warn?: (message: string) => void}} [input.logger] cordis logger.
   * @param {() => number} [input.now] clock, for tests.
   * @param {number} [input.max] session cap, for tests.
   * @param {number} [input.keepMs] retention window, for tests.
   */
  constructor({ credentials, key, logger, now = Date.now, max = MAX_SESSIONS, keepMs = KEEP_MS } = {}) {
    if (typeof key !== 'string' || key.length === 0) throw new TypeError('SessionCredits needs a record key')
    this.#credentials = credentials
    this.#key = key
    this.#logger = logger
    this.#now = now
    this.#max = max
    this.#keepMs = keepMs
  }

  /** Resolves once the durable copy has been read; never rejects. */
  get ready() {
    return this.#load()
  }

  /**
   * Accumulate one request's spend into its session bucket and schedule the
   * durable copy. Resolves immediately: the write happens in a coalesced window
   * and `flush()` waits for it. Failures are logged, never thrown — a bookkeeping
   * miss must not fail a completion that already streamed.
   *
   * @param {string | undefined} sessionId harness session id.
   * @param {{credit: number, accountId?: string, model?: string}} spend
   */
  async add(sessionId, { credit, accountId, model }) {
    await this.#load()
    const key = keyOf(sessionId)
    const entry = this.#entries.get(key) ?? { credits: 0, accountId: undefined, model: undefined, updatedAt: 0 }
    const gained = Number.isFinite(credit) && credit > 0
    if (gained) entry.credits += credit
    entry.accountId = accountId ?? entry.accountId
    entry.model = model ?? entry.model
    entry.updatedAt = this.#now()
    this.#entries.set(key, entry)
    this.#latest = key
    this.#prune()
    // A turn that spent nothing adds no information worth a disk write.
    if (gained) this.#scheduleSave()
  }

  /**
   * Coalesce durable writes.
   *
   * Every spent turn used to rewrite the whole (up to 200-session) record and
   * wait for that write to land, so the caller's latency tracked the store and N
   * turns produced N whole-record writes. One write per window is enough: the
   * pill re-reads the in-memory number, not the record.
   */
  #scheduleSave() {
    if (this.#saveTimer !== undefined) return
    this.#saveTimer = setTimeout(() => {
      this.#saveTimer = undefined
      void this.#queueSave()
    }, SAVE_DEBOUNCE_MS)
    // Deliberately NOT unref'ed: the pending write must land even when the
    // process is on its way out, and it costs at most one debounce window.
  }

  /** Write any pending spend now and wait for it (plugin teardown). */
  async flush() {
    if (this.#saveTimer !== undefined) {
      clearTimeout(this.#saveTimer)
      this.#saveTimer = undefined
      void this.#queueSave()
    }
    await this.#saving
  }

  /**
   * One session's accumulated spend, restoring the durable copy first so a cold
   * process answers with the numbers the previous process recorded.
   *
   * @param {string | undefined} sessionId harness session id; omitted means "the
   *   most recently active session".
   * @returns {Promise<{sessionId: string, credits: number, accountId?: string, model?: string, updatedAt?: string} | undefined>}
   */
  async usage(sessionId) {
    await this.#load()
    const key = sessionId === undefined || sessionId === null || sessionId === '' ? this.#latest : keyOf(sessionId)
    if (key === undefined) return undefined
    const entry = this.#entries.get(key)
    if (entry === undefined) return { sessionId: key, credits: 0 }
    return {
      sessionId: key,
      credits: round2(entry.credits),
      ...(entry.accountId === undefined ? {} : { accountId: entry.accountId }),
      ...(entry.model === undefined ? {} : { model: entry.model }),
      ...(entry.updatedAt > 0 ? { updatedAt: new Date(entry.updatedAt).toISOString() } : {}),
    }
  }

  /** Drop everything that is outside the retention window or above the cap. */
  #prune() {
    const cutoff = this.#now() - this.#keepMs
    for (const [key, entry] of this.#entries) {
      if (entry.updatedAt < cutoff) this.#entries.delete(key)
    }
    if (this.#entries.size <= this.#max) return
    const ordered = [...this.#entries.entries()].sort((left, right) => left[1].updatedAt - right[1].updatedAt)
    for (const [key] of ordered.slice(0, this.#entries.size - this.#max)) this.#entries.delete(key)
  }

  /** Serialize the durable copy behind any in-flight write. */
  #queueSave() {
    const run = async () => {
      const credentials = this.#credentials?.()
      if (credentials === undefined) return
      this.#prune()
      const sessions = {}
      for (const [key, entry] of this.#entries) {
        sessions[key] = {
          // Store the exact sum: rounding here would let a few thousand turns
          // drift away from the number the process actually accumulated.
          credits: entry.credits,
          updatedAt: entry.updatedAt,
          ...(entry.accountId === undefined ? {} : { accountId: entry.accountId }),
          ...(entry.model === undefined ? {} : { model: entry.model }),
        }
      }
      const payload = {
        version: 1,
        updatedAt: this.#now(),
        ...(this.#latest === undefined ? {} : { latestSessionId: this.#latest }),
        sessions,
      }
      // Merge under the provider's lock: another process (or a second DSH
      // profile) may have recorded its own sessions since this one loaded, and a
      // whole-record replace erased them.
      await credentials.modifyRecord(this.#key, async (current) => {
        const existing = payloadObject(current)?.sessions
        const merged = typeof existing === 'object' && existing !== null ? { ...existing, ...sessions } : sessions
        return { kind: 'grant', payload: { ...payload, sessions: merged } }
      })
    }
    this.#saving = (this.#saving ?? Promise.resolve())
      .then(run, run)
      .catch((error) => this.#logger?.warn?.(`llm-workbuddy: could not persist the session spend: ${error.message}`))
    return this.#saving
  }

  /** Read the durable copy once per process; a bad record reads as "nothing stored". */
  #load() {
    if (this.#loaded) return Promise.resolve()
    if (this.#loading !== undefined) return this.#loading
    this.#loading = (async () => {
      const credentials = this.#credentials?.()
      if (credentials === undefined) {
        this.#loaded = true
        return
      }
      let stored
      try {
        const records = await credentials.listRecords()
        const hit = records.find((record) => String(record.key) === this.#key)
        if (hit !== undefined) stored = payloadObject(await credentials.readRecord(hit.key))
      } catch (error) {
        this.#logger?.warn?.(`llm-workbuddy: could not read the session spend: ${error.message}`)
      }
      this.#restore(stored)
      this.#loaded = true
    })()
    return this.#loading
  }

  /** Merge one stored payload into the in-memory map. */
  #restore(stored) {
    const sessions = typeof stored?.sessions === 'object' && stored.sessions !== null ? stored.sessions : {}
    const cutoff = this.#now() - this.#keepMs
    for (const [key, entry] of Object.entries(sessions)) {
      if (SESSION_KEY_PATTERN.test(key) !== true) continue
      if (typeof entry !== 'object' || entry === null) continue
      const credits = Number.isFinite(entry.credits) && entry.credits > 0 ? entry.credits : 0
      const updatedAt = Number.isFinite(entry.updatedAt) ? entry.updatedAt : 0
      if (updatedAt < cutoff) continue
      this.#entries.set(key, {
        credits,
        updatedAt,
        ...(typeof entry.accountId === 'string' && entry.accountId.length > 0 ? { accountId: entry.accountId } : {}),
        ...(typeof entry.model === 'string' && entry.model.length > 0 ? { model: entry.model } : {}),
      })
    }
    this.#prune()
    const storedLatest = typeof stored?.latestSessionId === 'string' ? stored.latestSessionId : undefined
    this.#latest =
      storedLatest !== undefined && this.#entries.has(storedLatest)
        ? storedLatest
        : [...this.#entries.entries()].sort((left, right) => right[1].updatedAt - left[1].updatedAt)[0]?.[0]
  }
}

