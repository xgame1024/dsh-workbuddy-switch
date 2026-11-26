/**
 * WorkBuddy credit pricing: list prices and time-boxed promotions.
 *
 * `/v3/config` publishes one `credits` multiplier per model (`"x0.11"`) plus a
 * `modelPromotions` list. A promotion may carry an explicit
 * `discount.factor` (0 = free, 0.5 = half price) and/or only a badge whose copy
 * states the rule ("周一至周五 09:00–12:00、14:00–18:00 属高峰原价，非高峰期积分5折").
 *
 * The discount itself is applied upstream, per model and wall clock — nothing a
 * client sends changes it. This module only derives what to *display* so the
 * model picker can show a list price and the promotions that are active now.
 *
 * Deliberately imports nothing from the harness: pure functions, callable from a
 * plain `node -e` snippet.
 *
 * @module dsh-workbuddy-switch/pricing
 */

/** WorkBuddy publishes every schedule in this zone. */
const DEFAULT_TIME_ZONE = 'Asia/Shanghai'

/** `Intl` weekday labels mapped onto ISO weekdays (1 = Monday … 7 = Sunday). */
const ISO_WEEKDAY = Object.freeze({ Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6, Sun: 7 })

/** Minutes in one hour (schedule bounds are `HH:MM`). */
const MINUTES_PER_HOUR = 60

/** Trim float noise without turning 0.055 into 0.05500000000000001. */
function trimNumber(value) {
  return String(Number(value.toFixed(4)))
}

/**
 * Parse one credit multiplier.
 *
 * Accepts the wire spellings `"x0.11"`, `"0.50x"`, `"0.11"`, numeric input, and
 * the free-campaign spellings `"0x"` / `"免费"`.
 *
 * @param {unknown} value raw `credits` field or numeric multiplier.
 * @returns {number | undefined} multiplier, `0` for a free campaign, or undefined.
 */
export function parseCreditMultiplier(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : undefined
  if (typeof value !== 'string') return undefined
  const text = value.trim()
  if (text.length === 0) return undefined
  if (/(?:免费|free)/iu.test(text)) return 0
  const match = /\d+(?:\.\d+)?/u.exec(text)
  if (match === null) return undefined
  const parsed = Number(match[0])
  return Number.isFinite(parsed) ? parsed : undefined
}

/** `HH:MM` (or `H:MM`) to minutes since local midnight. */
function minuteOfDay(value) {
  if (typeof value !== 'string') return undefined
  const match = /^(\d{1,2}):(\d{2})$/u.exec(value.trim())
  if (match === null) return undefined
  const hour = Number(match[1])
  const minute = Number(match[2])
  if (hour > 24 || minute > 59) return undefined
  return hour * MINUTES_PER_HOUR + minute
}

/**
 * Wall-clock minute-of-day and ISO weekday of `instant` in one time zone.
 *
 * Uses `Intl` when the runtime carries the zone data (Node 22 always does for
 * IANA zones) and falls back to a fixed UTC+8 clock otherwise: every WorkBuddy
 * schedule is published in Asia/Shanghai, so the fallback stays correct for the
 * only zone the upstream uses.
 */
function localClock(instant, timeZone) {
  try {
    const formatter = new Intl.DateTimeFormat('en-US', {
      timeZone: timeZone ?? DEFAULT_TIME_ZONE,
      hourCycle: 'h23',
      weekday: 'short',
      hour: '2-digit',
      minute: '2-digit',
    })
    const parts = formatter.formatToParts(new Date(instant))
    const read = (type) => parts.find((part) => part.type === type)?.value
    const minute = Number(read('hour')) * MINUTES_PER_HOUR + Number(read('minute'))
    const weekday = ISO_WEEKDAY[read('weekday')]
    if (Number.isFinite(minute) && weekday !== undefined) return { minute, weekday }
  } catch {
    // Unknown time zone: fall through to the fixed offset.
  }
  const shifted = new Date(instant + 8 * 60 * MINUTES_PER_HOUR * 1000)
  return { minute: shifted.getUTCHours() * MINUTES_PER_HOUR + shifted.getUTCMinutes(), weekday: ((shifted.getUTCDay() + 6) % 7) + 1 }
}

/** Whether one `daily[]` window covers `minute` (windows may cross midnight). */
function dailyWindowCovers(window, minute) {
  const start = minuteOfDay(window?.start)
  const end = minuteOfDay(window?.end)
  if (start === undefined || end === undefined) return false
  if (start === end) return true
  // Half-open at the end: a window ending 18:00 must not keep discounting
  // through 18:00:59 just because the clock is compared at minute resolution.
  if (start < end) return minute >= start && minute < end
  // 23:00—7:50 crosses midnight.
  return minute >= start || minute < end
}

