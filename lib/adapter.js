/**
 * The WorkBuddy chat-completions adapter for the harness LLM seam.
 *
 * One provider route (`workbuddy`) serves every catalog model. Each request
 * picks a healthy account, resolves its token (refreshing when needed), maps the
 * provider-neutral harness request onto an OpenAI-style `chat/completions`
 * body, and translates WorkBuddy's SSE stream back into `StreamChunk`s.
 *
 * @module dsh-workbuddy-switch/adapter
 */

import {
  IMAGE_OFFLOAD_REQUIRED_CODE,
  LlmAdapter,
  LlmError,
  offloadedImageText,
  projectOffloadedImages,
  requestImageHandleText,
  requiredImageOffload,
  textOnlyImageText,
} from '@deepseek-ai/dsh-llm'
import { requestImageDimensions } from '@deepseek-ai/dsh-attachment'
import { credentialKey } from '@deepseek-ai/dsh-credentials'
import { modelBadgeOf } from './pricing.js'
import { resolveModelCapability, SETTINGS_SCOPE } from './config.js'
import { SessionCredits } from './session-credits.js'
import { classifyStreamError, randomHex, seededUuid, streamChat } from './upstream.js'

/** Finish reasons that may retry on another account. */
const RETRY_ON_OTHER_ACCOUNT = new Set(['AUTH', 'QUOTA', 'ACCOUNT_QUOTA', 'MODEL_RATE_LIMIT', 'RATE_LIMIT', 'SERVER', 'TRANSPORT', 'TIMEOUT'])

/** Credential-record id (inside `SETTINGS_SCOPE`) holding the per-session spend. */
const USAGE_RECORD_ID = 'usage'

/** Failures that mean "this model cannot be served by the pool right now". */
const MODEL_UNAVAILABLE_CODES = new Set(['QUOTA', 'ACCOUNT_QUOTA', 'MODEL_RATE_LIMIT', 'RATE_LIMIT'])

/**
 * Actionable failure raised when every account rejects the model the user
 * picked. The account pool never swaps models on its own: routing a turn to a
 * model nobody chose would hide both the spend and the capability change.
 */
function modelUnavailableMessage(model, accountCount, cause) {
  const code = cause === undefined || cause.code === undefined ? 'UNKNOWN' : cause.code
  return (
    `llm-workbuddy: 模型「${model}」在全部 ${accountCount} 个账号上均不可用（额度不足或限流，最后错误：${code}），请切换模型后重试。`
    + ` / "${model}" is unavailable on all ${accountCount} accounts (${code}); switch to another model and retry.`
  )
}

/** Upper bound on remembered session locks; the oldest session is forgotten first. */
const SESSION_LOCK_LIMIT = 200

/**
 * One cooldown instant on the reader's own wall clock, e.g. `2026-11-14 04:00`.
 *
 * The pool schedules cooldowns against the local clock (a QUOTA cooldown runs to
 * the next local 04:00), so an ISO instant would name a different hour than the
 * one the user waits for.
 * @param {number} at epoch milliseconds.
 * @returns {string} the local date and time.
 */
function formatCooldown(at) {
  const date = new Date(at)
  const pad = (value) => String(value).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`
}

/**
 * The session id a lock is stored under, or undefined for a session-less request
 * (a session title, a one-off subagent call), which must never share a lock.
 * @param {object} callOptions the harness request.
 * @returns {string | undefined} the lock key.
 */
function sessionLockKey(callOptions) {
  const id = callOptions.sessionId
  if (typeof id === 'string') return id.length > 0 ? id : undefined
  return typeof id === 'number' ? String(id) : undefined
}

/**
 * The failure a locked session raises instead of moving to another account.
 *
 * Quota and model-limit failures are reported as `QUOTA` on purpose: it is the
 * only code the harness turns into a frame-wide notice, and the user has to
 * decide (wait for the reset, switch account, switch model). Everything else
 * keeps its own code.
 * @param {string} model the model the user asked for.
 * @param {string} accountId the account the session is locked to.
 * @param {{reason?: string, code?: string, until?: number}} blocked why the lock stopped.
 * @returns {LlmError} the failure to throw.
 */
function sessionLockFailure(model, accountId, blocked) {
  const cause = blocked.code
  const limit = MODEL_UNAVAILABLE_CODES.has(cause)
  const signedOut = blocked.reason === 'signed-out' || cause === 'AUTH'
  let code = cause ?? 'RATE_LIMIT'
  let why = '暂时不可用'
  let whyEn = 'is unavailable'
  if (limit) {
    code = 'QUOTA'
    why = '已到额度或模型使用量上限'
    whyEn = 'hit its quota or model limit'
  } else if (signedOut) {
    code = 'AUTH'
    why = '登录已失效'
    whyEn = 'is signed out'
  }
  const until = blocked.until === undefined ? '' : `，解除时间 ${formatCooldown(blocked.until)}`
  const untilEn = blocked.until === undefined ? '' : `, resets ${formatCooldown(blocked.until)} (local time)`
  return new LlmError(
    `llm-workbuddy: 本会话锁定账号「${accountId}」，该账号上的模型「${model}」${why}（${cause ?? 'UNKNOWN'}）${until}；会话锁已解除，重试可换号，或在设置页换用其他账号。`
      + ` / this session is locked to account "${accountId}", whose "${model}" route ${whyEn} (${cause ?? 'UNKNOWN'})${untilEn}; the session lock is released, so a retry may use another account.`,
    code,
  )
}

/** Provider finish reasons mapped to the harness vocabulary. */
const FINISH_REASONS = Object.freeze({
  stop: { kind: 'stop' },
  length: { kind: 'max-tokens' },
  tool_calls: { kind: 'tool-calls' },
  function_call: { kind: 'tool-calls' },
  content_filter: { kind: 'stop' },
})

/** The IMAGE_OFFLOAD_REQUIRED failure for a request that carries too many images. */
function imageOffloadError(count) {
  return new LlmError(
    `llm-workbuddy: request images exceed this route's budget; ${count} more oldest occurrence(s) must be offloaded.`,
    IMAGE_OFFLOAD_REQUIRED_CODE,
    { offloadImages: count },
  )
}

