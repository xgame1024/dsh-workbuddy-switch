/**
 * Model-facing account tools for the WorkBuddy provider.
 *
 * `workbuddy_login` owns browser (device-authorization) and token sign-in;
 * `workbuddy_account` owns account inspection and removal. Tokens are stored in
 * the host credential store and are never echoed back to the model, except when
 * a human explicitly pastes one into the `accessToken` argument — prefer
 * `tokenFile` so the secret stays out of the session log.
 *
 * @module dsh-workbuddy-switch/tools
 */

import { readFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { resolve as resolvePath, sep } from 'node:path'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { PROVIDER, REALM_UTC_OFFSET_MS } from './config.js'
import { fetchLiveModels, fetchProfile } from './upstream.js'

/**
 * Token shape accepted from a token file: one opaque run of token characters.
 *
 * This is the guard that makes `tokenFile` safe to hand to a model. Without it
 * any readable file (`~/.ssh/id_rsa`, a `.env`) would be sent upstream as a
 * bearer token; a real token is a single line, has no whitespace, and is at
 * least 20 characters. The lower bound also rejects the accidental case of a
 * file holding a path or a word.
 */
const TOKEN_SHAPE = /^[A-Za-z0-9._~+/=*-]{20,8192}$/u

/** Directories a raw (non-JSON) token file may live in. */
function rawTokenRoots() {
  const roots = [resolvePath(process.env.DSH_HOME ?? resolvePath(homedir(), '.dsh')), resolvePath(homedir(), '.codebuddy'), resolvePath(homedir(), '.workbuddy'), resolvePath(tmpdir()), resolvePath(process.cwd())]
  for (const name of ['APPDATA', 'LOCALAPPDATA']) {
    const value = process.env[name]
    if (typeof value === 'string' && value.length > 0) roots.push(resolvePath(value))
  }
  return roots
}

/** Whether `filePath` sits inside one of the allowed raw-token roots. */
function underRawTokenRoot(filePath) {
  const resolved = resolvePath(filePath)
  // Windows paths are case-insensitive: a path spelled with a lower-case drive
  // letter is the same file as the `homedir()` spelling.
  const normalize = (value) => (process.platform === 'win32' ? value.toLowerCase() : value)
  const target = normalize(resolved)
  return rawTokenRoots().some((root) => {
    const base = normalize(root)
    return target === base || target.startsWith(base + sep)
  })
}

/** Throw unless `token` has the shape of a real access token. */
function assertTokenShape(token, filePath) {
  if (typeof token !== 'string' || !TOKEN_SHAPE.test(token.trim())) {
    throw new Error(
      `token file ${filePath} does not hold an access token (expected a single opaque token of at least 20 characters, or a JSON document with an accessToken field)`,
    )
  }
  return token.trim()
}

/**
 * Forced manual check-ins allowed per account per day.
 *
 * `force` bypasses the per-day cache, so without a budget a model could hammer
 * the upstream check-in endpoint until the account trips risk control. The cap
 * is in-process and deliberately generous: a human retrying a failed check-in
 * never reaches it, a loop does.
 */
const FORCED_CHECKIN_LIMIT = 5
const forcedCheckins = new Map()

/** Throw once an account has spent its forced check-ins for the day. */
function assertForcedCheckinBudget(accountId, force) {
  if (force !== true) return
  // Same UTC+8 day boundary the check-in cache uses, so the budget resets with
  // the upstream day rather than at UTC midnight.
  const day = new Date(Date.now() + REALM_UTC_OFFSET_MS).toISOString().slice(0, 10)
  const key = `${day}|${accountId ?? '*'}`
  const used = forcedCheckins.get(key) ?? 0
  if (used >= FORCED_CHECKIN_LIMIT) {
    throw new Error(
      `workbuddy_account action="checkin" force=true has been used ${used} times today for ${accountId ?? 'all accounts'}; the cached result is authoritative until tomorrow`,
    )
  }
  forcedCheckins.set(key, used + 1)
}

/** A one-line account summary safe to log and return. */
function summarize(account) {
  if (account === undefined) return undefined
  const expiresAt = Number.isFinite(account.expiresAt) && account.expiresAt > 0 ? new Date(account.expiresAt).toISOString() : undefined
  return {
    id: account.id,
    ...(account.uid === undefined ? {} : { uid: account.uid }),
    ...(account.nickname === undefined ? {} : { nickname: account.nickname }),
    realm: account.realm,
    ...(expiresAt === undefined ? {} : { expiresAt }),
  }
}

/** Render one account summary as text. */
function describeAccount(account) {
  const parts = [`account ${account.id}`]
  if (account.uid !== undefined) parts.push(`uid ${account.uid}`)
  if (account.nickname !== undefined) parts.push(`nickname ${account.nickname}`)
  parts.push(`realm ${account.realm}`)
  if (account.expiresAt !== undefined) parts.push(`expires ${account.expiresAt}`)
  return parts.join(', ')
}

/** Format one credit count without trailing zeros. */
function formatCredits(value) {
  if (!Number.isFinite(value)) return '?'
  const rounded = Math.round(value * 100) / 100
  if (Number.isInteger(rounded)) return String(rounded)
  return rounded.toFixed(2).replace(/0+$/u, '').replace(/\.$/u, '')
}

/** One-line credits summary for one account row. */
function describeQuota(quota) {
  if (quota === undefined) return undefined
  if (quota.supported === false) return 'unknown (the billing meter reported no credit package)'
  const reset = quota.resetAt === undefined ? '' : `, resets ${quota.resetAt}`
  if (quota.unlimited === true) return `unlimited, used ${formatCredits(quota.used)} credits${reset}`
  const parts = [`${formatCredits(quota.remaining)}/${formatCredits(quota.total)} credits left`]
  if (quota.used !== undefined) parts.push(`used ${formatCredits(quota.used)}`)
  return `${parts.join(', ')}${reset}`
}

/** One-line check-in status for one account row. */
function describeCheckin(view) {
  if (view === undefined) return undefined
  if (view.status === 'ok') {
    const parts = ['signed in today']
    if (Number.isFinite(view.credit)) parts.push(`+${formatCredits(view.credit)} credits`)
    if (Number.isFinite(view.streakDays)) parts.push(`streak ${view.streakDays} days`)
    return parts.join(', ')
  }
  switch (view.status) {
    case 'already':
      return 'already signed in today'
    case 'unsupported':
      return view.reason === undefined ? 'not applicable for this account' : `not applicable — ${view.reason}`
    case 'failed':
      return `failed — ${view.error ?? 'unknown error'}`
    case 'pending':
      return 'not signed in yet'
    default:
      return view.status
  }
}

/** The list heading for one rendered account view. */
function headingFor(value) {
  if (value.action === 'quota') return 'WorkBuddy account credits:'
  const pinned = value.pinnedAccount
  if (pinned === undefined || pinned.length === 0) return 'WorkBuddy accounts (pool selection):'
  return `WorkBuddy accounts (pinned: ${pinned}):`
}

/** The trailing sentence explaining what the pinned account means now. */
function hintFor(value) {
  if (value.action === 'use') {
    return `\nConversations started from now on use ${value.pinnedAccount}; ones already under way keep their account. action="auto" returns to the pool.`
  }
  if (value.action === 'auto') {
    return '\nConversations started from now on return to the account pool; ones already under way keep their account.'
  }
  return ''
}

/** Model-facing text for one `workbuddy_account` result. */
function renderAccountOutput(_args, value) {
  if (Array.isArray(value.models)) {
    const lines = value.models.map((model) => {
      const parts = [model.id]
      if (model.name !== undefined && model.name !== model.id) parts.push(`(${model.name})`)
      if (model.priceLabel !== undefined) parts.push(`— ${model.priceLabel}`)
      if (model.contextWindow !== undefined) parts.push(`ctx ${model.contextWindow}`)
      if (model.maxTokens !== undefined) parts.push(`out ${model.maxTokens}`)
      return `- ${parts.join(' ')}`
    })
    return [
      {
        type: 'text',
        text:
          lines.length === 0
            ? 'WorkBuddy reported no models.'
            : `WorkBuddy live models (price = credit multiplier per model; promotions are applied upstream by model and wall clock):\n${lines.join('\n')}`,
      },
    ]
  }
  if (value.removed === true) return [{ type: 'text', text: 'WorkBuddy account removed.' }]
  const accounts = Array.isArray(value.accounts) ? value.accounts : []
  const checkins = Array.isArray(value.checkins) ? value.checkins : []
  if (value.action === 'checkin') {
    if (checkins.length === 0) return [{ type: 'text', text: 'No WorkBuddy accounts are signed in.' }]
    const signed = checkins.filter((view) => view.status === 'ok' || view.status === 'already').length
    const lines = checkins.map((view) => {
      const at = typeof view.at === 'string' ? ` (${view.at})` : ''
      return `- ${view.accountId}: ${describeCheckin(view)}${at}`
    })
    return [
      {
        type: 'text',
        text: `WorkBuddy daily check-in — ${signed}/${checkins.length} signed in:\n${lines.join('\n')}\nThe check-in is idempotent: an account that was already signed in today reports "already signed in". Enterprise accounts and global-realm (workbuddy.ai) accounts have no check-in system and are skipped.`,
      },
    ]
  }
  if (accounts.length === 0) return [{ type: 'text', text: 'No WorkBuddy accounts are signed in.' }]
  const checkinById = new Map(checkins.map((view) => [view.accountId, view]))
  const lines = accounts.map((account) => {
    const marker = account.pinned === true ? ' [pinned]' : ''
    const cooling = account.coolingUntil === undefined ? '' : ` (cooling until ${account.coolingUntil})`
    const credits = account.quotaError === undefined ? describeQuota(account.quota) : `unavailable — ${account.quotaError}`
    const quotaLine = credits === undefined ? '' : `\n  credits: ${credits}`
    const checkin = describeCheckin(checkinById.get(account.id))
    const checkinLine = checkin === undefined ? '' : `\n  check-in: ${checkin}`
    return `- ${describeAccount(account)}${marker}${cooling}${quotaLine}${checkinLine}`
  })
  const heading = headingFor(value)
  const hint = hintFor(value)
  const limits = Array.isArray(value.modelLimits) ? value.modelLimits : []
  const limitLine =
    limits.length === 0
      ? ''
      : `\nModel limits in effect: ${limits.map((entry) => `${entry.model} until ${entry.until}`).join(', ')} (code 6004/6021 — switch model or wait; changing accounts does not clear it).`
  return [{ type: 'text', text: `${heading}\n${lines.join('\n')}${hint}${limitLine}` }]
}

/** Card title shown in the conversation while one account call runs. */
function presentAccountCall(args) {
  const target = typeof args.accountId === 'string' && args.accountId.length > 0 ? ` · ${args.accountId}` : ''
  const titles = {
    list: 'WorkBuddy 账号与积分',
    quota: `WorkBuddy 积分查询${target}`,
    use: `切换 WorkBuddy 账号${target}`,
    auto: '切回账号池轮询',
    remove: `删除 WorkBuddy 账号${target}`,
    refresh: `刷新 WorkBuddy 令牌${target || '（全部账号）'}`,
    models: 'WorkBuddy 模型目录',
    checkin: `WorkBuddy 今日签到${target}`,
  }
  return { card: 'generic', title: titles[args.action] ?? `WorkBuddy 账号（${args.action}）`, kind: 'other' }
}

/** Card title + body summarizing one finished account call. */
function presentAccountResult(args, result) {
  const content = renderAccountOutput(args, result)
  if (args.action === 'models') {
    const count = Array.isArray(result?.models) ? result.models.length : 0
    return { card: 'generic', title: `WorkBuddy 模型目录 · ${count} 个模型`, content }
  }
  if (args.action === 'checkin') {
    const checkins = Array.isArray(result?.checkins) ? result.checkins : []
    const signed = checkins.filter((view) => view.status === 'ok' || view.status === 'already').length
    const failed = checkins.filter((view) => view.status === 'failed').length
    const parts = [`${checkins.length} 个账号`, `已签 ${signed}`]
    if (failed > 0) parts.push(`失败 ${failed}`)
    return { card: 'generic', title: `WorkBuddy 签到 · ${parts.join(' · ')}`, content }
  }
  const accounts = Array.isArray(result?.accounts) ? result.accounts : []
  const sum = (key) =>
    accounts.reduce((total, account) => (Number.isFinite(account?.quota?.[key]) ? total + account.quota[key] : total), 0)
  const remaining = sum('remaining')
  const totalCredits = sum('total')
  const pinned = typeof result?.pinnedAccount === 'string' && result.pinnedAccount.length > 0 ? result.pinnedAccount : ''
  const parts = [`${accounts.length} 个账号`]
  if (totalCredits > 0) parts.push(`剩余 ${formatCredits(remaining)}/${formatCredits(totalCredits)} 积分`)
  if (pinned.length > 0) parts.push(`新会话使用 ${pinned}`)
  const title = args.action === 'quota' ? `WorkBuddy 积分 · ${parts.join(' · ')}` : `WorkBuddy 账号 · ${parts.join(' · ')}`
  return { card: 'generic', title, content }
}

/** Read an access token or a WorkBuddy auth JSON document from one file. */
function readTokenFile(path) {
  const raw = readFileSync(path, 'utf8').trim()
  if (raw.length === 0) throw new Error(`token file ${path} is empty`)
  // A bare token file must live in a known credential directory: a model that
  // was prompt-injected into naming an arbitrary path gets nothing out of it.
  if (!raw.startsWith('{')) {
    if (!underRawTokenRoot(path)) {
      throw new Error(
        `token file ${path} is outside the allowed directories for a bare token (${rawTokenRoots().join(', ')}); pass a JSON auth document or the accessToken argument instead`,
      )
    }
    return { accessToken: assertTokenShape(raw, path) }
  }
  let document
  try {
    document = JSON.parse(raw)
  } catch {
    // The parser message quotes the offending line, which here holds a secret.
    throw new Error(`token file ${path} is neither a raw token nor a valid JSON document`)
  }
  const auth = typeof document.auth === 'object' && document.auth !== null ? document.auth : document
  const account = typeof document.account === 'object' && document.account !== null ? document.account : document
  const accessToken = typeof auth.accessToken === 'string' ? auth.accessToken : undefined
  if (accessToken === undefined) throw new Error(`token file ${path} has no accessToken`)
  return {
    accessToken: assertTokenShape(accessToken, path),
    refreshToken:
      typeof auth.refreshToken === 'string' && auth.refreshToken.trim().length > 0 ? auth.refreshToken.trim() : undefined,
    domain: typeof auth.domain === 'string' ? auth.domain : undefined,
    realm: typeof auth.realm === 'string' ? auth.realm : undefined,
    uid: typeof account.uid === 'string' ? account.uid : undefined,
    enterpriseId: typeof account.enterpriseId === 'string' ? account.enterpriseId : '',
    nickname: typeof account.nickname === 'string' ? account.nickname : undefined,
  }
}

/** The login tool's output schema. */
const LOGIN_OUTPUT = {
  type: 'object',
  additionalProperties: false,
  properties: {
    action: { type: 'string', required: true },
    status: { type: 'string', required: true },
    authUrl: { type: 'string' },
    state: { type: 'string' },
    realm: { type: 'string' },
    instruction: { type: 'string' },
    account: {
      type: 'object',
      additionalProperties: false,
      properties: {
        id: { type: 'string', required: true },
        uid: { type: 'string' },
        nickname: { type: 'string' },
        realm: { type: 'string' },
        expiresAt: { type: 'string' },
      },
    },
  },
}

/** One normalized credits snapshot produced by the billing meter. */
const QUOTA_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    kind: { type: 'string' },
    supported: { type: 'boolean' },
    unit: { type: 'string' },
    total: { type: 'number' },
    remaining: { type: 'number' },
    used: { type: 'number' },
    unlimited: { type: 'boolean' },
    resetAt: { type: 'string' },
    fetchedAt: { type: 'string' },
    endpoint: { type: 'string' },
    packName: { type: 'string' },
    packageCount: { type: 'number' },
    packs: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          name: { type: 'string' },
          total: { type: 'number' },
          remaining: { type: 'number' },
          used: { type: 'number' },
          resetAt: { type: 'string' },
          expiresAt: { type: 'string' },
        },
      },
    },
  },
}