/**
 * Whether one promotion `schedule` covers `now`.
 *
 * Missing/blank fields mean "always": an absent `validFrom`/`validUntil` has no
 * window, and an absent `daily[]` has no clock restriction.
 *
 * @param {object | undefined} schedule upstream `schedule` object.
 * @param {number} [now] epoch milliseconds, defaults to the current time.
 * @returns {boolean} true when the promotion applies at `now`.
 */
export function scheduleCovers(schedule, now = Date.now()) {
  if (typeof schedule !== 'object' || schedule === null) return true
  // Presence is decided on the trimmed text, the parse itself on the raw string:
  // V8 does not trim, and a field that is present but unparseable is not "no
  // limit" — treating it as unbounded kept an expired promotion marked active
  // and showed a price the upstream would not charge.
  const fromText = typeof schedule.validFrom === 'string' ? schedule.validFrom : ''
  const untilText = typeof schedule.validUntil === 'string' ? schedule.validUntil : ''
  const hasFrom = fromText.trim().length > 0
  const hasUntil = untilText.trim().length > 0
  const validFrom = hasFrom ? Date.parse(fromText) : Number.NaN
  const validUntil = hasUntil ? Date.parse(untilText) : Number.NaN
  if (hasFrom && !Number.isFinite(validFrom)) return false
  if (hasUntil && !Number.isFinite(validUntil)) return false
  if (hasFrom && now < validFrom) return false
  if (hasUntil && now >= validUntil) return false
  const clock = localClock(now, typeof schedule.timezone === 'string' ? schedule.timezone : undefined)
  const weekdays = Array.isArray(schedule.weekdays) ? schedule.weekdays.map(Number).filter(Number.isFinite) : []
  if (weekdays.length > 0 && !weekdays.includes(clock.weekday)) return false
  const daily = Array.isArray(schedule.daily) ? schedule.daily : []
  if (daily.length === 0) return true
  return daily.some((window) => dailyWindowCovers(window, clock.minute))
}

/**
 * Discount factor stated in promotion copy ("积分5折" -> 0.5, "7.5折" -> 0.75).
 * Only used when the payload carries no explicit `discount.factor`.
 */
export function discountFactorOfText(text) {
  if (typeof text !== 'string') return undefined
  // `0 折` only as a whole number: without the leading boundary it also matched
  // the "10折" of a full-price promotion and reported the model as free.
  if (/(?:免费|限免|(?<![\d.])0\s*折)/u.test(text)) return 0
  const match = /(\d+(?:\.\d+)?)\s*折/u.exec(text)
  if (match === null) return undefined
  const factor = Number(match[1]) / 10
  return Number.isFinite(factor) && factor > 0 && factor <= 1 ? Number(factor.toFixed(4)) : undefined
}

/** `2026-11-16T00:00:00+08:00` -> `11/16` (falls back to the raw date prefix). */
function shortDate(value) {
  if (typeof value !== 'string' || value.length === 0) return undefined
  const parsed = Date.parse(value)
  if (!Number.isFinite(parsed)) return undefined
  try {
    const formatter = new Intl.DateTimeFormat('en-US', { timeZone: DEFAULT_TIME_ZONE, month: 'numeric', day: 'numeric' })
    return formatter.format(new Date(parsed))
  } catch {
    const match = /^\d{4}-(\d{2})-(\d{2})/u.exec(value)
    return match === null ? undefined : `${Number(match[1])}/${Number(match[2])}`
  }
}

/**
 * Normalize one raw `/v3/config` promotion.
 *
 * `explicitFactor` records whether the payload itself carried
 * `discount.factor`; a factor inferred from the copy is informational only,
 * because such campaigns ("非高峰期积分5折") restrict the discount to a window
 * that the structured schedule does not describe.
 *
 * @param {unknown} raw one `modelPromotions[]` entry.
 * @param {number} [now] epoch milliseconds used to evaluate `active`.
 * @returns {object | undefined} normalized promotion, or undefined when unusable.
 */
export function normalizePromotion(raw, now = Date.now()) {
  if (typeof raw !== 'object' || raw === null) return undefined
  const modelIds = Array.isArray(raw.modelIds) ? raw.modelIds.map(String).filter((id) => id.length > 0) : []
  const label = typeof raw.badge?.label === 'string' && raw.badge.label.trim().length > 0 ? raw.badge.label.trim() : undefined
  const text = typeof raw.hover?.textZh === 'string' && raw.hover.textZh.length > 0 ? raw.hover.textZh : undefined
  const explicitFactor = Number.isFinite(raw.discount?.factor) ? Number(raw.discount.factor) : undefined
  if (label === undefined && explicitFactor === undefined) return undefined
  return {
    id: typeof raw.id === 'string' && raw.id.length > 0 ? raw.id : label ?? 'promotion',
    modelIds,
    label,
    text,
    factor: explicitFactor ?? discountFactorOfText(text),
    explicitFactor: explicitFactor !== undefined,
    priority: Number.isFinite(raw.priority) ? Number(raw.priority) : 0,
    active: raw.enabled !== false && scheduleCovers(raw.schedule, now),
    validUntil: typeof raw.schedule?.validUntil === 'string' && raw.schedule.validUntil.length > 0 ? raw.schedule.validUntil : undefined,
  }
}

