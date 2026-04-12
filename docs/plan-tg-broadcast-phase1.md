# TG 公开广播频道 — Phase 1 (v3, after 2 codex review rounds)

**Motivation**: Ender wants to pivot 诸葛's TG bot from solo-owner use to a small community. Phase 1 is the zero-risk step: mirror a subset of scheduled posts from the owner DM into a PUBLIC channel so followers can see market commentary and news — without exposing any positions, PnL numbers, or account state.

**Goal**: a TG channel the community can subscribe to for read-only broadcasts.
**Non-goal**: interactive Q&A, per-user identity, public DM, group discussion. Those are Phase 2+ and need separate planning.

---

## 🔥 Key change from plan v1 (codex review findings)

Codex review of plan v1 found two HIGH-severity misreadings of the dashboard.mjs code:

- `postCompound` contains `r.description` and `knowledgeFeedback.reason` — **unconstrained LLM text** generated from trade-review inputs that include symbol/side/leverage/pnl_pct/hold duration/veto reasons/strategy PnL. A regex that strips `$...` and `entry:` does NOT reliably prevent trade-detail leakage here.
- `postDream` includes `result.summary` — **arbitrary LLM output** over all recallable notes, `context.md`, and owner directives. Can leak private strategy, ops, or account context with no dollar sign in sight.

And MEDIUM: the regex sanitizer in plan v1 was aimed at `positions`/`PnL` content (`$123`, `entry: 2534.12`, `Total: $...`) — but those topics are already excluded from broadcast. The ACTUAL whitelisted posts (in v1) were `urgent`/`news`/`compound`/`dream`, where leak paths are plain numbers, `%`, `USDT`, leverage, symbols, strategy IDs, and prose. Plan v1's tests would pass while leaving the real risk untouched. Security theater.

**Fix in v2**: collapse the whitelist to the two topics that are already **public by construction**, drop the sanitize regex theater entirely, add operational dead-letter alerting, and require a dry-run approval gate before first broadcast.

---

## Architecture

```
┌──────────────────────┐
│  诸葛 pipeline       │
│  scheduled events    │
└──────┬───────────────┘
       ↓
   ┌───────┐     ┌────────────────────────────────┐
   │ _send │ ──→ │ TG_DASHBOARD_CHAT || TG_CHAT_ID│  ← existing routing
   └───┬───┘     └────────────────────────────────┘
       │
       ↓ (only when topicKey ∈ BROADCAST_TOPICS and TG_PUBLIC_CHANNEL set)
   ┌──────────────┐     ┌───────────────────────────┐
   │  _broadcast  │ ──→ │ TG_CHAT_ID (owner DM)     │  ← direct tgCall, FIRST
   │  (Option B)  │     │ Safety preview copy       │
   │              │     └───────────────────────────┘
   │              │     ┌───────────────────────────┐
   │              │ ──→ │ TG_PUBLIC_CHANNEL         │  ← direct tgCall, THEN
   │              │     │ (public, text as-is)      │
   └──────────────┘     └───────────────────────────┘
```

Critical: `_broadcast()` ALWAYS sends the explicit owner-DM copy to `TG_CHAT_ID` via a dedicated `tgCall` FIRST, regardless of whether `TG_DASHBOARD_CHAT` is configured. That guarantees the owner sees the exact text before the public channel does, independent of deployment topology. The owner-DM copy is a second tgCall separate from the normal `_send` routing — yes, that means duplicate delivery when `TG_DASHBOARD_CHAT` is empty, but duplicate to-owner is cheap and the safety property is enforced by design.

- **Single routing table inside dashboard.mjs** decides which topics mirror. Not config-driven — the list is safety-critical and should live in code where tests can enforce it.
- **New env**: `TG_PUBLIC_CHANNEL` — `@channelname` or numeric chat id where `@SunnStock_bot` is admin. Empty → broadcast is no-op.
- **Broadcast failure dead-letter**: in-memory counter + stopwatch. When **either** `consecutiveFails ≥ 3` **OR** (`consecutiveFails ≥ 1` and first-fail was more than 60 minutes ago), the dashboard sends ONE owner-specific warning and resets the counter. Owner warning goes via a **dedicated direct call** `tgCall('sendMessage', { chat_id: TG_CHAT_ID, text: ... })` — NOT through `_send`, because `_send` routes to `TG_DASHBOARD_CHAT || TG_CHAT_ID` and would land in the dashboard group if one is configured (codex review v2 catch). Counter resets on any successful broadcast.
- **No sanitizer** in Phase 1. Whitelist-by-construction is the primary defense.

## Broadcast whitelist (Phase 1 — reduced from v1)