/** Join the text blocks of one message, ignoring other block kinds. */
function textOf(blocks) {
  if (typeof blocks === 'string') return blocks
  if (!Array.isArray(blocks)) return ''
  let text = ''
  for (const block of blocks) if (block?.type === 'text' && typeof block.text === 'string') text += block.text
  return text
}

/** The reasoning text of one assistant message. */
function reasoningOf(blocks) {
  if (!Array.isArray(blocks)) return ''
  let text = ''
  for (const block of blocks) if (block?.type === 'reasoning' && typeof block.text === 'string') text += block.text
  return text
}

/** The tool calls of one assistant message. */
function toolCallsOf(blocks) {
  if (!Array.isArray(blocks)) return []
  const calls = []
  for (const block of blocks) {
    if (block?.type !== 'tool-call') continue
    calls.push({
      id: typeof block.id === 'string' && block.id.length > 0 ? block.id : `call-${calls.length}`,
      name: typeof block.name === 'string' ? block.name : '',
      arguments: typeof block.arguments === 'string' ? block.arguments : '{}',
    })
  }
  return calls
}

/** Media types a WorkBuddy route accepts as an inline `image_url` data URL. */
const IMAGE_MEDIA_TYPES = Object.freeze(['image/png', 'image/jpeg', 'image/webp', 'image/gif'])

/** Inline data URL for one prepared request image. */
function imageDataUrl(version) {
  return `data:${version.mediaType};base64,${Buffer.from(version.data).toString('base64')}`
}

/**
 * The dimensions and byte target one route asks the attachment store for. It
 * matches pi-ai's OpenAI-style budget, so an image is never enlarged and the
 * encoded payload stays inside what the upstream accepts.
 */
function imageTargetOf(options, ref) {
  return {
    ...requestImageDimensions(ref.width, ref.height, options.requestImagePixelBudget),
    maxBytes: options.requestImageMaxBytes,
  }
}

/** Collect the durable image references one request still has to send, in history order. */
function collectImageRefs(messages, refs) {
  for (const message of messages) {
    if (Array.isArray(message?.content) !== true) continue
    for (const block of message.content) {
      if (block?.type === 'image' && block.offloaded !== true) refs.set(block.attachment.attachmentId, block.attachment)
    }
  }
}

/**
 * Turn one image occurrence into the two parts an OpenAI-style request carries:
 * the deterministic model-facing handle text and the inline `image_url` part.
 * A text-only route (no prepared version) gets the canonical placeholder.
 */
function imageParts(block, images, imageAccess, prefix = '') {
  const version = images?.get(block.attachment.attachmentId)
  if (version === undefined || IMAGE_MEDIA_TYPES.includes(version.mediaType) !== true) {
    return [{ type: 'text', text: `${prefix}${textOnlyImageText(block.attachment)}` }]
  }
  const handle = requestImageHandleText(block.attachment, version, imageAccess?.(block.attachment))
  return [
    { type: 'text', text: `${prefix}${handle}` },
    { type: 'image_url', image_url: { url: imageDataUrl(version) } },
  ]
}

/** OpenAI-style text/image parts for one message's content blocks. */
function contentParts(blocks, images, imageAccess) {
  const parts = []
  if (typeof blocks === 'string') return [{ type: 'text', text: blocks }]
  if (!Array.isArray(blocks)) return parts
  for (const block of blocks) {
    if (block?.type === 'text') {
      if (typeof block.text === 'string' && block.text.length > 0) parts.push({ type: 'text', text: block.text })
      continue
    }
    if (block?.type === 'image') parts.push(...imageParts(block, images, imageAccess))
  }
  return parts
}

/** Collapse content parts: a bare string for one text part, else parts. */
function contentValue(parts) {
  if (parts.length === 0) return undefined
  if (parts.length === 1 && parts[0].type === 'text') return parts[0].text
  return parts
}

/** Deep-clone a JSON tool schema, unescaping regex `\_` that the upstream rejects. */
function sanitizeToolSchema(value) {
  if (Array.isArray(value)) return value.map((entry) => sanitizeToolSchema(entry))
  if (typeof value !== 'object' || value === null) return value
  const result = {}
  for (const [key, child] of Object.entries(value)) {
    if ((key === 'pattern' || key === 'patternProperties') && typeof child === 'string') {
      result[key] = child.replace(/\\_/gu, '_')
      continue
    }
    result[key] = sanitizeToolSchema(child)
  }
  return result
}

/** Serialize harness tool declarations as OpenAI function tools. */
function serializeTools(tools) {
  if (!Array.isArray(tools) || tools.length === 0) return undefined
  const serialized = tools.map((tool) => {
    const parameters =
      typeof tool.parameters === 'object' && tool.parameters !== null
        ? sanitizeToolSchema(tool.parameters)
        : { type: 'object', properties: {} }
    return {
      type: 'function',
      function: {
        name: tool.name,
        ...(typeof tool.description === 'string' && tool.description.length > 0
          ? { description: tool.description }
          : {}),
        parameters,
      },
    }
  })
  return serialized
}

/**
 * Convert a harness request into the provider's OpenAI-style message list.
 *
 * Images in user messages become native `image_url` parts. The OpenAI message
 * shape cannot carry images on a `tool` message, so tool-result images are
 * collected and replayed as one following user message once the run of tool
 * results ends — never between an assistant call and its own tool result, which
 * would break the upstream's tool pairing.
 *
 * @param callOptions - the harness request.
 * @param capability - resolved model capability facts.
 * @param images - prepared request images keyed by attachment id, when the route accepts images.
 * @param imageAccess - resolves an image's read-only execution-world path.
 * @returns the message array.
 */
