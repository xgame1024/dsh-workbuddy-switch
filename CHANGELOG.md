# Changelog

## 0.1.0

First public release: one DSH plugin that signs in with WorkBuddy (Tencent CodeBuddy) accounts and serves them as models.

- Registers the `workbuddy` model provider: streaming completions, reasoning content, tool calls, and images on routes whose model declares vision support.
- Account pool: browser device-authorization login and token import, credit-first account selection, failover to the next account, and a per-session lock so one conversation keeps one account and its prompt cache.
- Credits and quota: the footer pill and the Settings page show remaining credits, reset time, cooldown state and per-session spend; the daily check-in runs once per UTC+8 day with bounded retries.
- Settings page: the account table carries the switch on the row that holds the state — pinned rows show `当前`/`取消`, the pool's pick shows `当前（自动）`/`切换`, every other serving row reveals `切换` on hover.
- CN and global realms can be signed in side by side.
- No prompt rewriting: the harness prompt is forwarded as assembled. When the upstream rejects a turn with `11128` (channel check), switching model is the only lever.