| Post | Broadcast? | Rationale |
|---|---|---|
| `postPositions` (5min, pinned) | ❌ | PnL + amounts are private. |
| `postObserve` (system status) | ❌ | Reveals ops metadata (memory, LLM latency, error count). |
| `postCompound` (AI knowledge update) | ❌ **(changed from v1)** | Free-text rule descriptions + knowledge feedback reasons are unconstrained LLM output that can embed trade-specific details. No reliable regex sanitizer exists. Phase 2 path: add a separate `public_summary` column to `compound_rules` that's explicitly generated for public view with no access to raw trade data. |
| `postPnLChart` (6h PnL curve) | ❌ | Pure PnL. |
| `checkTgUrgent` (geopolitical flash) | ✅ | Already public content (KOL tweets, geopolitical news channels). The `translatedItems` text is a direct translation of public TG channel messages — nothing about 诸葛's trades or state. |
| `postNewsDigest` (hourly news) | ✅ | Direct headlines from crucix news feed (public news sources) + translation. No agent-state leakage. |
| `postDream` (memory consolidation) | ❌ **(changed from v1)** | `result.summary` is arbitrary LLM output over notes/context/owner directives. Unsafe. Phase 2 path: either suppress `summary` in the broadcast variant, or require explicit owner approval per-dream-run. |

**Result**: only `news` (shared topic for `checkTgUrgent` and `postNewsDigest`) is broadcast in Phase 1. Simple, safe, verifiable by inspection.

## Sanitizer

**Removed in v2.** Whitelist-by-construction is the defense. If a future topic with mixed-safety content needs broadcasting, design a dedicated public-safe data path at the source (e.g. a `public_summary` field generated by a separate LLM call with a restricted prompt), not a post-hoc regex.

Phase 1 has zero sanitize code, zero sanitize tests. Simpler, harder to get wrong.

## Config & env

`.env` adds ONE line:
```
# TG public broadcast channel (Phase 1 — news topics only)
# Set to @channelname or numeric chat id. Bot must be channel admin.
# Empty → broadcast disabled.
TG_PUBLIC_CHANNEL=
```

`config.mjs` exposes `config.TG_PUBLIC_CHANNEL`. `dashboard.mjs` reads it at `createDashboard()` time.

## Code changes

| File | Change |
|---|---|
| `config.mjs` | +1 line: `const TG_PUBLIC_CHANNEL = process.env.TG_PUBLIC_CHANNEL \|\| '';` exposed in return |
| `.env.example` | +1 line with comment |
| `agent/push/dashboard.mjs` | (a) `BROADCAST_TOPICS = new Set(['news'])` module constant; (b) `_broadcast(text)` helper that, when topicKey is in whitelist AND `TG_PUBLIC_CHANNEL` is set, makes TWO direct tgCalls: FIRST an explicit owner-DM copy via `tgCall('sendMessage', { chat_id: TG_CHAT_ID, text: '[BROADCAST] ' + text.slice(0, 4000) })`, THEN the public channel via `tgCall('sendMessage', { chat_id: TG_PUBLIC_CHANNEL, text: text.slice(0, 4000) })`. Both wrapped in independent try/catch. (c) `_send(text, topicKey)` calls `_broadcast(text, topicKey)` after its own existing owner-routing send. (d) Consecutive-failure counter `publicBroadcastFails` + first-fail timestamp; when counter ≥ 3 OR (counter ≥ 1 AND elapsed ≥ 60 min), send dedicated dead-letter alert via direct `tgCall('sendMessage', { chat_id: TG_CHAT_ID, text: 'public channel broadcast failing: ...' })` (NOT via `_send`, to bypass `TG_DASHBOARD_CHAT` routing), then reset counter and timestamp. Any successful broadcast resets both. |
| `agent/push/__tests__/dashboard-broadcast.test.mjs` | NEW. Test: (1) `_send(..., 'news')` mirrors when channel set, (2) `_send(..., 'positions')` does NOT mirror, (3) channel-empty short-circuits broadcast, (4) broadcast failure does not fail owner send, (5) dead-letter counter fires after N failures, (6) counter resets on success |

No sanitize.mjs file. No regex.

## Tests

`dashboard-broadcast.test.mjs`:
1. `_send('text', 'news')` with `TG_PUBLIC_CHANNEL='@test'` → `tgCall` called THREE times: owner routing (dashboard/DM), explicit owner-DM copy, public channel (all with same text)
2. `_send('text', 'positions')` with `TG_PUBLIC_CHANNEL='@test'` → `tgCall` called ONCE (not in whitelist, no explicit owner copy, no public channel)
3. `_send('text', 'news')` with `TG_PUBLIC_CHANNEL=''` → `tgCall` called ONCE (feature disabled, no explicit owner copy, no public channel)
4. Public broadcast throws → owner send paths still succeed, no exception propagated
5. **Dead-letter threshold A**: 3 consecutive public broadcast failures → 3rd failure triggers `tgCall('sendMessage', {chat_id: TG_CHAT_ID, ...})` alert; counter resets
6. **Dead-letter threshold B**: 1 failure, advance fake clock by 61 minutes, 2nd failure → alert fires (60-minute branch)
7. Success after any failure streak resets counter before either threshold fires
8. Dead-letter alert uses `TG_CHAT_ID` directly, NOT `_send` (deployment-topology-independent)