function serializeMessages(callOptions, capability, images, imageAccess) {
  const messages = []
  const systemTexts = []
  const pendingToolImages = []
  // Tool call ids of the last assistant turn, consumed in order by the tool
  // messages that follow it. A tool result that lost its id is reattached here
  // instead of being sent with an empty `tool_call_id`, which a strict upstream
  // rejects with a 400 that names nothing useful.
  let unclaimedToolCallIds = []
  const flushToolImages = () => {
    if (pendingToolImages.length === 0) return
    const parts = []
    for (const { toolCallId, block } of pendingToolImages.splice(0)) {
      const label = toolCallId.length > 0 ? `Image returned by tool call "${toolCallId}": ` : 'Image returned by a tool: '
      parts.push(...imageParts(block, images, imageAccess, label))
    }
    if (parts.length > 0) messages.push({ role: 'user', content: parts })
  }
  if (typeof callOptions.system === 'string' && callOptions.system.length > 0) systemTexts.push(callOptions.system)
  const history = Array.isArray(callOptions.messages) ? callOptions.messages : []
  for (const message of history) {
    if (message?.role === 'system' || message?.role === 'developer') {
      flushToolImages()
      const text = textOf(message.content)
      if (text.length > 0) systemTexts.push(text)
      continue
    }
    if (message?.role === 'user') {
      flushToolImages()
      const content = contentValue(contentParts(message.content, images, imageAccess))
      if (content === undefined) continue
      messages.push({ role: 'user', content })
      continue
    }
    if (message?.role === 'assistant') {
      flushToolImages()
      const text = textOf(message.content)
      const calls = toolCallsOf(message.content)
      const reasoning = reasoningOf(message.content)
      if (text.length === 0 && calls.length === 0 && reasoning.length === 0) continue
      let content = ''
      if (text.length > 0) content = text
      else if (calls.length > 0) content = null
      const entry = { role: 'assistant', content }
      if (calls.length > 0) {
        entry.tool_calls = calls.map((call) => ({
          id: call.id,
          type: 'function',
          function: { name: call.name, arguments: call.arguments },
        }))
        unclaimedToolCallIds = calls.map((call) => (typeof call.id === 'string' ? call.id : ''))
      }
      if (capability.isDeepSeek) {
        entry.reasoning_content = reasoning
        entry.reasoning = reasoning.length > 0 ? reasoning : ' '
      } else if (reasoning.length > 0) {
        entry.reasoning_content = reasoning
      }
      messages.push(entry)
      continue
    }
    if (message?.role === 'tool') {
      const text = textOf(message.content)
      const explicitId = typeof message.toolCallId === 'string' ? message.toolCallId : ''
      let toolCallId = explicitId
      if (toolCallId.length > 0) {
        // Claim the matching id so a later id-less tool message cannot reuse it.
        const claimed = unclaimedToolCallIds.indexOf(toolCallId)
        if (claimed !== -1) unclaimedToolCallIds.splice(claimed, 1)
      } else {
        toolCallId = unclaimedToolCallIds.shift() ?? ''
      }
      if (toolCallId.length === 0) {
        throw new LlmError('llm-workbuddy: a tool message in this conversation has no toolCallId', 'INVALID_REQUEST')
      }
      const emptyText = message.isError === true ? '(tool failed with no output)' : '(no output)'
      messages.push({
        role: 'tool',
        tool_call_id: toolCallId,
        content: text.length > 0 ? text : emptyText,
      })
      if (Array.isArray(message.content)) {
        for (const block of message.content) {
          if (block?.type === 'image') pendingToolImages.push({ toolCallId, block })
        }
      }
    }
  }
  flushToolImages()
  // The harness prompt is forwarded as assembled: the plugin rewrites nothing.
  const systemText = systemTexts.join('\n\n')
  if (systemText.length === 0) return messages
  return [{ role: 'system', content: systemText }, ...messages]
}

/** Resolve the effective reasoning effort for one request. */
function effectiveEffort(callOptions, capability) {
  if (capability.reasoning === undefined) return undefined
  if (callOptions.purpose === 'session-title') {
    const offered = capability.reasoning.efforts.some((effort) => effort.id === 'off')
    return offered ? 'off' : capability.reasoning.defaultEffort
  }
  return callOptions.reasoningEffort ?? capability.reasoning.defaultEffort
}

/** Build the outbound chat body for one attempt. */
export function buildRequestBody({ callOptions, options, capability, account, conversationId, images, imageAccess }) {
  const effort = effectiveEffort(callOptions, capability)
  const maxTokens = callOptions.maxTokens ?? capability.entry?.maxTokens ?? options.defaultMaxTokens
  const clampedMaxTokens =
    capability.isGpt === true && Number.isFinite(maxTokens) && maxTokens < 16 ? 16 : Math.floor(maxTokens)
  const body = {
    model: callOptions.model,
    messages: serializeMessages(callOptions, capability, images, imageAccess),
    stream: true,
    stream_options: { include_usage: true },
    max_tokens: clampedMaxTokens,
  }
  if (callOptions.temperature !== undefined) body.temperature = callOptions.temperature
  if (Array.isArray(callOptions.stop) && callOptions.stop.length > 0) body.stop = callOptions.stop
  const tools = serializeTools(callOptions.tools)
  if (tools !== undefined) body.tools = tools
  const reasoningEffort = effort !== undefined && effort !== 'off' ? effort : undefined
  if (capability.isDeepSeek) body.thinking = { type: effort === 'off' ? 'disabled' : 'enabled' }
  if (reasoningEffort !== undefined) body.reasoning_effort = reasoningEffort
  if (options.promptCacheKey && typeof conversationId === 'string' && conversationId.length > 0) {
    body.prompt_cache_key = seededUuid(`llm-workbuddy|prompt-cache|${account.uid ?? account.id}|${conversationId}`)
  }
  return body
}

