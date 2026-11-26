/**
 * Automatic daily check-in scheduler for the WorkBuddy provider.
 *
 * WorkBuddy credits include a once-per-day check-in (`POST
 * /v2/billing/meter/daily-checkin`, UTC+8 natural day). The plugin performs it
 * for every signed-in account:
 *
 * - on startup, once the local clock is past `autoCheckinHour` (default 08:00),
 *   after a short delay so session startup wins the race;
 * - afterwards every `checkinRetryMinutes` (default 30) until every account is
 *   either signed in, unsupported (enterprise / global realm), or has used its
 *   `checkinMaxAttempts` for the day.
 *
 * The timers are `unref()`ed: a headless run finishes on its own even though the
 * scheduler is still armed. The whole feature is a nicety — every failure is
 * logged and retried, never surfaced as a chat error.
 *
 * @module dsh-workbuddy-switch/checkin
 */

import { REALM_UTC_OFFSET_MS } from './config.js'

/** Milliseconds in one minute. */
const MINUTE_MS = 60 * 1000

/**
 * Wall clock in the upstream's zone (UTC+8): minute of day and day key.
 *
 * The upstream's day boundary is the UTC+8 natural day, so the schedule is
 * computed on that clock rather than on the machine's local one: a user in
 * another time zone would otherwise sweep at their own 08:00, which can be the
 * previous or the next UTC+8 day and either repeat or skip a check-in.
 */
function realmClock(at = Date.now()) {
  const shifted = new Date(at + REALM_UTC_OFFSET_MS)
  return {
    minuteOfDay: shifted.getUTCHours() * 60 + shifted.getUTCMinutes(),
    dayKey: shifted.toISOString().slice(0, 10),
  }
}

/** Hard ceiling on automatic sweeps per UTC+8 day, whatever the retry cadence. */
const MAX_SWEEPS_PER_DAY = 12

/**
 * Arm the automatic check-in timers.
 * @param {object} deps
 * @param {object} deps.pool the account pool.
 * @param {() => object} deps.options resolved plugin options reader.
 * @param {object} deps.logger cordis logger.
 * @returns `{dispose}`; `dispose` clears the timers.
 */
export function startCheckinScheduler({ pool, options, logger }) {
  let firstTimer
  let retryTimer
  let disposed = false
  let running = false
  const sweeps = { dayKey: '', count: 0 }

  const log = (level, message) => {
    try {
      logger?.[level]?.(`llm-workbuddy: ${message}`)
    } catch {
      // Logging must never take the scheduler down.
    }
  }

  /** Minute of the UTC+8 day the first sweep is allowed to start. */
  const startMinuteOfDay = (config) => Math.max(0, Math.min(23, Math.floor(config.autoCheckinHour))) * 60

  /** Delay until the first sweep: the configured hour, then the startup delay. */
  const firstDelayMs = (config) => {
    const minutesUntil = Math.max(0, startMinuteOfDay(config) - realmClock().minuteOfDay)
    return minutesUntil * MINUTE_MS + config.checkinStartupDelayMs
  }

  /** One sweep, if it is due. */
  const tick = async () => {
    if (disposed || running) return
    let config
    try {
      config = options()
    } catch (error) {
      log('warn', `auto check-in is paused until the configuration is valid: ${error?.message ?? String(error)}`)
      return
    }
    if (!config.autoCheckin) return
    const clock = realmClock()
    if (clock.minuteOfDay < startMinuteOfDay(config)) return
    // Bound the retries by the calendar day as well as by attempt count: an
    // account stuck in a non-terminal state would otherwise be retried every
    // interval until midnight.
    if (sweeps.dayKey !== clock.dayKey) {
      sweeps.dayKey = clock.dayKey
      sweeps.count = 0
    }
    if (sweeps.count >= MAX_SWEEPS_PER_DAY) return
    try {
      if (!(await pool.checkinPending({ maxAttempts: config.checkinMaxAttempts }))) return
    } catch (error) {
      log('warn', `auto check-in skipped: ${error?.message ?? String(error)}`)
      return
    }
    if (disposed) return
    sweeps.count += 1
    running = true
    try {
      const result = await pool.checkinAll({})
      const summary = result.summary
      const suffix = summary.unsupported > 0 ? `, ${summary.unsupported} unsupported` : ''
      if (summary.failed === 0 && summary.pending === 0) {
        log('info', `auto check-in finished: ${summary.signed}/${summary.total} signed in${suffix}`)
      } else {
        log(
          'warn',
          `auto check-in: ${summary.signed}/${summary.total} signed in${suffix}, ${summary.failed} failed, ${summary.pending} pending; retrying in ${config.checkinRetryMinutes} min`,
        )
      }
    } catch (error) {
      log('warn', `auto check-in sweep failed: ${error?.message ?? String(error)}`)
    } finally {
      running = false
    }
  }

  const arm = () => {
    if (disposed) return
    let config
    try {
      config = options()
    } catch {
      return
    }
    firstTimer = setTimeout(() => {
      firstTimer = undefined
      void tick()
    }, firstDelayMs(config))
    firstTimer.unref?.()
    retryTimer = setInterval(() => {
      void tick()
    }, Math.max(1, config.checkinRetryMinutes) * MINUTE_MS)
    retryTimer.unref?.()
    log(
      'debug',
      `auto check-in armed (UTC+8 hour >= ${config.autoCheckinHour}, retry every ${config.checkinRetryMinutes} min, up to ${config.checkinMaxAttempts} attempts per account per day)`,
    )
  }

  arm()

  return {
    dispose() {
      disposed = true
      if (firstTimer !== undefined) clearTimeout(firstTimer)
      if (retryTimer !== undefined) clearInterval(retryTimer)
      firstTimer = undefined
      retryTimer = undefined
    },
  }
}