## Rollout

1. **User creates TG channel** `@ZhugeNews` (or chosen name) and adds `@SunnStock_bot` as admin with "Post Messages" permission.
2. **User gives me the channel ID** (or username).
3. **Implement + codex review + commit + push + deploy to VPS** with `TG_PUBLIC_CHANNEL=` (empty) — code is deployed but feature is off.
4. **Hand-crafted liveness test** — before flipping the feature on, send a single manual curl via the TG bot API to the new channel (e.g. "🧪 诸葛 public channel liveness test"). Verifies bot admin permission + channel is writable. Not routed through dashboard code.
5. **Flip the switch**: set `TG_PUBLIC_CHANNEL=@ZhugeNews` in VPS .env, `pm2 restart rifi-vps --update-env`.
6. **Live monitoring window**: the rollout gate is that **owner sees the exact text before it hits the public channel**. Implementation constraint (codex R3 catch): `_send(..., 'news')` routes to `TG_DASHBOARD_CHAT || TG_CHAT_ID`, so if the deployment has `TG_DASHBOARD_CHAT` set, the owner's first copy would land in the dashboard group instead of DM. Two options:

   - **Option A (Phase 1 constraint)**: Require `TG_DASHBOARD_CHAT=""` (owner DM-only) for Phase 1 rollout. Current deployment already matches (`TG_DASHBOARD_CHAT` is empty in VPS .env). If Ender later sets `TG_DASHBOARD_CHAT`, they must re-evaluate Phase 1.

   - **Option B (defense in depth)**: `_broadcast()` explicitly sends the text copy to `TG_CHAT_ID` via dedicated tgCall (same mechanism as dead-letter) FIRST, then to the public channel. Cost: one extra bot API call per broadcast. Benefit: owner DM is always the first recipient regardless of `TG_DASHBOARD_CHAT` configuration. **Phase 1 picks Option B** because the extra call is cheap and makes the safety story deployment-topology-independent.

   If any broadcast looks wrong, owner runs `sed -i 's|^TG_PUBLIC_CHANNEL=.*|TG_PUBLIC_CHANNEL=|' ~/tradeagent/.env && pm2 restart rifi-vps --update-env` to kill the feed. No new command paths (dropped `/broadcast_preview` from v2 per codex R2 — state-mutation + command-routing complications outweighed the preview value).

## Operational safeguards (new in v2)

1. **Dead-letter alerting** — consecutive broadcast failures ≥ threshold → one owner-DM warning, then silence until a successful broadcast resets the counter. Prevents silent channel death.
2. **Per-broadcast metric counter** — increment a `broadcast_success_count` / `broadcast_fail_count` metric so a future observability pass can chart it. (Just an in-process counter exposed via `getState()` for now.)
3. **Explicit allow-list of whitelisted topic keys lives in code, not config** — changing broadcast policy requires a code review, not an env var flip.

## Risks + mitigations (revised)

| Risk | Mitigation |
|---|---|
| Free-text LLM output in `compound` / `dream` leaks trade details | Not in whitelist. Phase 2 path documented. |
| `news` broadcast accidentally contains something non-public | The `news` topic content comes from `_translate` of public crucix news + urgent channel messages. Source is public by construction. If the translator somehow mutates text to include agent context, that's a separate bug in the LLM prompt, not a broadcast problem. |
| Silent channel death (bot loses admin, channel renamed) | Dead-letter counter + owner alert. |
| Volume / rate limit | ~10 broadcasts/hour peak. TG bot limit is 30/sec. Non-issue. |
| Broadcast failure cascades to owner DM | Try/catch isolates broadcast; owner DM independent. |

## Explicit non-goals for Phase 1

- No interactive commands on the channel
- No per-user features
- No sanitizer code
- No `postCompound` / `postDream` mirroring
- No position sanitization (Phase 2 if ever)
- No English translation
- No markdown v2 formatting

## Phase 2 path (sketch, not part of this commit)

If Ender wants the community to see compound knowledge / dream summaries / sanitized positions:

- **Design a dedicated "public view" data path at the source**, not a post-hoc regex. Examples:
  - `compound_rules.public_summary` — a separate LLM call with a prompt that explicitly says "summarize this rule for a public audience, do not mention specific trades, PnL, or positions".
  - `dream_runs.public_summary` — same pattern.
  - `positions_public_snapshot` — pre-computed, amount-free summary (e.g., "currently holding 2 long positions in ETH/BTC") that never contains raw numbers.
- **Manual approval queue** — each candidate broadcast is queued to owner DM with inline "approve" / "reject" buttons (TG InlineKeyboard). Owner taps approve → sends to channel. High friction but near-zero leak risk.
- **Add a human voice layer** — Ender writes a short note to the channel manually every day or two, with 诸葛 providing the data and Ender providing the voice. Hybrid approach; still Phase 2+.