/** Derive the conversation/request/trace id family for one attempt. */
export function buildConversationIds(callOptions) {
  const sessionKey = callOptions.sessionId === undefined ? 'no-session' : String(callOptions.sessionId)
  return {
    conversationId: seededUuid(`llm-workbuddy|conversation|${sessionKey}`),
    conversationRequestId: randomHex(16),
    messageId: randomHex(16),
  }
}

/** Map OpenAI usage counts onto the harness usage vocabulary. */
export function mapUsage(usage) {
  if (typeof usage !== 'object' || usage === null) return undefined
  // Accept both the OpenAI and the Anthropic-style spellings; an upstream that
  // answers with the latter would otherwise be recorded as a zero-token turn.
  const promptCount = Number.isFinite(usage.prompt_tokens) ? usage.prompt_tokens : usage.input_tokens
  const prompt = Number.isFinite(promptCount) ? promptCount : undefined
  const completionCount = Number.isFinite(usage.completion_tokens) ? usage.completion_tokens : usage.output_tokens
  const completion = Number.isFinite(completionCount) ? completionCount : 0
  const cached =
    usage.prompt_tokens_details?.cached_tokens ??
    usage.cache_read_input_tokens ??
    usage.cached_tokens ??
    usage.prompt_cache_hit_tokens
  const cacheRead = Number.isFinite(cached) && cached > 0 ? cached : 0
  const inputTokens = prompt === undefined ? 0 : Math.max(0, prompt - cacheRead)
  const totalTokens = Number.isFinite(usage.total_tokens) ? usage.total_tokens : (prompt ?? 0) + completion
  return {
    inputTokens,
    outputTokens: completion,
    totalTokens,
    ...(cacheRead > 0 ? { cacheReadTokens: cacheRead } : {}),
  }
}

/** Map one provider finish reason. */
function mapFinishReason(reason) {
  if (typeof reason !== 'string' || reason.length === 0) return undefined
  return FINISH_REASONS[reason] ?? { kind: 'stop' }
}

/** Apply one complete content/reasoning/tool-call delta bundle, yielding chunks. */
async function* applyDelta(delta, state) {
  const reasoningSource = typeof delta.reasoning_content === 'string' ? delta.reasoning_content : delta.reasoning
  const reasoningText = typeof reasoningSource === 'string' ? reasoningSource : ''
  if (reasoningText.length > 0) {
    if (state.reasoning === undefined) {
      state.reasoning = { index: state.nextIndex++, text: '' }
      yield { type: 'block-start', index: state.reasoning.index, blockType: 'reasoning' }
    }
    state.reasoning.text += reasoningText
    yield { type: 'reasoning-delta', index: state.reasoning.index, text: reasoningText }
  }
  if (typeof delta.content === 'string' && delta.content.length > 0) {
    if (state.text === undefined) {
      state.text = { index: state.nextIndex++, text: '' }
      yield { type: 'block-start', index: state.text.index, blockType: 'text' }
    }
    state.text.text += delta.content
    yield { type: 'text-delta', index: state.text.index, text: delta.content }
  }
  if (Array.isArray(delta.tool_calls)) {
    // Reusing the previous frame's key is only meaningful when this frame carries
    // a single call: with several index-less calls in one frame, keying them all
    // by the same value would merge distinct calls into one block.
    const singleCall = delta.tool_calls.length === 1
    for (const [position, call] of delta.tool_calls.entries()) {
      // A continuation frame may omit `index`; keying it by position would split
      // one call into two blocks and emit two tool calls. Reuse the block the
      // previous frame opened instead.
      let wireIndex = `pos-${position}`
      if (Number.isSafeInteger(call.index)) wireIndex = String(call.index)
      else if (singleCall && state.lastToolKey !== undefined) wireIndex = state.lastToolKey
      state.lastToolKey = wireIndex
      let block = state.tools.get(wireIndex)
      if (block === undefined) {
        block = { index: state.nextIndex++, id: '', name: '', args: '', started: false }
        state.tools.set(wireIndex, block)
      }
      if (typeof call.id === 'string' && call.id.length > 0) block.id = call.id
      if (typeof call.function?.name === 'string' && call.function.name.length > 0) block.name = call.function.name
      const argumentsDelta = typeof call.function?.arguments === 'string' ? call.function.arguments : ''
      if (block.started !== true) {
        block.started = true
        yield { type: 'block-start', index: block.index, blockType: 'tool-call' }
      }
      block.args += argumentsDelta
      yield {
        type: 'tool-call-delta',
        index: block.index,
        id: block.id,
        ...(block.name.length > 0 ? { name: block.name } : {}),
        argumentsDelta,
      }
    }
  }
}

/**
 * Translate WorkBuddy SSE frames into harness stream chunks.
 * @param frames async iterable of `{frame}` / `{done:true}`.
 * @param params.model requested model id.
 * @param params.signal caller cancellation.
 * @returns chunks ending with `usage` (when reported) then exactly one `finish`.
 */