/** The account tool's output schema. */
const ACCOUNT_OUTPUT = {
  type: 'object',
  additionalProperties: false,
  properties: {
    action: { type: 'string', required: true },
    pinnedAccount: { type: 'string' },
    accounts: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          id: { type: 'string', required: true },
          uid: { type: 'string' },
          nickname: { type: 'string' },
          realm: { type: 'string' },
          enterprise: { type: 'boolean' },
          source: { type: 'string' },
          configured: { type: 'boolean' },
          pinned: { type: 'boolean' },
          expiresAt: { type: 'string' },
          expiresInSeconds: { type: 'number' },
          coolingUntil: { type: 'string' },
          quota: QUOTA_SCHEMA,
          quotaError: { type: 'string' },
        },
      },
    },
    removed: { type: 'boolean' },
    modelLimits: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          model: { type: 'string', required: true },
          until: { type: 'string', required: true },
        },
      },
    },
    models: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          id: { type: 'string', required: true },
          name: { type: 'string' },
          description: { type: 'string' },
          contextWindow: { type: 'number' },
          maxTokens: { type: 'number' },
          reasoningEfforts: { type: 'array', items: { type: 'string' } },
          supportsToolCall: { type: 'boolean' },
          supportsImages: { type: 'boolean' },
          credits: { type: 'number' },
          effectiveCredits: { type: 'number' },
          priceLabel: { type: 'string' },
          promotion: {
            type: 'object',
            additionalProperties: false,
            properties: {
              id: { type: 'string', required: true },
              label: { type: 'string' },
              factor: { type: 'number' },
              text: { type: 'string' },
              active: { type: 'boolean' },
              validUntil: { type: 'string' },
            },
          },
        },
      },
    },
    checkins: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          accountId: { type: 'string', required: true },
          status: { type: 'string', required: true },
          at: { type: 'string' },
          attempts: { type: 'number' },
          reason: { type: 'string' },
          error: { type: 'string' },
          credit: { type: 'number' },
          streakDays: { type: 'number' },
          isStreakDay: { type: 'boolean' },
        },
      },
    },
  },
}