/**
 * Highest-priority enabled promotion covering one model at `now`.
 *
 * @param {string} modelId wire model id.
 * @param {Array<object>} promotions already-normalized promotions.
 * @returns {object | undefined} the winning promotion.
 */
export function activePromotionFor(modelId, promotions) {
  let best
  for (const promotion of Array.isArray(promotions) ? promotions : []) {
    if (promotion?.active !== true) continue
    if (!promotion.modelIds.includes(modelId)) continue
    if (best === undefined || promotion.priority > best.priority) best = promotion
  }
  return best
}

/**
 * Derive the display facts for one model.
 *
 * `effectiveCredits` is only computed when the payload states the factor — a
 * copy-only factor ("非高峰5折") is surfaced as text instead of a number,
 * because the structured schedule does not say when it applies.
 *
 * @param {{credits?: number, promotion?: object}} input list price + active promotion.
 * @returns {{credits?: number, effectiveCredits?: number, priceLabel?: string, discountLabel?: string}}
 */
export function buildPriceInfo({ credits, promotion } = {}) {
  if (!Number.isFinite(credits)) return { priceLabel: undefined }
  const free = credits === 0
  const base = free ? '免费' : `x${trimNumber(credits)}`
  if (promotion === undefined) return { credits, priceLabel: base }
  const factor = Number.isFinite(promotion.factor) ? promotion.factor : undefined
  const discountLabel = factor !== undefined && factor < 1 ? `${trimNumber(factor * 10)}折` : undefined
  // A copy-only campaign carries the upstream badge label ("夜间折扣") but its
  // actually published rule may be a peak/off-peak one ("非高峰期积分5折"). When
  // the copy names that window, say so instead of repeating the badge. Bare
  // "错峰" wording is too generic (the night badge uses it too), so it is not
  // matched on its own.
  const offPeakCopy =
    promotion.explicitFactor !== true &&
    discountLabel !== undefined &&
    typeof promotion.text === 'string' &&
    /(?:非高峰|谷时)/u.test(promotion.text)
  const promoName = offPeakCopy ? `非高峰${discountLabel}` : promotion.label ?? discountLabel
  const promoNote = promoName === undefined ? '' : ` ${promoName}`
  if (free) {
    const until = shortDate(promotion.validUntil)
    const suffix = until === undefined ? '' : `至${until}`
    return { credits, priceLabel: `免费${promoName === undefined ? '' : `(${promoName})`}${suffix}`.replace('(限时免费)', ''), discountLabel }
  }
  if (promotion.explicitFactor === true && discountLabel !== undefined) {
    const effectiveCredits = Number((credits * factor).toFixed(4))
    return {
      credits,
      effectiveCredits,
      discountLabel,
      priceLabel: `${base}→x${trimNumber(effectiveCredits)}${promoNote}`,
    }
  }
  // A copy-only campaign shows its badge label only: the exact factor and the
  // rule text are surfaced by `workbuddy_account action="models"`, and a
  // parenthetical here would imply the discount applies at this very moment.
  return { credits, discountLabel, priceLabel: `${base}${promoNote}` }
}

/**
 * Badge for the host model picker (`LlmModelInfo.badge`), which renders it next
 * to the model name and colours it by `tone`.
 *
 * @param {{priceLabel?: string, credits?: number, promotion?: object}} entry catalog entry.
 * @returns {{text: string, tone: 'success' | 'info' | 'neutral'} | undefined} badge or undefined.
 */
export function modelBadgeOf(entry) {
  if (typeof entry?.priceLabel !== 'string' || entry.priceLabel.length === 0) return undefined
  const tone = entry.credits === 0 ? 'success' : entry.promotion === undefined ? 'neutral' : 'info'
  return { text: entry.priceLabel, tone }
}

/**
 * Compact promotion view for tool output and the catalog (drops internals).
 * @param {object | undefined} promotion normalized promotion.
 */
export function promoteForDisplay(promotion) {
  if (promotion === undefined) return undefined
  return {
    id: promotion.id,
    ...(promotion.label === undefined ? {} : { label: promotion.label }),
    ...(promotion.factor === undefined ? {} : { factor: promotion.factor }),
    ...(promotion.text === undefined ? {} : { text: promotion.text }),
    active: promotion.active,
    ...(promotion.validUntil === undefined ? {} : { validUntil: promotion.validUntil }),
  }
}