export async function* translateFrames(frames, { model, signal, onUsage }) {
  const state = { nextIndex: 0, text: undefined, reasoning: undefined, tools: new Map() }
  let sawDone = false
  let finishReason
  let usage
  for await (const item of frames) {
    if (signal?.aborted) throw new LlmError('llm-workbuddy: WorkBuddy request aborted', 'ABORTED')
    if (item.done === true) {
      sawDone = true
      break
    }
    const frame = item.frame
    if (typeof frame !== 'object' || frame === null) continue
    if (frame.error !== undefined && frame.error !== null) throw classifyStreamError(frame, { signal })
    // `usage: null` is a valid OpenAI-compatible frame (include_usage streams
    // send one before the real counts); accepting it would overwrite real usage
    // with null and report 0 credits for the turn.
    if (frame.usage !== undefined && frame.usage !== null) {
      usage = frame.usage
      // The raw usage carries WorkBuddy's `credit` spend; keep it for the
      // per-session accounting the footer pill shows.
      if (typeof onUsage === 'function') onUsage(usage)
    }
    const choices = Array.isArray(frame.choices) ? frame.choices : []
    for (const choice of choices) {
      if (choice === null || typeof choice !== 'object') continue
      const delta = typeof choice.delta === 'object' && choice.delta !== null ? choice.delta : choice.message
      if (typeof delta === 'object' && delta !== null) yield* applyDelta(delta, state)
      const mapped = mapFinishReason(choice.finish_reason)
      if (mapped !== undefined) finishReason = mapped
    }
  }
  if (signal?.aborted) throw new LlmError('llm-workbuddy: WorkBuddy request aborted', 'ABORTED')
  if (finishReason === undefined) {
    if (!sawDone) throw new LlmError('llm-workbuddy: WorkBuddy stream ended before any terminal frame', 'STREAM_CLOSED')
    finishReason = { kind: 'stop' }
  }
  // Close every open block with its assembled content, in stream order.
  const closers = []
  if (state.reasoning !== undefined) closers.push({ index: state.reasoning.index, block: { type: 'reasoning', text: state.reasoning.text } })
  for (const block of state.tools.values()) {
    if (block.started !== true) continue
    const args = block.args.length > 0 ? block.args : '{}'
    if (finishReason.kind !== 'max-tokens') {
      try {
        const parsed = JSON.parse(args)
        if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) throw new Error('tool arguments are not an object')
      } catch (error) {
        throw new LlmError(`llm-workbuddy: WorkBuddy returned malformed tool-call arguments: ${error.message}`, 'MALFORMED_RESPONSE', {
          cause: error,
        })
      }
    }
    closers.push({
      index: block.index,
      block: {
        type: 'tool-call',
        id: block.id.length > 0 ? block.id : `call-${block.index}`,
        name: block.name,
        arguments: args,
      },
    })
  }
  if (state.text !== undefined) closers.push({ index: state.text.index, block: { type: 'text', text: state.text.text } })
  closers.sort((left, right) => left.index - right.index)
  for (const closer of closers) yield { type: 'block-end', index: closer.index, block: closer.block }
  if (closers.length === 0 && finishReason.kind === 'stop') {
    throw new LlmError(`llm-workbuddy: model "${model}" returned a completed response with no content`, 'EMPTY_RESPONSE')
  }
  const mappedUsage = mapUsage(usage)
  if (mappedUsage !== undefined) yield { type: 'usage', usage: mappedUsage }
  yield { type: 'finish', reason: finishReason }
}

/** The harness adapter that owns the `workbuddy` route. */
export class WorkBuddyAdapter extends LlmAdapter {
  /**
   * @param {object} deps
   * @param {() => object} deps.options resolved plugin options reader.
   * @param {{catalog: (input?: object) => Promise<object[]>, selectAccount: Function, getAccessToken: Function, markUsed: Function, markSuccess: Function, markFailure: Function}} deps.pool account pool.
   * @param {object} deps.logger cordis logger.
   * @param {() => object | undefined} [deps.credentials] live credential store reader; the session spend keeps its durable copy there.
   * @param {() => object | undefined} [deps.resolveAttachments] mounted attachment store reader.
   * @param {(attachments: object, ref: object) => object | undefined} [deps.resolveImageAccess] read-only execution-world path resolver.
   */
  constructor({ options, pool, logger, credentials, resolveAttachments, resolveImageAccess }) {
    super()
    this.options = options
    this.pool = pool
    this.logger = logger
    this.dependencies = { resolveAttachments, resolveImageAccess }
    /**
     * Per-session credit spend. The durable copy lives in this plugin's own
     * settings record, so restarting DSH no longer zeroes the footer statistic.
     */
    this.credits = new SessionCredits({ credentials, logger, key: credentialKey(SETTINGS_SCOPE, USAGE_RECORD_ID) })
  }

  /**
   * Session id → account id the session is locked to. Held in memory, because a
   * lock only matters while this process can keep the prompt cache warm; a
   * conversation resumed after a restart re-binds from its durable spend record
   * (see `#rememberedAccount`), so it does not silently move to another account.
   * @type {Map<string, string>}
   */
  #sessionLocks = new Map()

  /**
   * Sessions whose lock was dropped in this process (the account failed, cooled
   * down or was removed). Re-binding is one-shot per conversation: once a lock
   * is released, the next request re-selects instead of resurrecting it.
   * @type {Set<string>}
   */
  #lockDismissed = new Set()

  /** Resolves once the restored session spend is available (the quota route awaits it). */
  ready() {
    return this.credits.ready
  }

  /** Write any pending session spend and wait for it (plugin teardown). */
  flushCredits() {
    return this.credits?.flush?.() ?? Promise.resolve()
  }

  /**
   * Drop the locks one removed account holds, so the conversations that used it
   * re-select on their next request. Switching the pinned account deliberately
   * does not come through here: a switch applies to conversations started
   * afterwards, and a conversation already under way keeps the account it
   * locked.
   */
  releaseSessionLocks(accountId) {
    if (typeof accountId !== 'string' || accountId.length === 0) return
    for (const [key, value] of this.#sessionLocks) {
      if (value !== accountId) continue
      this.#sessionLocks.delete(key)
      this.#rememberDismissed(key)
    }
  }