/**
 * Register both account tools on the plugin context.
 * @param {object} ctx plugin context carrying `tools`.
 * @param {object} deps `{ pool, options, adapter, logger }`.
 * @returns an array of disposers.
 */
export function registerAccountTools(ctx, { pool, options, adapter, logger }) {
  const disposers = []
  disposers.push(
    ctx.tools.register(
      defineTool({
        name: 'workbuddy_login',
        description:
          'Sign a WorkBuddy (Tencent CodeBuddy) account in to the WorkBuddy model provider, so its models become available to this harness. Multiple accounts can be signed in and are load-balanced per request. ' +
          'action="start" returns a one-time browser authorization URL and a state value; action="finish" polls that state for up to ~20s after the human authorizes in a browser; action="token" imports an existing access token (prefer tokenFile pointing at a WorkBuddy auth JSON file so the secret never enters the conversation). ' +
          'This tool returns account ids and expiry only, never token values. Use the workbuddy_account tool to list the signed-in accounts, pin the one new conversations should use, or read credit balances.',
        parameters: {
          action: {
            type: 'string',
            required: true,
            enum: ['start', 'finish', 'token'],
            description: 'start begins a browser sign-in, finish completes it, token imports an existing token.',
          },
          realm: {
            type: 'string',
            enum: ['cn', 'global'],
            description: 'WorkBuddy realm; defaults to the provider configuration (usually cn).',
          },
          state: { type: 'string', description: 'The state value returned by action="start".' },
          accountId: {
            type: 'string',
            description: 'Optional account id (lowercase letters, digits, hyphens) to store the credential under.',
          },
          accessToken: {
            type: 'string',
            description: 'Raw access token for action="token". Prefer tokenFile: pasted values are recorded in the session log.',
          },
          tokenFile: {
            type: 'string',
            description: 'Path to a file holding either the raw access token or a WorkBuddy auth JSON document.',
          },
          refreshToken: { type: 'string', description: 'Optional refresh token for action="token".' },
          uid: { type: 'string', description: 'Optional WorkBuddy account uid; fetched from the profile endpoint when omitted.' },
          domain: { type: 'string', description: 'Optional product domain stored on the account.' },
          enterpriseId: { type: 'string', description: 'Optional enterprise id for enterprise accounts.' },
        },
        output: {
          schema: LOGIN_OUTPUT,
          render: (_args, value) => {
            if (value.status === 'pending' && typeof value.authUrl === 'string') {
              return [
                {
                  type: 'text',
                  text: `Open this URL in a browser, sign in to WorkBuddy, then run the login finish step:\n${value.authUrl}\nstate: ${value.state ?? ''}`,
                },
              ]
            }
            if (value.account !== undefined) {
              return [{ type: 'text', text: `WorkBuddy account connected: ${describeAccount(value.account)}` }]
            }
            return [{ type: 'text', text: typeof value.instruction === 'string' ? value.instruction : `WorkBuddy login ${value.status}` }]
          },
        },
        async execute(args) {
          if (args.action === 'start') {
            const started = await pool.startLogin(args.realm)
            return {
              action: 'start',
              status: 'pending',
              authUrl: started.authUrl,
              state: started.state,
              realm: started.realm,
              instruction:
                'Show authUrl to the user, wait for them to finish authorizing in the browser, then call workbuddy_login with action="finish" and this state.',
            }
          }
          if (args.action === 'finish') {
            if (typeof args.state !== 'string' || args.state.length === 0) {
              throw new Error('workbuddy_login action="finish" needs the state returned by action="start"')
            }
            const finished = await pool.finishLogin(args.state)
            if (finished.status === 'connected') {
              pool.invalidateCatalog()
              return { action: 'finish', status: 'connected', account: summarize(finished.account) }
            }
            return {
              action: 'finish',
              status: 'pending',
              state: args.state,
              instruction:
                'The authorization is still pending. The user may not have finished the browser sign-in yet; call workbuddy_login with action="finish" again after they confirm.',
            }
          }
          // action === 'token'
          let imported
          if (typeof args.tokenFile === 'string' && args.tokenFile.length > 0) {
            imported = readTokenFile(args.tokenFile)
          } else if (typeof args.accessToken === 'string' && args.accessToken.length > 0) {
            imported = { accessToken: assertTokenShape(args.accessToken, 'the accessToken argument') }
          } else {
            throw new Error('workbuddy_login action="token" needs tokenFile or accessToken')
          }
          const realm = args.realm ?? imported.realm ?? options().realm
          const identity = {
            uid: args.uid ?? imported.uid,
            nickname: imported.nickname,
            enterpriseId: args.enterpriseId ?? imported.enterpriseId ?? '',
            domain: args.domain ?? imported.domain,
          }
          if (identity.uid === undefined) {
            const profile = await fetchProfile({ config: options(), realm, accessToken: imported.accessToken })
            identity.uid = profile.uid
            identity.nickname = profile.nickname ?? identity.nickname
          }
          const account = await pool.importToken({
            realm,
            accessToken: imported.accessToken,
            refreshToken: typeof args.refreshToken === 'string' ? args.refreshToken : imported.refreshToken,
            identity,
            accountId: typeof args.accountId === 'string' && args.accountId.length > 0 ? args.accountId : undefined,
          })
          pool.invalidateCatalog()
          logger.info(`llm-workbuddy: imported the token credential for account "${account.id}"`)
          return { action: 'token', status: 'connected', account: summarize(account) }
        },
        presentCall: (args) => {
          // Never echo a pasted or file-loaded secret into the UI card, for any
          // action; the card is part of the session transcript.
          const { accessToken: _accessToken, refreshToken: _refreshToken, tokenFile: _tokenFile, ...rest } = args
          return {
            card: 'generic',
            title: `WorkBuddy login (${args.action})`,
            kind: 'other',
            rawInput: args.action === 'token' ? { ...rest, action: args.action } : rest,
          }
        },
      }),
    ),
  )
  disposers.push(
    ctx.tools.register(
      defineTool({
        name: 'workbuddy_account',
        description:
          'Inspect, switch, or maintain the WorkBuddy model provider accounts. ' +
          'action="list" shows every signed-in WorkBuddy account with token expiry, cooldown state, which account is pinned, and its credit balance; ' +
          'action="quota" re-reads the credit balance from the billing meter for one or all accounts; ' +
          'action="use" pins one account for conversations started from now on (falling back to the pool only while it is cooling down or signed out); a conversation already under way keeps the account it locked; ' +
          'action="auto" clears the pin, so conversations started from now on return to the account pool; ' +
          'action="checkin" runs the WorkBuddy daily check-in (idempotent: already signed in today is reported as success; enterprise and global-realm accounts have no check-in and are skipped); ' +
          'action="remove" deletes one stored account credential; action="refresh" forces token rotation for one or all accounts; ' +
          'action="models" queries the live WorkBuddy model catalog with the first usable account and lists each model\'s credit list price plus the promotion active right now (the WorkBuddy channel publishes prices and discount campaigns that the CodeBuddy channel does not). Token values are never returned.',
        parameters: {
          action: {
            type: 'string',
            required: true,
            enum: ['list', 'remove', 'refresh', 'models', 'use', 'auto', 'quota', 'checkin'],
            description: 'list | quota | checkin | use | auto | remove | refresh | models',
          },
          accountId: {
            type: 'string',
            description: 'Target account id for use/quota/checkin/remove/refresh; omit to refresh, probe, or check in every account.',
          },
          confirmAccountId: {
            type: 'string',
            description: 'For action="remove": must repeat the same accountId. Deleting a credential is refused without it.',
          },
          includeQuota: {
            type: 'boolean',
            description: 'For action="list": include cached credit balances (default: the provider `quotaInList` setting).',
          },
          includeCheckin: {
            type: 'boolean',
            description: 'For action="list": include today\u2019s cached check-in status (default true; reads the local record, never calls the upstream).',
          },
          force: {
            type: 'boolean',
            description: 'For action="checkin": ignore today\u2019s cached result and ask the upstream again (manual retries are not capped by `checkinMaxAttempts`).',
          },
        },
        output: {
          schema: ACCOUNT_OUTPUT,
          render: renderAccountOutput,
        },
        presentCall: presentAccountCall,
        presentResult: presentAccountResult,
        async execute(args) {
          if (args.action === 'list' || args.action === 'use' || args.action === 'auto' || args.action === 'quota') {
            if (args.action === 'use') {
              if (typeof args.accountId !== 'string' || args.accountId.length === 0) {
                throw new Error('workbuddy_account action="use" needs the accountId returned by action="list"')
              }
              await pool.pinAccount(args.accountId)
            } else if (args.action === 'auto') {
              await pool.unpinAccount()
            }
            const targetId = typeof args.accountId === 'string' && args.accountId.length > 0 ? args.accountId : undefined
            if (args.action === 'quota' && targetId !== undefined) {
              // Unknown ids must fail loudly instead of reporting an empty list.
              if ((await pool.getAccount(targetId)) === undefined) throw new Error(`no WorkBuddy account "${targetId}"`)
              await pool.quotaFor(targetId, { force: true })
            }
            let askQuota
            if (args.action === 'quota') askQuota = true
            else if (args.includeQuota === undefined) askQuota = options().quotaInList
            else askQuota = args.includeQuota === true
            const rows = await pool.accountViews({ quota: askQuota, forceQuota: args.action === 'quota' && targetId === undefined })
            const accounts = targetId === undefined ? rows : rows.filter((account) => account.id === targetId)
            const includeCheckin = args.includeCheckin === undefined ? true : args.includeCheckin === true
            return {
              action: args.action,
              pinnedAccount: await pool.pinnedAccountId(),
              accounts,
              modelLimits: await pool.modelLimits(),
              ...(includeCheckin ? { checkins: await pool.checkinViews() } : {}),
            }
          }
          if (args.action === 'checkin') {
            const targetId = typeof args.accountId === 'string' && args.accountId.length > 0 ? args.accountId : undefined
            assertForcedCheckinBudget(targetId, args.force)
            await pool.checkinAll({ accountId: targetId, force: args.force === true })
            return {
              action: 'checkin',
              pinnedAccount: await pool.pinnedAccountId(),
              accounts: await pool.accountViews(),
              checkins: await pool.checkinViews(),
            }
          }
          if (args.action === 'remove') {
            if (typeof args.accountId !== 'string' || args.accountId.length === 0) {
              throw new Error('workbuddy_account action="remove" needs accountId')
            }
            // Two-step delete: a prompt-injected tool call must not be able to
            // clear the pool with one argument it guessed.
            if (args.confirmAccountId !== args.accountId) {
              throw new Error(
                `workbuddy_account action="remove" needs confirmAccountId set to the same value as accountId ("${args.accountId}") before an account credential is deleted`,
              )
            }
            await pool.removeAccount(args.accountId)
            adapter?.releaseSessionLocks?.(args.accountId)
            pool.invalidateCatalog()
            return { action: 'remove', removed: true, pinnedAccount: await pool.pinnedAccountId(), accounts: await pool.accountViews() }
          }
          if (args.action === 'refresh') {
            const accounts = await pool.listAccounts()
            const targets =
              typeof args.accountId === 'string' && args.accountId.length > 0
                ? accounts.filter((account) => account.id === args.accountId)
                : accounts
            if (targets.length === 0) throw new Error('no matching WorkBuddy account to refresh')
            for (const account of targets) {
              try {
                // eslint-disable-next-line no-await-in-loop
                await pool.getAccessToken(account.id, { force: true })
              } catch (error) {
                logger.warn(`llm-workbuddy: refreshing account "${account.id}" failed: ${error.message}`)
              }
            }
            return { action: 'refresh', pinnedAccount: await pool.pinnedAccountId(), accounts: await pool.accountViews() }
          }
          // action === 'models'
          const accounts = await pool.listAccounts()
          if (accounts.length === 0) throw new Error('no WorkBuddy account is signed in; use workbuddy_login first')
          const config = options()
          const account = accounts[0]
          const { accessToken } = await pool.getAccessToken(account.id)
          const live = await fetchLiveModels({ config, account, accessToken })
          return {
            action: 'models',
            models: live.map((model) => ({
              id: model.id,
              ...(model.name === undefined ? {} : { name: model.name }),
              ...(model.description === undefined ? {} : { description: model.description }),
              ...(model.contextWindow === undefined ? {} : { contextWindow: model.contextWindow }),
              ...(model.maxTokens === undefined ? {} : { maxTokens: model.maxTokens }),
              ...(model.reasoningEfforts === null || model.reasoningEfforts === undefined ? {} : { reasoningEfforts: model.reasoningEfforts }),
              ...(model.supportsToolCall === undefined ? {} : { supportsToolCall: model.supportsToolCall }),
              ...(model.supportsImages === undefined ? {} : { supportsImages: model.supportsImages }),
              ...(Number.isFinite(model.credits) ? { credits: model.credits } : {}),
              ...(Number.isFinite(model.effectiveCredits) ? { effectiveCredits: model.effectiveCredits } : {}),
              ...(model.priceLabel === undefined ? {} : { priceLabel: model.priceLabel }),
              ...(model.promotion === undefined ? {} : { promotion: model.promotion }),
            })),
          }
        },
        isConcurrencySafe: () => false,
      }),
    ),
  )
  return disposers
}

/** The provider route the account tools belong to (documentation/tests). */
export const TOOL_PROVIDER = PROVIDER
