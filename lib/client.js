/**
 * Client half of `dsh-workbuddy-switch`.
 *
 * Renders the **Settings → WorkBuddy** page (account pool, credits, daily
 * check-in) and the small credits pill under the composer. Everything is plain
 * `React.createElement` because the host loads this file as a lazy client
 * module: React comes from the host module table, no JSX transform, no imports.
 *
 * Layout follows the harness settings shell geometry (188px nav + 564px content
 * column), so the page stays one screen tall with any reasonable account count.
 *
 * @module dsh-workbuddy-switch/client
 */

window.__ModuleLoader__.load({
  id: 'dsh-workbuddy-switch',
  factory(require) {
    const React = require('react')
    const h = React.createElement

    const QUOTA_ROUTE = '/llm-workbuddy/quota'
    const API = {
      quota: '/llm-workbuddy/accounts/quota',
      pin: '/llm-workbuddy/accounts/pin',
      unpin: '/llm-workbuddy/accounts/unpin',
      checkin: '/llm-workbuddy/checkin',
      remove: '/llm-workbuddy/accounts/remove',
      loginStart: '/llm-workbuddy/login/start',
      loginStatus: '/llm-workbuddy/login/status',
    }
    const PILL_REFRESH_MS = 60000
    const PAGE_REFRESH_MS = 60000
    /** Balance thresholds that colour the credits column. */
    const LOW_BALANCE = 1000
    const MID_BALANCE = 2000

    /* ── stylesheet ─────────────────────────────────────────────── */

    const CSS_TAG = 'dsh-workbuddy-switch/settings.css'
    const CSS = `
.wb-page{display:flex;flex-direction:column;gap:12px}
.wb-toolbar{display:flex;align-items:center;height:56px;border:1px solid var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-md);background:var(--dsw-alias-bg-layer-1);box-shadow:0 1px 2px rgba(15,17,21,.05)}
.wb-stat{flex:none;display:flex;align-items:baseline;gap:6px;padding:0 14px;white-space:nowrap}
.wb-stat:first-child{padding-left:16px}
.wb-stat-label{font-size:11px;line-height:16px;color:var(--dsw-alias-label-secondary)}
.wb-stat-value{font-size:16px;font-weight:600;line-height:22px;font-variant-numeric:tabular-nums;color:var(--dsw-alias-label-primary)}
.wb-stat-value.is-ok{color:var(--dsw-alias-state-success-primary)}
.wb-spacer{flex:1;min-width:0}
.wb-toolbar-actions{flex:none;display:flex;align-items:center;gap:6px;padding:0 12px 0 14px}
.wb-btn{height:28px;padding:0 10px;border-radius:var(--dsw-radius-sm);border:1px solid var(--dsw-alias-border-l2);background:transparent;color:var(--dsw-alias-label-primary);font-family:inherit;font-size:13px;line-height:26px;display:inline-flex;align-items:center;gap:6px;cursor:pointer}
.wb-btn:hover{background:var(--dsw-alias-interactive-bg-hover)}
.wb-btn:focus-visible{outline:2px solid var(--dsw-alias-state-business-primary);outline-offset:1px}
.wb-btn.is-primary{background:var(--dsw-alias-brand-primary);border-color:var(--dsw-alias-brand-primary);color:var(--dsw-alias-bg-layer-1)}
.wb-btn.is-danger{color:var(--dsw-alias-state-error-primary);border-color:var(--dsw-alias-state-error-primary)}
.wb-btn:disabled{opacity:.45;cursor:not-allowed}
.wb-icon-btn{width:28px;height:28px;border-radius:var(--dsw-radius-sm);border:1px solid var(--dsw-alias-border-l2);background:transparent;color:var(--dsw-alias-label-primary);display:inline-flex;align-items:center;justify-content:center;cursor:pointer;padding:0}
.wb-icon-btn:hover{background:var(--dsw-alias-interactive-bg-hover)}
.wb-icon-btn:focus-visible{outline:2px solid var(--dsw-alias-state-business-primary);outline-offset:1px}
.wb-icon-btn:disabled{opacity:.45;cursor:not-allowed}
.wb-icon-btn.is-primary{background:var(--dsw-alias-brand-primary);border-color:var(--dsw-alias-brand-primary);color:var(--dsw-alias-bg-layer-1)}
.wb-icon-btn.is-primary:hover{background:var(--dsw-alias-brand-primary);opacity:.9}
.wb-table{border:1px solid var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-md);background:var(--dsw-alias-bg-layer-1);box-shadow:0 1px 2px rgba(15,17,21,.05);overflow:hidden}
.wb-row,.wb-thead{display:flex;align-items:center;gap:8px;padding:0 12px}
.wb-thead{height:32px;font-size:11px;color:var(--dsw-alias-label-secondary);border-bottom:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-2)}
.wb-row{height:52px}
.wb-row + .wb-row{border-top:1px solid var(--dsw-alias-border-l1)}
.wb-row:hover{background:var(--dsw-alias-interactive-bg-hover)}
.wb-row.is-current{background:var(--dsw-alias-interactive-bg-hover)}
.wb-dot{width:7px;height:7px;border-radius:50%;flex:none;background:var(--dsw-alias-state-success-primary)}
.wb-dot.is-warn{background:var(--dsw-alias-state-warn-primary)}
.wb-dot.is-error{background:var(--dsw-alias-state-error-primary)}
.wb-dot.is-idle{background:var(--dsw-alias-state-idle-primary)}
.wb-dot.is-hidden{visibility:hidden}
.wb-name{flex:1;min-width:0;display:flex;align-items:center;justify-content:center;gap:8px;overflow:hidden}
.wb-name-text{flex:0 1 auto;min-width:0;font-size:13px;font-weight:500;color:var(--dsw-alias-label-primary);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.wb-chip{flex:none;font-size:11px;line-height:1;padding:3px 6px;border-radius:6px;border:1px solid var(--dsw-alias-border-l2);color:var(--dsw-alias-label-secondary);white-space:nowrap}
.wb-chip.is-on{background:var(--dsw-alias-brand-primary);border-color:var(--dsw-alias-brand-primary);color:var(--dsw-alias-bg-layer-1);font-weight:500}
.wb-chip.is-warn{border-color:var(--dsw-alias-state-warn-primary);color:var(--dsw-alias-state-warn-primary)}
.wb-check{width:40px;flex:none;display:flex;justify-content:center;color:var(--dsw-alias-state-idle-primary)}
.wb-thead .wb-check{color:var(--dsw-alias-label-secondary)}
.wb-check.is-ok{color:var(--dsw-alias-state-success-primary)}
.wb-check.is-failed{color:var(--dsw-alias-state-error-primary)}
.wb-reset{width:92px;flex:none;text-align:center;font-size:11px;color:var(--dsw-alias-label-secondary);font-variant-numeric:tabular-nums;white-space:nowrap}
.wb-reset.is-urgent{color:var(--dsw-alias-state-warn-primary)}
.wb-amount{width:74px;flex:none;text-align:center;font-size:13px;font-weight:600;font-variant-numeric:tabular-nums;color:var(--dsw-alias-label-primary);white-space:nowrap}
.wb-amount.is-mid{color:var(--dsw-alias-state-warn-primary)}
.wb-amount.is-low{color:var(--dsw-alias-state-error-primary)}
.wb-trash{width:24px;height:24px;flex:none;border:0;background:none;color:var(--dsw-alias-label-secondary);border-radius:6px;display:inline-flex;align-items:center;justify-content:center;cursor:pointer;padding:0}
.wb-trash:hover{background:var(--dsw-alias-interactive-bg-active);color:var(--dsw-alias-state-error-primary)}
.wb-trash:focus-visible{outline:2px solid var(--dsw-alias-state-business-primary);outline-offset:1px}
.wb-trash:disabled{opacity:.45;cursor:not-allowed}
.wb-act{width:88px;flex:none;display:flex;align-items:center;justify-content:center}
.wb-use{height:22px;flex:none;padding:0 7px;border-radius:6px;border:1px solid var(--dsw-alias-border-l2);background:transparent;color:var(--dsw-alias-label-primary);font:inherit;font-size:11px;line-height:20px;white-space:nowrap;cursor:pointer;opacity:0;pointer-events:none;transition:opacity .12s}
/* opacity keeps the button in the tab order, so :focus-within can reveal it. */
.wb-row:hover .wb-use,.wb-row:focus-within .wb-use{opacity:1;pointer-events:auto}
.wb-row:hover .wb-use:disabled,.wb-row:focus-within .wb-use:disabled{opacity:.45}
.wb-use:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover)}
.wb-use:focus-visible{outline:2px solid var(--dsw-alias-state-business-primary);outline-offset:1px}
.wb-use:disabled{cursor:not-allowed}
@media (hover: none){.wb-row .wb-use{opacity:1;pointer-events:auto}}
.wb-act-live{display:flex;align-items:center;justify-content:center}
.wb-cancel{display:none;height:22px;padding:0 7px;border-radius:6px;border:1px solid var(--dsw-alias-border-l2);background:transparent;color:var(--dsw-alias-label-secondary);font:inherit;font-size:11px;line-height:20px;white-space:nowrap;cursor:pointer;align-items:center}
.wb-cancel:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}
.wb-cancel:focus-visible{outline:2px solid var(--dsw-alias-state-business-primary);outline-offset:1px}
.wb-cancel:disabled{opacity:.45;cursor:not-allowed}
/* The word and its undo share one cell: hovering trades the label for the
   button, so the column never grows and the row keeps its height. */
.wb-row:hover .wb-cancel,.wb-row:focus-within .wb-cancel{display:inline-flex}
.wb-row:hover .wb-act-live.has-action .wb-chip,.wb-row:focus-within .wb-act-live.has-action .wb-chip{display:none}
@media (hover: none){.wb-act-live.has-action .wb-cancel{display:inline-flex}.wb-act-live.has-action .wb-chip{display:none}}
.wb-banner{font-size:12px;line-height:18px;border-radius:8px;padding:8px 10px;border:1px solid var(--dsw-alias-border-l2)}
.wb-banner.is-error{color:var(--dsw-alias-state-error-primary);border-color:var(--dsw-alias-state-error-primary)}
.wb-banner.is-ok{color:var(--dsw-alias-label-primary)}
.wb-empty{border:1px dashed var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-md);padding:28px 20px;display:flex;flex-direction:column;align-items:center;gap:10px;text-align:center;color:var(--dsw-alias-label-secondary);font-size:13px}
.wb-empty-title{font-size:14px;color:var(--dsw-alias-label-primary)}
.wb-skeleton{border:1px solid var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-md);overflow:hidden}
.wb-skeleton span{display:block;height:52px;background:var(--dsw-alias-bg-layer-1)}
.wb-skeleton span + span{border-top:1px solid var(--dsw-alias-border-l1)}
.wb-overlay{position:fixed;inset:0;z-index:60;display:grid;place-items:center;background:rgba(0,0,0,.45)}
.wb-dialog{width:440px;max-width:calc(100vw - 32px);background:var(--dsw-alias-bg-layer-1);border:1px solid var(--dsw-alias-border-l2);border-radius:16px;padding:20px;display:flex;flex-direction:column;gap:12px;box-shadow:0 24px 60px rgba(0,0,0,.28)}
.wb-dialog-title{font-size:16px;font-weight:600;color:var(--dsw-alias-label-primary)}
.wb-dialog-text{font-size:12px;line-height:1.6;color:var(--dsw-alias-label-secondary)}
.wb-dialog-actions{display:flex;justify-content:flex-end;gap:8px}
.wb-auth-input{width:100%;box-sizing:border-box;font-size:11px;padding:8px 10px;border-radius:8px;border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary)}
.wb-pill{display:flex;align-items:center;gap:4px;margin-right:8px;font-size:12px;line-height:1;opacity:.72;white-space:nowrap;font-variant-numeric:tabular-nums;user-select:none}
.wb-pill-dot{width:6px;height:6px;border-radius:50%;background:currentColor;opacity:.55}
@media (max-width: 640px){.wb-reset{width:76px}.wb-amount{width:64px}}
`

    function ensureStylesheet() {
      if (typeof document === 'undefined') return
      if (document.querySelector('style[data-plugin-css="' + CSS_TAG + '"]') !== null) return
      const tag = document.createElement('style')
      tag.dataset.plugin = 'dsh-workbuddy-switch'
      tag.dataset.pluginCss = CSS_TAG
      tag.textContent = CSS
      document.head.appendChild(tag)
    }

    /* ── helpers ────────────────────────────────────────────────── */

    function isZh() {
      return /^zh/iu.test(document.documentElement.lang || '')
    }

    function t(zh, en) {
      return isZh() ? zh : en
    }

    /** Fixed-width credits: thousands separators, rounded to whole credits. */
    function formatCredits(value) {
      if (typeof value !== 'number' || Number.isFinite(value) !== true) return '—'
      return Math.round(value).toLocaleString('en-US')
    }

    /** Session spend keeps two decimals. */
    function formatSpend(value) {
      if (typeof value !== 'number' || Number.isFinite(value) !== true) return '—'
      return String(Math.round(value * 100) / 100)
    }

    function pad(value) {
      return String(value).padStart(2, '0')
    }

    function clockOf(date) {
      return pad(date.getHours()) + ':' + pad(date.getMinutes())
    }

    function monthDayOf(date) {
      return pad(date.getMonth() + 1) + '-' + pad(date.getDate())
    }

    function startOfDay(date) {
      const copy = new Date(date.getTime())
      copy.setHours(0, 0, 0, 0)
      return copy.getTime()
    }

    /**
     * Reset time in the table: today/tomorrow read as words and flag as urgent;
     * anything further out stays on the compact MM-DD HH:mm form.
     */
    function resetLabel(iso) {
      if (typeof iso !== 'string' || iso.length === 0) return { text: '—', urgent: false }
      const date = new Date(iso)
      if (Number.isNaN(date.getTime())) return { text: '—', urgent: false }
      const days = Math.round((startOfDay(date) - startOfDay(new Date())) / 86400000)
      const urgent = date.getTime() - Date.now() <= 24 * 3600 * 1000
      if (days === 0) return { text: t('今日 ', 'today ') + clockOf(date), urgent }
      if (days === 1) return { text: t('明日 ', 'tomorrow ') + clockOf(date), urgent }
      return { text: monthDayOf(date) + ' ' + clockOf(date), urgent }
    }

    function shortTime(iso) {
      if (typeof iso !== 'string' || iso.length === 0) return undefined
      const date = new Date(iso)
      if (Number.isNaN(date.getTime())) return undefined
      return clockOf(date)
    }


    function usable(account) {
      const quota = account === null || account === undefined ? undefined : account.quota
      return quota !== undefined && quota.supported !== false && Number.isFinite(quota.remaining)
    }

    function balanceTone(account) {
      if (usable(account) !== true) return ''
      if (account.quota.remaining < LOW_BALANCE) return 'is-low'
      if (account.quota.remaining < MID_BALANCE) return 'is-mid'
      return ''
    }

    function accountName(account) {
      const nickname = typeof account.nickname === 'string' ? account.nickname.trim() : ''
      return nickname.length > 0 ? nickname : account.id
    }

    function statusTone(account) {
      if (account.cooling === true) return 'is-warn'
      if (account.error !== undefined) return 'is-error'
      if (account.quota !== undefined && account.quota.supported === false) return 'is-idle'
      return ''
    }

    async function api(path, options) {
      const response = await fetch(path, {
        ...options,
        headers: {
          accept: 'application/json',
          ...(options !== undefined && options.body !== undefined ? { 'content-type': 'application/json' } : {}),
        },
      })
      const parsed = await response.json().catch(() => undefined)
      // A route may answer HTML (a proxy error page) or a non-object body; neither
      // may reach the UI as [object Object] or crash a `.map` downstream.
      const data = typeof parsed === 'object' && parsed !== null ? parsed : {}
      if (response.ok !== true) {
        const detail = typeof data.error === 'string' && data.error.length > 0 ? data.error : 'HTTP ' + response.status
        throw new Error(detail)
      }
      return data
    }

    /**
     * One URL worth opening in a new tab, or undefined.
     *
     * `authUrl` is upstream text; only an http(s) URL may be handed to
     * `window.open`, so a `javascript:` or `file:` value cannot run here.
     */
    function safeExternalUrl(value) {
      if (typeof value !== 'string' || value.length === 0) return undefined
      try {
        const url = new URL(value)
        return url.protocol === 'https:' || url.protocol === 'http:' ? url.href : undefined
      } catch {
        return undefined
      }
    }

    /* ── icons (16px, 1.5px stroke, currentColor) ───────────────── */

    function svg(children, size) {
      return h(
        'svg',
        {
          width: size === undefined ? 16 : size,
          height: size === undefined ? 16 : size,
          viewBox: '0 0 16 16',
          fill: 'none',
          stroke: 'currentColor',
          strokeWidth: 1.5,
          strokeLinecap: 'round',
          strokeLinejoin: 'round',
          'aria-hidden': true,
        },
        children,
      )
    }

    function IconRefresh() {
      return svg([h('path', { key: 'a', d: 'M13.2 6.6A5.4 5.4 0 1 0 13.4 9' }), h('path', { key: 'b', d: 'M13.4 2.9v3.9H9.5' })])
    }

    function IconCheckin() {
      return svg([
        h('rect', { key: 'a', x: 2.5, y: 3.5, width: 11, height: 10, rx: 2 }),
        h('path', { key: 'b', d: 'M2.5 6.5h11M5.5 2.5v2M10.5 2.5v2' }),
        h('path', { key: 'c', d: 'M6 9.4l1.5 1.5 2.6-2.8' }),
      ])
    }

    function IconCheck() {
      return svg(h('path', { d: 'M3.6 8.4l2.9 2.9 5.9-6.6' }))
    }

    function IconPlus() {
      return svg(h('path', { d: 'M8 3.5v9M3.5 8h9' }))
    }

    function IconTrash() {
      return svg([
        h('path', { key: 'a', d: 'M3 4.5h10' }),
        h('path', { key: 'b', d: 'M6.5 4.5V3.2h3v1.3' }),
        h('path', { key: 'c', d: 'M4.6 4.5l.6 7.8a1.2 1.2 0 0 0 1.2 1.1h3.2a1.2 1.2 0 0 0 1.2-1.1l.6-7.8' }),
      ])
    }

    function IconAlert() {
      return svg([h('path', { key: 'a', d: 'M8 3.2v5.6' }), h('path', { key: 'b', d: 'M8 11.6v.4' })])
    }

    function IconDash() {
      return svg(h('path', { d: 'M4 8h8' }))
    }

    /* ── data hook ──────────────────────────────────────────────── */

    function useAccounts(sessionId) {
      const [state, setState] = React.useState({ data: null, loading: true, error: null, busy: false })
      const load = React.useCallback(
        async (force) => {
          try {
            const data =
              force === true
                ? await api(API.quota, { method: 'POST', body: '{}' })
                : await api(QUOTA_ROUTE + (sessionId === undefined ? '' : '?session=' + encodeURIComponent(sessionId)))
            setState((previous) => ({ ...previous, data, loading: false, error: null }))
          } catch (error) {
            setState((previous) => ({ ...previous, loading: false, error: error.message }))
          }
        },
        [sessionId],
      )
      React.useEffect(() => {
        let cancelled = false
        const run = () => {
          if (cancelled !== true) load(false)
        }
        run()
        const timer = setInterval(run, PAGE_REFRESH_MS)
        return () => {
          cancelled = true
          clearInterval(timer)
        }
      }, [load])
      const run = React.useCallback(
        async (action) => {
          setState((previous) => ({ ...previous, busy: true, error: null }))
          try {
            const data = await action()
            if (data !== undefined) setState((previous) => ({ ...previous, data, busy: false }))
            else {
              await load(false)
              setState((previous) => ({ ...previous, busy: false }))
            }
            return true
          } catch (error) {
            setState((previous) => ({ ...previous, busy: false, error: error.message }))
            return false
          }
        },
        [load],
      )
      return { ...state, run }
    }

    function sessionIdOf(props) {
      if (props !== undefined && props !== null && typeof props.sessionId === 'string' && props.sessionId.length > 0) return props.sessionId
      const match = /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/iu.exec(window.location.href)
      return match === null ? undefined : match[1]
    }

    /* ── dialogs ────────────────────────────────────────────────── */

    function Dialog({ title, description, children, actions, onClose }) {
      const ref = React.useRef(null)
      React.useEffect(() => {
        const onKey = (event) => {
          if (event.key === 'Escape') onClose()
        }
        document.addEventListener('keydown', onKey)
        const previous = document.activeElement
        if (ref.current !== null) {
          const focusable = ref.current.querySelector('button, input, [tabindex]')
          if (focusable !== null) focusable.focus()
        }
        return () => {
          document.removeEventListener('keydown', onKey)
          if (previous !== null && typeof previous.focus === 'function') previous.focus()
        }
      }, [onClose])
      return h(
        'div',
        {
          className: 'wb-overlay',
          onMouseDown: (event) => {
            if (event.target === event.currentTarget) onClose()
          },
        },
        h(
          'div',
          { className: 'wb-dialog', role: 'dialog', 'aria-modal': 'true', ref },
          h('div', { className: 'wb-dialog-title' }, title),
          description === undefined ? null : h('div', { className: 'wb-dialog-text' }, description),
          children,
          actions === undefined ? null : h('div', { className: 'wb-dialog-actions' }, actions),
        ),
      )
    }

    function LoginDialog({ onClose, onDone }) {
      const [phase, setPhase] = React.useState('starting')
      const [auth, setAuth] = React.useState(null)
      const [error, setError] = React.useState(null)
      // The parent passes a fresh arrow on every render; reading it through a ref
      // keeps the poll effect below from restarting (and resetting its window) on
      // every unrelated re-render.
      const onDoneRef = React.useRef(onDone)
      React.useEffect(() => {
        onDoneRef.current = onDone
      }, [onDone])
      /** Pending "copied" reset, cleared on unmount so it cannot set state late. */
      const copiedTimer = React.useRef(undefined)
      React.useEffect(
        () => () => {
          if (copiedTimer.current !== undefined) clearTimeout(copiedTimer.current)
        },
        [],
      )
      const [copied, setCopied] = React.useState(false)
      const stateRef = React.useRef(undefined)

      React.useEffect(() => {
        let cancelled = false
        api(API.loginStart, { method: 'POST', body: '{}' })
          .then((started) => {
            if (cancelled === true) return
            stateRef.current = started.state
            setAuth(started)
            setPhase('waiting')
          })
          .catch((failure) => {
            if (cancelled === true) return
            setError(failure.message)
            setPhase('failed')
          })
        return () => {
          cancelled = true
        }
      }, [])

      React.useEffect(() => {
        if (phase !== 'waiting') return undefined
        // The authorization link lives 15 minutes; poll until then and then stop
        // with a reason, instead of leaving the dialog spinning forever. One probe
        // at a time: a slow answer used to overlap with the next tick and handle
        // `connected` twice.
        const deadline = Date.now() + 15 * 60 * 1000
        let busy = false
        let failures = 0
        let stopped = false
        const timer = setInterval(async () => {
          if (busy || stopped) return
          if (Date.now() >= deadline) {
            stopped = true
            clearInterval(timer)
            setPhase('failed')
            return
          }
          const state = stateRef.current
          if (state === undefined) return
          busy = true
          try {
            const result = await api(API.loginStatus + '?state=' + encodeURIComponent(state))
            if (result.status === 'connected') {
              stopped = true
              clearInterval(timer)
              setPhase('connected')
              onDoneRef.current(result.nickname === undefined ? '' : result.nickname)
            }
            failures = 0
          } catch {
            // A transient probe failure is not terminal: keep polling, but give up
            // after a run of failures rather than pretending the dialog is alive.
            failures += 1
            if (failures >= 15) {
              stopped = true
              clearInterval(timer)
              setPhase('failed')
            }
          } finally {
            busy = false
          }
        }, 2000)
        return () => {
          stopped = true
          clearInterval(timer)
        }
      }, [phase])

      const copy = async () => {
        try {
          await navigator.clipboard.writeText(auth.authUrl)
          setCopied(true)
          if (copiedTimer.current !== undefined) clearTimeout(copiedTimer.current)
          copiedTimer.current = setTimeout(() => {
            copiedTimer.current = undefined
            setCopied(false)
          }, 1500)
        } catch {
          // Clipboard may be blocked; the link stays selectable.
        }
      }

      return h(
        Dialog,
        {
          title: t('添加 WorkBuddy 账号', 'Add a WorkBuddy account'),
          description: t(
            '在浏览器打开下面的授权链接并登录，授权完成后本窗口会自动关闭。链接 15 分钟内有效。',
            'Open the link below and sign in. This dialog closes automatically once the account is authorized. The link expires in 15 minutes.',
          ),
          onClose,
          actions: h('button', { className: 'wb-btn', type: 'button', onClick: onClose }, t('取消', 'cancel')),
        },
        phase === 'starting'
          ? h('div', { className: 'wb-dialog-text' }, t('正在创建授权链接…', 'Creating the authorization link…'))
          : null,
        auth === null
          ? null
          : h(
              'div',
              { style: { display: 'flex', flexDirection: 'column', gap: 8 } },
              h('input', { className: 'wb-auth-input', readOnly: true, value: auth.authUrl, onFocus: (event) => event.target.select() }),
              h(
                'div',
                { style: { display: 'flex', gap: 8, alignItems: 'center' } },
                h('button', { className: 'wb-btn is-primary', type: 'button', onClick: copy }, copied === true ? t('已复制', 'copied') : t('复制链接', 'copy link')),
                h(
                  'button',
                  {
                    className: 'wb-btn',
                    type: 'button',
                    onClick: () => {
                      const target = safeExternalUrl(auth.authUrl)
                      if (target !== undefined) window.open(target, '_blank', 'noopener')
                    },
                  },
                  t('打开授权页', 'open'),
                ),
                h(
                  'span',
                  { className: 'wb-dialog-text', style: { marginLeft: 'auto' } },
                  phase === 'connected'
                    ? t('已连接', 'connected')
                    : phase === 'failed'
                      ? t('授权链接已失效，请关闭后重试', 'the link expired — close and try again')
                      : t('等待授权…', 'waiting for authorization…'),
                ),
              ),
            ),
        error === null ? null : h('div', { className: 'wb-banner is-error' }, error),
      )
    }

    function ConfirmDialog({ title, description, confirmLabel, onCancel, onConfirm }) {
      return h(
        Dialog,
        {
          title,
          description,
          onClose: onCancel,
          actions: [
            h('button', { key: 'cancel', className: 'wb-btn', type: 'button', onClick: onCancel }, t('取消', 'cancel')),
            h('button', { key: 'ok', className: 'wb-btn is-danger', type: 'button', onClick: onConfirm }, confirmLabel),
          ],
        },
      )
    }

    /* ── account table ──────────────────────────────────────────── */

    function checkinViewFor(checkin, id) {
      if (checkin === undefined || Array.isArray(checkin.accounts) !== true) return undefined
      return checkin.accounts.find((view) => view.accountId === id)
    }

    function checkinCell(view) {
      if (view === undefined) return { node: h(IconDash), tone: '', title: t('未签到', 'not signed in yet') }
      const at = shortTime(view.at)
      const detail = []
      if (at !== undefined) detail.push(t('今日 ', 'today ') + at + t(' 签到', ''))
      if (Number.isFinite(view.credit)) detail.push('+' + formatCredits(view.credit) + t(' 分', ' credits'))
      if (Number.isFinite(view.streakDays)) detail.push(t('连登 ', 'streak ') + view.streakDays + t(' 天', ' days'))
      if (view.status === 'ok' || view.status === 'already') {
        return { node: h(IconCheck), tone: 'is-ok', title: detail.length === 0 ? t('今日已签到', 'signed in today') : detail.join(' · ') }
      }
      if (view.status === 'failed') {
        return { node: h(IconAlert), tone: 'is-failed', title: (view.error === undefined ? t('签到失败', 'check-in failed') : view.error) + (view.attempts === undefined ? '' : ` (attempt ${view.attempts})`) }
      }
      if (view.status === 'unsupported') {
        return { node: h(IconDash), tone: '', title: view.reason === undefined ? t('无需签到', 'not applicable') : view.reason }
      }
      return { node: h(IconDash), tone: '', title: t('未签到', 'not signed in yet') }
    }

    /**
     * One account. `role` is the single word this row carries about "which
     * account": `current` (the pin), `auto` (no pin — the pool's own pick),
     * `previous` (the pin this one replaced), or nothing.
     */
    function AccountRow({ account, checkin, role, pinned, canRelease, busy, onRemove, onUse, onRelease }) {
      const tone = statusTone(account)
      const reset = resetLabel(account.quota === undefined ? undefined : account.quota.resetAt)
      const cell = checkinCell(checkin)
      // The account a new conversation would reach right now.
      const live = role === 'current' || role === 'auto'
      // Hovering is how a person changes the answer, so only rows where the
      // click would change something carry a switch. A pinned row has nothing
      // to offer, and pinning a cooling account would land straight back on
      // "pinned but unavailable" — but the pool's own pick stays clickable,
      // which is how a working pin gets pinned when the current one is stuck.
      const canSwitch = role !== 'current' && pinned !== true && account.cooling !== true
      // The column carries one answer: the word for the row that holds the
      // choice, or the switch for a row that could take it. Both live rows trade
      // that word for a button while hovered, so the action lives where the
      // state is rather than in a footer: the pinned row offers "clear", the
      // automatic one offers "switch" (pinning the account the pool already
      // picked).
      const switchButton = h(
        'button',
        {
          className: 'wb-use',
          type: 'button',
          disabled: busy,
          title: t('新建会话将使用此账号，已开始的会话保持原账号', 'New conversations will use this account. Conversations already under way keep theirs.'),
          'aria-label': t('切换新会话账号到 ', 'switch new conversations to ') + accountName(account),
          onClick: onUse,
        },
        t('切换', 'switch'),
      )
      let answer = null
      if (role === 'current') {
        answer = h(
          'span',
          { className: 'wb-act-live' + (canRelease === true ? ' has-action' : '') },
          h('span', { className: 'wb-chip is-on' }, t('当前', 'current')),
          canRelease === true
            ? h(
                'button',
                {
                  className: 'wb-cancel',
                  type: 'button',
                  disabled: busy,
                  title: t('取消固定后，新建会话由账号池按积分挑选', 'The pool picks by credit balance again.'),
                  'aria-label': t('取消当前使用账号的固定', 'clear the account pin'),
                  onClick: onRelease,
                },
                t('取消', 'clear'),
              )
            : null,
        )
      } else if (role === 'auto') {
        answer = h(
          'span',
          { className: 'wb-act-live' + (canSwitch === true ? ' has-action' : '') },
          h('span', { className: 'wb-chip is-on' }, t('当前（自动）', 'current (auto)')),
          canSwitch === true ? switchButton : null,
        )
      } else if (canSwitch === true) {
        answer = switchButton
      }
      return h(
        'div',
        { className: 'wb-row' + (live ? ' is-current' : '') },
        h('span', { className: 'wb-dot ' + tone }),
        h(
          'span',
          { className: 'wb-name' },
          h('span', { className: 'wb-name-text' }, accountName(account)),
          pinned === true && !live ? h('span', { className: 'wb-chip' }, t('已固定', 'pinned')) : null,
          role === 'previous' ? h('span', { className: 'wb-chip' }, t('最近', 'last')) : null,
          account.cooling === true ? h('span', { className: 'wb-chip is-warn' }, t('冷却中', 'cooling')) : null,
        ),
        h('span', { className: 'wb-check ' + cell.tone, title: cell.title }, cell.node),
        h('span', { className: 'wb-reset' + (reset.urgent ? ' is-urgent' : '') }, reset.text),
        h('span', { className: 'wb-amount ' + balanceTone(account), title: account.error }, usable(account) ? formatCredits(account.quota.remaining) : '—'),
        h('span', { className: 'wb-act' }, answer),
        h(
          'button',
          {
            className: 'wb-trash',
            type: 'button',
            disabled: busy,
            title: t('删除账号', 'remove account'),
            'aria-label': t('删除账号 ', 'remove account ') + accountName(account),
            onClick: onRemove,
          },
          h(IconTrash),
        ),
      )
    }

    /* ── settings page ──────────────────────────────────────────── */

    function WorkBuddyPage(props) {
      const sessionId = sessionIdOf(props)
      const { data, loading, error, busy, run } = useAccounts(sessionId)
      const [loginOpen, setLoginOpen] = React.useState(false)
      const [confirming, setConfirming] = React.useState(null)
      const [notice, setNotice] = React.useState(null)
      /** Pending notice clear, cancelled on unmount. */
      const noticeTimer = React.useRef(undefined)
      React.useEffect(
        () => () => {
          if (noticeTimer.current !== undefined) clearTimeout(noticeTimer.current)
        },
        [],
      )

      const flash = (text) => {
        setNotice(text)
        if (noticeTimer.current !== undefined) clearTimeout(noticeTimer.current)
        noticeTimer.current = setTimeout(() => {
          noticeTimer.current = undefined
          setNotice(null)
        }, 2600)
      }

      const accounts = data === null || Array.isArray(data.accounts) !== true ? [] : data.accounts
      const checkin = data === null ? undefined : data.checkin
      // Three answers to "which account": the pin (policy for conversations
      // started from now on), the pin it replaced, and who the pool would pick
      // instead. Each row carries at most one of those words.
      const pinnedId = data === null || typeof data.pinnedAccountId !== 'string' || data.pinnedAccountId.length === 0 ? undefined : data.pinnedAccountId
      const previousId = data === null || typeof data.previousAccountId !== 'string' || data.previousAccountId.length === 0 ? undefined : data.previousAccountId
      const autoId = data === null || typeof data.autoAccountId !== 'string' || data.autoAccountId.length === 0 ? undefined : data.autoAccountId
      const pinnedRow = pinnedId === undefined ? undefined : accounts.find((account) => account.id === pinnedId)
      const pinnedAvailable = pinnedRow !== undefined && pinnedRow.cooling !== true
      // A pin that cannot serve leaves the pool's pick marked, so the row saying
      // "current" is always one a new conversation can reach.
      const currentId = pinnedAvailable === true ? pinnedId : autoId
      const roleOf = (account) => {
        if (account.id === currentId) return pinnedAvailable === true ? 'current' : 'auto'
        if (previousId !== undefined && account.id === previousId) return 'previous'
        return undefined
      }
      const known = accounts.filter(usable)
      const totalRemaining = known.reduce((sum, account) => sum + account.quota.remaining, 0)
      const sorted = accounts.slice().sort((left, right) => {
        const leftValue = usable(left) ? left.quota.remaining : -1
        const rightValue = usable(right) ? right.quota.remaining : -1
        if (leftValue !== rightValue) return rightValue - leftValue
        return accountName(left).localeCompare(accountName(right), 'zh-Hans-CN')
      })

      const onRefreshAll = () =>
        run(async () => {
          const next = await api(API.quota, { method: 'POST', body: '{}' })
          flash(t('额度已刷新', 'credits refreshed'))
          return next
        })
      const onCheckin = () =>
        run(async () => {
          const next = await api(API.checkin, { method: 'POST', body: '{}' })
          const summary = next.checkin
          flash(
            summary === undefined
              ? t('签到已完成', 'check-in finished')
              : t('今日已签到 ' + summary.signed + '/' + summary.total + ' 个账号', summary.signed + '/' + summary.total + ' signed in'),
          )
          return next
        })
      const onRemove = (account) => setConfirming(account)
      const confirmRemove = () => {
        const account = confirming
        setConfirming(null)
        if (account === null) return
        run(async () => {
          const next = await api(API.remove, { method: 'POST', body: JSON.stringify({ accountId: account.id }) })
          flash(t('账号已删除', 'account removed'))
          return next
        })
      }
      const onPick = (accountId) => {
        const target = accountId.length === 0 ? undefined : accounts.find((account) => account.id === accountId)
        // A stale option: the account was removed while the menu sat open.
        if (accountId.length > 0 && target === undefined) {
          flash(t('该账号已不在列表，正在刷新', 'that account is gone — refreshing the list'))
          return run(() => undefined)
        }
        // '' is the automatic choice, the same id the picker reports for index 0.
        const targetId = target === undefined ? '' : target.id
        if (targetId === (pinnedId === undefined ? '' : pinnedId)) return
        const clearing = targetId.length === 0
        run(async () => {
          const next = clearing
            ? await api(API.unpin, { method: 'POST', body: '{}' })
            : await api(API.pin, { method: 'POST', body: JSON.stringify({ accountId: targetId }) })
          flash(
            clearing
              ? t('已回到自动挑选 · 新建会话按积分挑号', 'automatic selection — new conversations pick by credits')
              : t('已切换到 ', 'switched to ') +
                  accountName(target) +
                  t(' · 新建会话生效，已开始的会话保持原账号', ' — applies to new conversations; ones already started keep their account'),
          )
          return next
        })
      }

      const toolbar = h(
        'section',
        { className: 'wb-toolbar' },
        h('div', { className: 'wb-stat' }, h('span', { className: 'wb-stat-label' }, t('账号总数', 'accounts')), h('span', { className: 'wb-stat-value' }, String(accounts.length))),
        h('div', { className: 'wb-stat' }, h('span', { className: 'wb-stat-label' }, t('积分总计', 'credits')), h('span', { className: 'wb-stat-value' }, formatCredits(totalRemaining))),
        h(
          'div',
          { className: 'wb-stat' },
          h('span', { className: 'wb-stat-label' }, t('今日签到', 'check-ins')),
          h(
            'span',
            { className: 'wb-stat-value' + (checkin !== undefined && checkin.failed === 0 && checkin.pending === 0 ? ' is-ok' : '') },
            checkin === undefined ? '—' : String(checkin.signed) + '/' + String(checkin.total),
          ),
        ),
        h('span', { className: 'wb-spacer' }),
        h(
          'div',
          { className: 'wb-toolbar-actions' },
          h(
            'button',
            {
              className: 'wb-icon-btn',
              type: 'button',
              disabled: busy,
              title: t('刷新全部账号积分', 'refresh every account'),
              onClick: onRefreshAll,
            },
            h(IconRefresh),
          ),
          h(
            'button',
            {
              className: 'wb-icon-btn',
              type: 'button',
              disabled: busy || accounts.length === 0,
              title: checkin !== undefined && checkin.auto !== undefined && checkin.auto.enabled === true
                ? t('立即签到（每日 ' + String(checkin.auto.hour).padStart(2, '0') + ':00 后自动执行）', 'check in now (runs daily after ' + String(checkin.auto.hour).padStart(2, '0') + ':00)')
                : t('立即签到', 'check in now'),
              onClick: onCheckin,
            },
            h(IconCheckin),
          ),
          h(
            'button',
            {
              className: 'wb-icon-btn is-primary',
              type: 'button',
              title: t('添加账号', 'add account'),
              'aria-label': t('添加账号', 'add account'),
              onClick: () => setLoginOpen(true),
            },
            h(IconPlus),
          ),
        ),
      )

      // loading is only ever true before the first payload lands, so it already
      // covers the cold start on its own.
      function renderBody() {
        if (loading === true) {
          return h('div', { className: 'wb-skeleton' }, [0, 1, 2, 3].map((index) => h('span', { key: 'skeleton-' + index })))
        }
        if (accounts.length === 0) {
          return h(
            'div',
            { className: 'wb-empty' },
            h('div', { className: 'wb-empty-title' }, t('尚未添加 WorkBuddy 账号', 'No WorkBuddy account yet')),
            h('div', null, t('添加账号后可查看积分余额、额度重置时间与每日签到状态。', 'Add an account to see credits, reset times, and daily check-in status.')),
            h('button', { className: 'wb-btn is-primary', type: 'button', onClick: () => setLoginOpen(true) }, t('添加账号', 'add account')),
          )
        }
        return h(
          'div',
          { className: 'wb-table' },
          h(
            'div',
            { className: 'wb-thead' },
            h('span', { className: 'wb-dot is-hidden' }),
            h('span', { className: 'wb-name' }, t('账号', 'account')),
            h('span', { className: 'wb-check' }, t('签到', 'check-in')),
            h('span', { className: 'wb-reset' }, t('额度重置', 'resets')),
            h('span', { className: 'wb-amount' }, t('积分余额', 'credits')),
            h('span', { className: 'wb-act' }, t('切换', 'switch')),
            h('span', { style: { width: 24 } }),
          ),
          sorted.map((account) =>
            h(AccountRow, {
              key: account.id,
              account,
              checkin: checkinViewFor(checkin, account.id),
              role: roleOf(account),
              pinned: account.id === pinnedId,
              canRelease: pinnedId !== undefined,
              busy,
              onRemove: () => onRemove(account),
              onUse: () => onPick(account.id),
              onRelease: () => onPick(''),
            }),
          ),
        )
      }

      const body = renderBody()

      return h(
        'div',
        { className: 'wb-page' },
        toolbar,
        notice === null ? null : h('div', { className: 'wb-banner is-ok' }, notice),
        error === null ? null : h('div', { className: 'wb-banner is-error' }, error),
        body,
        loginOpen === true
          ? h(LoginDialog, {
              onClose: () => setLoginOpen(false),
              onDone: (nickname) => {
                setLoginOpen(false)
                flash(nickname.length === 0 ? t('账号已添加', 'account added') : t('已添加账号：', 'added ') + nickname)
                onRefreshAll()
              },
            })
          : null,
        confirming === null
          ? null
          : h(ConfirmDialog, {
              title: t('删除账号', 'Remove account'),
              description:
                t('将从本机移除 ', 'This removes the local credential for ') +
                accountName(confirming) +
                t(' 的凭据，之后需要重新登录才能使用。', '. Sign in again to use it.'),
              confirmLabel: t('删除', 'remove'),
              onCancel: () => setConfirming(null),
              onConfirm: confirmRemove,
            }),
      )
    }

    /* ── composer pill ──────────────────────────────────────────── */

    function QuotaPill(props) {
      const sessionId = sessionIdOf(props)
      const [state, setState] = React.useState(null)
      React.useEffect(() => {
        let cancelled = false
        const query = sessionId === undefined ? '' : '?session=' + encodeURIComponent(sessionId)
        const load = async () => {
          try {
            const response = await fetch(QUOTA_ROUTE + query, { headers: { accept: 'application/json' } })
            if (response.ok !== true) return
            const data = await response.json()
            if (cancelled !== true) setState(data)
          } catch {
            // Keep the previous reading; a transient failure must not blank the pill.
          }
        }
        load()
        const timer = setInterval(load, PILL_REFRESH_MS)
        return () => {
          cancelled = true
          clearInterval(timer)
        }
      }, [sessionId])
      if (state === null || Array.isArray(state.accounts) !== true) return null
      const rows = state.accounts.filter(usable)
      if (state.accounts.length === 0) return null
      // This conversation's own account wins over the pin: a switch applies to
      // conversations started later, so the pill must not claim otherwise. A
      // conversation the page cannot name (no session id in the URL) has no
      // lock to show, and the durable record then belongs to some other chat.
      const sessionLockId =
        sessionId === undefined
          ? undefined
          : typeof state.sessionAccountId === 'string' && state.sessionAccountId.length > 0
            ? state.sessionAccountId
            : state.session !== undefined && typeof state.session.accountId === 'string'
              ? state.session.accountId
              : undefined
      const pinnedId = typeof state.pinnedAccountId === 'string' && state.pinnedAccountId.length > 0 ? state.pinnedAccountId : undefined
      const lastUsedId = typeof state.lastUsedAccountId === 'string' ? state.lastUsedAccountId : undefined
      // Every row is a candidate, not only the ones whose balance was readable:
      // the account serving this chat must keep its name beside its own tooltip.
      const pick = (id) => (id === undefined ? undefined : state.accounts.find((row) => row.id === id))
      const pinnedRow = pick(pinnedId)
      const current =
        pick(sessionLockId) ??
        (pinnedRow !== undefined && pinnedRow.cooling !== true ? pinnedRow : undefined) ??
        pick(lastUsedId) ??
        pinnedRow ??
        rows[0] ??
        state.accounts[0]
      const name = accountName(current)
      // Without a session id the durable record belongs to some other chat, so
      // the spend is left out rather than reported as this conversation's.
      const spent =
        sessionId === undefined || state.session === undefined || Number.isFinite(state.session.credits) !== true
          ? undefined
          : state.session.credits
      const balance = usable(current) ? formatCredits(current.quota.remaining) : '—'
      const head = isZh() ? name + ' · 剩 ' + balance : name + ' · ' + balance + ' left'
      const text = spent === undefined ? head : head + (isZh() ? ' · 本会话 ' : ' · session ') + formatSpend(spent)
      const detail = state.accounts
        .map((row) => {
          const who = accountName(row)
          const mark =
            row.id === sessionLockId
              ? t('（本会话）', ' (this chat)')
              : row.id === pinnedId
                ? t('（新会话）', ' (new chats)')
                : ''
          if (usable(row) !== true) return who + mark + ': ' + (row.error === undefined ? 'unknown' : row.error)
          const reset = typeof row.quota.resetAt === 'string' ? ', resets ' + row.quota.resetAt : ''
          return who + mark + ': ' + formatCredits(row.quota.remaining) + reset
        })
        .join('\n')
      return h(
        'div',
        { className: 'wb-pill', title: (isZh() ? 'WorkBuddy 积分' : 'WorkBuddy credits') + '\n' + detail, 'aria-label': text },
        h('span', { className: 'wb-pill-dot', 'aria-hidden': true }),
        text,
      )
    }

    /* ── registration ───────────────────────────────────────────── */

    return {
      inject: ['slots'],
      apply(ctx) {
        ensureStylesheet()
        ctx.slots.inject('conversation.composer.dock', () =>
          ctx.slots.register({ name: 'conversation.composer.dock', id: 'llm-workbuddy-credits', order: -1 }, QuotaPill),
        )
        ctx.slots.inject('settings.section', () =>
          ctx.slots.register(
            {
              name: 'settings.section',
              id: 'workbuddy',
              order: 12,
              label: () => 'WorkBuddy',
            },
            WorkBuddyPage,
          ),
        )
      },
    }
  },
})