  /** The account one session is locked to (the footer pill's per-session read). */
  sessionLockOf(sessionId) {
    if (typeof sessionId !== 'string' || sessionId.length === 0) return undefined
    return this.#sessionLocks.get(sessionId)
  }

  /**
   * Remember the account that first served a session, keeping the map bounded
   * (200 sessions; the oldest is forgotten first). The first success wins: a
   * request that started before the lock existed may finish later on another
   * account, and that must not re-pin the session.
   */
  #lockSession(key, accountId) {
    if (this.#sessionLocks.has(key)) return
    this.#sessionLocks.set(key, accountId)
    this.#trimToLimit(this.#sessionLocks)
  }

  /** Keep one bounded map or set at its limit by dropping the oldest key. */
  #trimToLimit(collection) {
    while (collection.size > SESSION_LOCK_LIMIT) {
      const oldest = collection.keys().next()
      if (oldest.done === true) break
      collection.delete(oldest.value)
    }
  }

  /** Drop a session lock, but only while it still points at this account. */
  #releaseSessionLock(key, accountId) {
    if (key === undefined) return
    if (this.#sessionLocks.get(key) !== accountId) return
    this.#sessionLocks.delete(key)
    this.#rememberDismissed(key)
  }

  /** Record one released lock, bounded like the lock map itself. */
  #rememberDismissed(key) {
    this.#lockDismissed.add(key)
    this.#trimToLimit(this.#lockDismissed)
  }

  /**
   * The account a resumed conversation was last served by. The lock map does not
   * survive a restart, but the session spend record does, so the first request
   * after a restart can re-bind the conversation to the account that owns its
   * cache and its balance.
   */
  async #rememberedAccount(sessionId) {
    if (typeof sessionId !== 'string' || sessionId.length === 0) return undefined
    let usage
    try {
      usage = await this.credits.usage(sessionId)
    } catch (error) {
      this.logger?.warn?.(`llm-workbuddy: could not read the session record: ${error?.message ?? String(error)}`)
      return undefined
    }
    const accountId = usage === undefined ? undefined : usage.accountId
    return typeof accountId === 'string' && accountId.length > 0 ? accountId : undefined
  }

  /**
   * Resolve the image projection one route uses. The dimensions match the
   * `readImageRequest` target `#prepareImages` uses, so request pricing, budget
   * accounting, and serialization agree on the bytes actually sent.
   */
  imageRequestTarget(_provider, _model, image) {
    return imageTargetOf(this.options(), image)
  }

  /** The read-only execution-world path of one image, when the mounted fs maps it. */
  #imageAccess(ref) {
    const attachments = this.dependencies.resolveAttachments?.()
    if (attachments === undefined) return undefined
    return this.dependencies.resolveImageAccess?.(attachments, ref)
  }

  providerInfo(provider) {
    return { id: provider, name: 'WorkBuddy' }
  }

  providerRetryPolicy() {
    return this.options().retryPolicy
  }

  /** Accumulate one request's credit spend into its session bucket. */
  #recordSessionCredit(sessionId, { credit, accountId, model }) {
    // Fire-and-forget: the completion already streamed, so a bookkeeping failure
    // must not turn it into an error.
    this.credits
      .add(sessionId, { credit, accountId, model })
      .catch((error) => this.logger.warn(`llm-workbuddy: could not record the session spend: ${error?.message ?? String(error)}`))
  }

  /** One session's accumulated credit spend, for the quota route. */
  sessionUsage(sessionId) {
    return this.credits.usage(sessionId)
  }

  async listModels(provider) {
    const options = this.options()
    const catalog = await this.pool.catalog()
    return catalog.map((entry) => {
      // WorkBuddy bills per model, so the catalog price is the single biggest
      // lever a user has. The host renders `badge` right next to the model name
      // in the picker (tone colours it) and `description` in list surfaces, so
      // both carry the price: free campaigns green, active promotions blue, a
      // plain list price neutral.
      const badge = modelBadgeOf(entry)
      const description = [entry.priceLabel, entry.description]
        .filter((part) => typeof part === 'string' && part.length > 0)
        .join(' · ')
      return {
        provider,
        id: entry.id,
        name: entry.name,
        ...(description.length === 0 ? {} : { description }),
        ...(badge === undefined ? {} : { badge }),
        inputModalities: options.imageInput !== false && entry.supportsImages === true ? ['text', 'image'] : ['text'],
      }
    })
  }

  /** Resolve exact model capability facts from the advertised catalog. */
  #capabilityOf(options, model, catalog) {
    const entry = catalog.find((candidate) => candidate.id === model)
    const withEntry = { ...options, modelsById: new Map(entry === undefined ? [] : [[entry.id, entry]]) }
    const capability = resolveModelCapability(withEntry, model)
    return { ...capability, isDeepSeek: /^deepseek/iu.test(model), isGpt: /^gpt-/iu.test(model) }
  }

  /**
   * Read every retained image of one request at this route's target size.
   *
   * Text-only routes get `undefined` (their images are serialized as the
   * canonical placeholders), so the same request may fall back from a vision
   * model to a text-only one without rewriting history. A vision route that
   * exceeds the configured request image budget fails with the canonical
   * `IMAGE_OFFLOAD_REQUIRED` code instead of sending an unlogged projection;
   * `dsh-compaction-image-offload` marks the oldest occurrences and retries.
   *
   * @returns prepared versions and the history with offloaded images projected, or undefined.
   */
  async #prepareImages(callOptions, capability, signal) {
    const options = this.options()
    if (options.imageInput !== true || capability.inputModalities.includes('image') !== true) return undefined
    const messages = Array.isArray(callOptions.messages) ? callOptions.messages : []
    const refs = new Map()
    collectImageRefs(messages, refs)
    if (refs.size === 0) return undefined
    const attachments = this.dependencies.resolveAttachments?.()
    if (attachments === undefined) {
      throw new LlmError(
        `llm-workbuddy: model "${callOptions.model}" accepts images but no attachment store is mounted, so the attached image cannot be read`,
        'INVALID_REQUEST',
      )
    }
    const ordered = [...refs.values()]
    // Refuse an over-budget history before decoding it: reading 100 images only
    // to throw IMAGE_OFFLOAD_REQUIRED afterwards burns memory and time first.
    const overImageCount = ordered.length - options.maxRequestImages
    if (overImageCount > 0) throw imageOffloadError(overImageCount)
    let prepared
    try {
      prepared = await Promise.all(
        ordered.map((ref) => attachments.readImageRequest(ref, imageTargetOf(options, ref), signal)),
      )
    } catch (error) {
      throw new LlmError(`llm-workbuddy: cannot read an attached image: ${error?.message ?? String(error)}`, 'INVALID_REQUEST', {
        cause: error,
      })
    }
    const versions = new Map()
    for (const [index, ref] of ordered.entries()) {
      const version = prepared[index]
      if (version === undefined || version === null || !Number.isFinite(version.bytes)) {
        throw new LlmError(`llm-workbuddy: attached image ${ref.attachmentId} could not be prepared`, 'INVALID_REQUEST')
      }
      versions.set(ref.attachmentId, version)
    }
    const offloadImages = requiredImageOffload(
      messages,
      {
        representation: 'base64',
        maxBytes: options.maxRequestImageBytes,
        maxImages: options.maxRequestImages,
        countQuantum: options.imageOffloadCountQuantum,
      },
      (block) => versions.get(block.attachment.attachmentId)?.bytes ?? 0,
    )
    if (offloadImages > 0) throw imageOffloadError(offloadImages)
    return { versions, messages: projectOffloadedImages(messages, (ref) => offloadedImageText(ref, this.#imageAccess(ref))) }
  }

  /** Build the exact-model result the LLM runtime validates. */
  #modelInfo(provider, model, capability) {
    return {
      provider,
      id: model,
      name: capability.entry?.name ?? model,
      ...(capability.entry?.description === undefined ? {} : { description: capability.entry.description }),
      inputModalities: capability.inputModalities,
      context: { contextWindow: capability.contextWindow },
      defaultMaxTokens: capability.maxTokens,
      ...(capability.reasoning === undefined ? {} : { reasoning: capability.reasoning }),
    }
  }

  async resolveModel(provider, model, signal) {
    const options = this.options()
    const catalog = await this.pool.catalog({ signal })
    const capability = this.#capabilityOf(options, model, catalog)
    return this.#modelInfo(provider, model, capability)
  }

  async prepareCall(provider, model, signal) {
    const options = this.options()
    const catalog = await this.pool.catalog({ signal })
    const capability = this.#capabilityOf(options, model, catalog)
    return {
      model: this.#modelInfo(provider, model, capability),
      stream: (callOptions) => this.generate(callOptions, { options, capability }),
    }
  }

  stream(callOptions) {
    const options = this.options()
    // Resolve against the same catalog `prepareCall` and `listModels` advertise,
    // including cached live entries: a model that only the live catalog knows
    // would otherwise lose its image capability and its token limits here, and
    // attached images would be silently replaced with placeholder text.
    const capability = this.#capabilityOf(options, callOptions.model, this.pool.catalogSnapshot())
    return this.generate(callOptions, { options, capability })
  }

  /**
   * Serve one request with exactly the model the user selected.
   *
   * Accounts are tried until the pool is exhausted (credit-first order), unless
   * the session is locked to one account: a locked session stops at that
   * account's failure (`QUOTA` / `AUTH`) instead of walking the pool, so
   * `MODEL_UNAVAILABLE` describes the unlocked (`sessionAccountLock: off`) path
   * only.
   * The model itself is never swapped: when every account rejects it, the
   * request aborts with `MODEL_UNAVAILABLE` and a hint to pick another model.
   */
  async *generate(callOptions, snapshot) {
    const { options } = snapshot
    const images = await this.#prepareImages(callOptions, snapshot.capability, callOptions.signal)
    const outcome = yield* this.#attemptModel(callOptions, { options, capability: snapshot.capability, images })
    if (outcome.ok) return
    // No account was even reachable (all signed out or cooling down): keep the
    // pool-level message, it points at credentials rather than the model.
    if (outcome.attempted === 0) throw outcome.error
    // Anything that is not a pool-wide quota/rate-limit failure keeps its own
    // identity (channel checks, invalid requests, bad credentials, …).
    if (!MODEL_UNAVAILABLE_CODES.has(outcome.error.code)) throw outcome.error
    throw new LlmError(modelUnavailableMessage(callOptions.model, outcome.attempted, outcome.error), 'MODEL_UNAVAILABLE', {
      cause: outcome.error,
    })
  }

  /** One account per attempt for exactly one model; reports why it gave up. */
  async *#attemptModel(callOptions, { options, capability, images }) {
    const tried = new Set()
    const lockKey = options.sessionAccountLock === 'off' ? undefined : sessionLockKey(callOptions)
    let lockedId = lockKey === undefined ? undefined : this.#sessionLocks.get(lockKey)
    if (lockKey !== undefined && lockedId === undefined && this.#lockDismissed.has(lockKey) !== true) {
      const remembered = await this.#rememberedAccount(callOptions.sessionId)
      if (remembered !== undefined) {
        // Re-bind through the map rather than only locally: the release paths
        // must be able to drop this lock again if the account is unusable.
        this.#lockSession(lockKey, remembered)
        lockedId = remembered
      }
    }
    let lastError
    // Walk the whole pool for the requested model: `selectAccount` skips the
    // accounts already attempted and the ones cooling down for this model, and
    // returns undefined once the pool has nothing left to offer. There is no
    // fixed attempt cap — one request tries as many accounts as the pool
    // currently holds before the model fallback chain is considered.
    for (;;) {
      // A locked session asks the pool for that one account; an unlocked session
      // keeps the credit-first walk.
      let candidate
      if (lockedId === undefined) {
        // eslint-disable-next-line no-await-in-loop
        candidate = await this.pool.selectAccount({ model: callOptions.model, tried })
      } else {
        // eslint-disable-next-line no-await-in-loop
        const resolution = await this.pool.sessionAccount({ model: callOptions.model, accountId: lockedId })
        if (resolution.blocked !== undefined) {
          this.#releaseSessionLock(lockKey, lockedId)
          // `signed-out` means the account record is gone (removed, or its
          // credential vanished while the request was streaming). A lock must
          // never strand a conversation on it: drop it and re-select, instead of
          // failing the turn with an error the user cannot act on.
          if (resolution.blocked.reason === 'signed-out') {
            lockedId = undefined
            continue
          }
          throw sessionLockFailure(callOptions.model, lockedId, resolution.blocked)
        }
        candidate = resolution.account
      }
      if (candidate === undefined) break
      tried.add(candidate.id)
      let accessToken
      let account
      try {
        // eslint-disable-next-line no-await-in-loop
        ;({ accessToken, account } = await this.pool.getAccessToken(candidate.id))
      } catch (error) {
        lastError =
          error instanceof LlmError
            ? error
            : new LlmError(`llm-workbuddy: account "${candidate.id}" token resolution failed: ${error.message}`, 'AUTH', { cause: error })
        if (lockedId !== undefined) {
          // The locked account cannot even produce a token: stop the turn and
          // drop the lock, so the next request may re-select.
          this.#releaseSessionLock(lockKey, candidate.id)
          throw sessionLockFailure(callOptions.model, candidate.id, { code: lastError.code })
        }
        continue
      }
      this.pool.markUsed(candidate.id)
      let credit = 0
      const conversationIds = buildConversationIds(callOptions)
      const body = buildRequestBody({
        // Offloaded occurrences arrive as their canonical placeholder text rather
        // than as an image without a prepared version.
        callOptions: images === undefined ? callOptions : { ...callOptions, messages: images.messages },
        options,
        capability,
        account,
        conversationId: conversationIds.conversationId,
        images: images?.versions,
        imageAccess: (ref) => this.#imageAccess(ref),
      })
      let emitted = false
      try {
        const frames = streamChat({
          config: options,
          account,
          accessToken,
          body,
          id: conversationIds,
          signal: callOptions.signal,
        })
        for await (const chunk of translateFrames(frames, {
          model: callOptions.model,
          signal: callOptions.signal,
          onUsage: (raw) => {
            const value = Number(raw?.credit)
            if (Number.isFinite(value)) credit += value
          },
        })) {
          emitted = true
          yield chunk
        }
        this.pool.markSuccess(candidate.id)
        if (lockKey !== undefined) this.#lockSession(lockKey, candidate.id)
        this.#recordSessionCredit(callOptions.sessionId, { credit, accountId: candidate.id, model: callOptions.model })
        // Keep `most-credits` ranking close to reality between billing probes.
        this.pool.noteCreditSpend?.(candidate.id, credit)
        return { ok: true }
      } catch (error) {
        // Credits already consumed by a turn that ended in failure are still
        // spent upstream; record them before the failure path unwinds.
        if (credit > 0) {
          this.#recordSessionCredit(callOptions.sessionId, { credit, accountId: candidate.id, model: callOptions.model })
          this.pool.noteCreditSpend?.(candidate.id, credit)
        }
        if (callOptions.signal?.aborted) throw new LlmError('llm-workbuddy: WorkBuddy request aborted', 'ABORTED')
        const failure =
          error instanceof LlmError
            ? error
            : new LlmError(`llm-workbuddy: WorkBuddy request failed: ${error?.message ?? String(error)}`, 'SERVER', { cause: error })
        this.pool.markFailure(candidate.id, { model: callOptions.model, failure })
        // A failed account must not stay pinned to the session, output or not.
        this.#releaseSessionLock(lockKey, candidate.id)
        // Never switch accounts or models after content reached the caller.
        if (emitted) throw failure
        if (lockedId !== undefined) {
          // A locked session never moves to another account: report the stop, so
          // the next request may re-select.
          // eslint-disable-next-line no-await-in-loop
          const after = await this.pool.sessionAccount({ model: callOptions.model, accountId: candidate.id })
          throw sessionLockFailure(callOptions.model, candidate.id, { ...(after.blocked ?? {}), code: failure.code })
        }
        if (!RETRY_ON_OTHER_ACCOUNT.has(failure.code)) {
          return { ok: false, error: failure, attempted: tried.size }
        }
        lastError = failure
        this.logger.warn(
          `llm-workbuddy: account "${candidate.id}" failed with ${failure.code}; trying another account (${failure.message})`,
        )
      }
    }
    if (lastError !== undefined) return { ok: false, error: lastError, attempted: tried.size }
    const limits = await this.pool.modelLimits()
    const limitHint =
      limits.length > 0 ? ` Model limits in effect: ${limits.map((entry) => `${entry.model} until ${entry.until}`).join(', ')}.` : ''
    return {
      ok: false,
      attempted: tried.size,
      error: new LlmError(
        `llm-workbuddy: no WorkBuddy account is available right now — every account is signed out or cooling down. Run workbuddy_account action="list" to see each cooldown, sign in another account, or wait for it to reset.${limitHint}`,
        'RATE_LIMIT',
      ),
    }
  }
}
