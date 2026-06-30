# SDK Migration Plan — @opencode-ai/sdk

**Goal:** Replace raw SQLite polling and duplicated ad-hoc HTTP calls with the official opencode SDK.
**Strategy:** Shared SDK client module → both server routes and bun handlers import from it.

---

## Architecture Change

```
┌──────────────────────────────────────────────────────────────────────┐
│ BEFORE (current)                                                     │
│                                                                      │
│  Server Routes      Bun Handlers                                     │
│  ┌──────────────┐   ┌────────────────────┐                           │
│  │ cost.ts       │   │ costSummary()      │  ── both poll            │
│  │ session.ts    │   │ createSession()    │  ── both do raw HTTP     │
│  │ ticket.ts     │   │ computeChangedFiles│  ── both run git diff    │
│  │ opencode-     │   │ getOpencodeConfig()│  ── both read file       │
│  │   config.ts   │   │ listAgents()       │  ── different logic      │
│  │ journal.ts    │   │ getJournal()       │  ── different impl       │
│  └──────┬───────┘   └───────┬───────────┘                           │
│         │                   │                                         │
│         ▼                   ▼                                         │
│  ┌──────────────────────────────────────────────────────┐            │
│  │  cost-utils.ts (getOpencodeDb → raw SQL on opencode.db) │          │
│  │  → Same pattern duplicated in both places             │            │
│  └──────────────────────────────────────────────────────┘            │
└──────────────────────────────────────────────────────────────────────┘

┌──────────────────────────────────────────────────────────────────────┐
│ AFTER (with SDK)                                                      │
│                                                                      │
│  Server Routes      Bun Handlers                                     │
│  ┌──────────────┐   ┌────────────────────┐                           │
│  │ cost.ts  ────┼───┼──── imports         │                           │
│  │ session.ts ──┼───┼──── imports         │                           │
│  │ ticket.ts ───┼───┼──── imports         │                           │
│  │ opencode-  ──┼───┼──── imports         │                           │
│  │   config.ts  │   │                    │                           │
│  └──────┬───────┘   └───────┬───────────┘                           │
│         │                   │                                         │
│         └───────┬───────────┘                                         │
│                 ▼                                                     │
│  ┌──────────────────────────────────────┐                            │
│  │  src/shared/opencode-client.ts        │   ← NEW shared module     │
│  │  wraps @opencode-ai/sdk               │                            │
│  │  Handles:                             │                            │
│  │   • Server lifecycle (connect/retry)  │                            │
│  │   • Session CRUD via SDK              │                            │
│  │   • Cost data via SDK API             │                            │
│  │   • Config via SDK API                │                            │
│  │   • Event stream via SDK              │                            │
│  │   • Diff via HTTP (or SDK if added)   │                            │
│  └──────────────────────────────────────┘                            │
└──────────────────────────────────────────────────────────────────────┘

```

---

## Step 1 — Create shared SDK client module

**File:** `src/shared/opencode-client.ts`

**What it does:** A single wrapper around `@opencode-ai/sdk` that:
- Connects to the running `opencode serve` process
- Provides typed methods used by both server routes and bun handlers
- Handles reconnection, timeouts, error normalization
- Exposes a singleton `OpencodeClient` class

**Interface (target):**
```typescript
import { createOpencodeClient } from "@opencode-ai/sdk"
import type { Session, Message } from "@opencode-ai/sdk"

class OpencodeClient {
  constructor(baseUrl: string)

  // Costs — replaces cost-utils.ts + cost-watcher.ts
  async getSessionCost(sessionId: string): Promise<{ costUsd: number; tokens: number } | null>
  async getBatchSessionCosts(ids: string[]): Promise<Map<string, { costUsd: number; tokens: number }>>
  async getAggregatedCosts(since: number): Promise<{ ... }>

  // Config — replaces opencode-config.ts file reads
  async getConfig(): Promise<{ model: string; default_agent: string }>
  async listAgents(): Promise<AgentEntry[]>

  // Events — replaces cost-watcher.ts polling
  subscribeToEvents(onEvent: (event) => void): () => void

  // Sessions — replaces raw HTTP in session.ts
  async createSession(title: string, model?: any): Promise<string>
  async getMessages(sessionId: string): Promise<Message[]>
  async sendMessage(sessionId: string, text: string): Promise<void>
  async getDiff(sessionId: string, messageId?: string): Promise<FileDiff[]>

  // Prompt improvement — replaces sendToSession + generateAndSendImprovedPrompt
  async improvePrompt(port: number, repoPath: string, description: string, model?: any, agent?: string): Promise<string>

  // Lifecycle
  close(): void
}
```

**What gets deleted as a direct consequence:**
- `src/server/cost-utils.ts` entirely (178 lines)
- `src/server/cost-watcher.ts` entirely (71 lines)
- Direct `getOpencodeDb()` calls in both codebases

---

## Step 2 — Replace cost tracking (cost-watcher.ts + cost-utils.ts)

### 2a. Real-time cost events (replaces cost-watcher.ts)

**Current:** Polls `opencode.db` SQLite every 3s → checks for changes → emits SSE.

**SDK:** `client.event.subscribe()` gives an async iterable of SSE events from opencode's `/event` endpoint. The event stream includes session status changes with cost data.

```
opencode /event SSE stream
  → client.event.subscribe()
    → filter session.* events
      → extract cost/token data
        → emitSse() to OpenTack's own SSE
          → browser updates live
```

**What changes:**
- Delete `src/server/cost-watcher.ts`
- Create new `src/server/sdk-cost-watcher.ts` (~40 lines) wrapping the SDK event stream
- Wire it up in `src/server/index.ts` and `src/bun/index.ts`

### 2b. Cost enrichment (replaces enrichFromOpencode + cost.ts + handler costs)

**Current:** `enrichFromOpencode()` opens opencode.db as SQLite, runs SELECT per session. Used in 10+ places across both codebases.

**SDK:** `client.getSessionCost(sessionId)` or batch variant.

**What changes:**
- Delete `src/server/cost-utils.ts`
- `cost.ts` routes switch from `getOpencodeDb()` to `opencodeClient.getAggregatedCosts()`
- Bun handlers' `costSummary()`, `costHistory()`, `costPerTicket()`, `costPerModel()` switch to SDK client
- Removes all raw SQL strings against opencode's internal schema

**Files modified:**

| File | Change | Lines removed |
|---|---|---|
| `src/server/cost-utils.ts` | DELETE entirely | -178 |
| `src/server/cost-watcher.ts` | DELETE entirely | -71 |
| `src/server/routes/cost.ts` | Replace `getOpencodeDb()` → `opencodeClient` | ~80 reduced to ~40 |
| `src/bun/handlers/index.ts` | Replace 4 cost functions | ~200 reduced to ~80 |
| `src/server/index.ts` | Replace `startCostWatcher` import | +1 |
| `src/bun/index.ts` | Replace `startCostWatcher` import | +1 |

---

## Step 3 — Replace diff computation

### 3a. Ticket-level diff (computeChangedFiles in ticket.ts)

**Current:** `computeChangedFiles()` runs 3 separate git commands:
```
git diff baseBranch...branch --name-status
git diff HEAD --name-status   (unstaged)
git diff --cached --name-status (staged)
```

**SDK:** The opencode server exposes `GET /session/:id/diff?messageID=` which returns `FileDiff[]`. The SDK may or may not expose this directly — if not, we use the HTTP endpoint.

**What changes:**
- `src/server/routes/ticket.ts` — `computeChangedFiles()` switches from git to `opencodeClient.getDiff()`
- `src/bun/handlers/index.ts` — imports `computeChangedFiles` from ticket.ts already, so this flows through

| File | Change | Lines |
|---|---|---|
| `src/server/routes/ticket.ts` | Replace `computeChangedFiles()` | ~40 → ~15 |
| `src/bun/handlers/index.ts` | Already imports `computeChangedFiles` | no change |

---

## Step 4 — Replace prompt improvement flow

### 4a. sendToSession + generateAndSendImprovedPrompt

**Current:** Two identical implementations:
- Server: `sendToSession()` at `session.ts:42`, `generateAndSendImprovedPrompt()` at `session.ts:68`
- Bun: `sendToSession()` at `handlers/index.ts:723`, `generateAndSendImprovedPrompt()` at `handlers/index.ts:755`

Both do the same 7-step flow:
1. Create temp session → 2. Send improvement prompt → 3. Wait → 4. Read response → 5. Parse → 6. Record cost → 7. Send to real session

**SDK:** Replace with structured output:
```typescript
const result = await client.session.prompt({
  path: { id: tempSessionId },
  body: {
    parts: [{ type: "text", text: improvementPrompt }],
    format: {
      type: "json_schema",
      schema: {
        type: "object",
        properties: {
          improvedPrompt: { type: "string" }
        },
        required: ["improvedPrompt"]
      }
    }
  }
})
const improved = result.data.info.structured_output.improvedPrompt
```

This eliminates the need to parse messages, filter by role, join text parts.

**What changes:**
- Consolidate into a single shared function in `src/shared/opencode-client.ts`
- Both server routes and bun handlers import from there
- Delete duplicated functions from both codebases

| File | Change | Lines removed |
|---|---|---|
| `src/server/routes/session.ts` | Delete `sendToSession()`, `generateAndSendImprovedPrompt()`, `createOpencodeSession()`, `readOpencodeModel()` | ~163 |
| `src/bun/handlers/index.ts` | Delete `sendToSession()`, `generateAndSendImprovedPrompt()` | ~130 |
| `src/shared/opencode-client.ts` | Add `improvePrompt()` | ~50 added |

---

## Step 5 — Replace opencode config reading

### 5a. Config routes

**Current:** Both `opencode-config.ts` (server) and handler functions read/write `opencode.json` directly with `Bun.file()` / `readFileSync()`.

**SDK:** `client.config.get()` returns full config with proper types.

**What changes:**
- Server `opencode-config.ts` GET route → `opencodeClient.getConfig()`
- Bun handler `getOpencodeConfig()` → `opencodeClient.getConfig()`
- Agent listing → `client.app.agents()` (server has endpoint for this)

**Important:** Config WRITES still need direct file access (the SDK's PATCH `/config` endpoint may not support all fields). Keep write functions as-is.

### 5b. readOpencodeModel() in session.ts

**Current:** Parses model from `opencode.json` file.
**SDK:** `client.config.get().model` returns the model string directly.

| File | Change | Lines removed |
|---|---|---|
| `src/server/routes/opencode-config.ts` | Replace 3 read functions with SDK calls | ~60 reduced to ~20 |
| `src/server/routes/session.ts` | Replace `readOpencodeModel()` | ~15 → ~3 |
| `src/bun/handlers/index.ts` | Replace `getOpencodeConfig()`, `listAgents()`, `getOpencodeTuiConfig()` | ~70 reduced to ~20 |

---

## Step 6 — Clean up code duplication

### 6a. Shared session lifecycle

**Current:** `createSession` logic duplicated:
- `src/server/routes/session.ts` (lines 282-475) — ~193 lines
- `src/bun/handlers/index.ts` (lines 946-1115) — ~169 lines

Both do the same: load ticket → resolve worktree → find/create session row → update ticket → start server → create opencode session → check forward description.

**Strategy:**
- Extract the worktree resolution + session row creation into a shared helper in the SDK client module
- Keep only route/handler boilerplate (params parsing, HTTP vs RPC response formatting) in each codebase

### 6b. Journal duplication

**Current:** `src/server/routes/journal.ts` (128 lines) vs `handlers/index.ts` `getJournal()` (~50 lines). Different implementations.

**Strategy:**
- Extract shared grouping/querying logic into SDK client module
- Both codebases import it

### 6c. Worktree duplication

**Current:** `src/server/routes/worktree.ts` (198 lines) contains all worktree logic. Bun handlers import `createWorktreeForTicket()` from there. Actually this is already shared — clean.

### 6d. What's left after cleanup

After steps 1-6, the bun handlers file (`index.ts`) shrinks from ~1845 lines to ~1200 lines. The remaining duplication is pure route boilerplate that can't be eliminated without merging the entire architecture.

---

## Step 7 — Wire up both entrypoints

### Server entrypoint (`src/server/index.ts`)

Current:
```typescript
import { startCostWatcher } from "./cost-watcher"
startCostWatcher(3000)
```

After:
```typescript
import { createSdkEventBridge } from "../shared/opencode-client"
// Connect to opencode server after starting it
// Replace polling with event subscription
```

### Bun entrypoint (`src/bun/index.ts`)

Current:
```typescript
import { startCostWatcher } from "../server/cost-watcher"
startCostWatcher(3000)
```

After:
```typescript
import { createSdkEventBridge } from "../shared/opencode-client"
// Same shared event bridge — no duplication
```

---

## File Manifest

### Files to create
| File | Purpose |
|---|---|
| `src/shared/opencode-client.ts` | Shared SDK wrapper — all SDK interaction centralized here |
| `src/server/sdk-cost-watcher.ts` | Event-driven cost watcher (replaces polling) |

### Files to delete
| File | Reason |
|---|---|
| `src/server/cost-utils.ts` | Replaced by SDK client |
| `src/server/cost-watcher.ts` | Replaced by event-driven watcher |

### Files to modify
| File | What changes |
|---|---|
| `src/server/routes/cost.ts` | Switch from `getOpencodeDb()` to SDK client |
| `src/server/routes/session.ts` | Delete duplicated `sendToSession`, `generateAndSendImprovedPrompt`, `createOpencodeSession`, `readOpencodeModel`; import from SDK client |
| `src/server/routes/ticket.ts` | `computeChangedFiles()` → SDK diff |
| `src/server/routes/opencode-config.ts` | Read functions → SDK config API |
| `src/server/routes/journal.ts` | Shared query logic → SDK client |
| `src/server/index.ts` | Swap `startCostWatcher` import |
| `src/bun/handlers/index.ts` | Replace cost functions, session lifecycle, config reads, improve flow |
| `src/bun/index.ts` | Swap `startCostWatcher` import |
| `src/bun/opencode-session.ts` | Can be simplified (or kept for now) — SDK may cover `createOpencodeSession` |

---

## Risk Assessment

| Risk | Likelihood | Mitigation |
|---|---|---|
| **SDK package missing methods** (no `summarize`, no `diff`) | Medium | Fall back to HTTP endpoints directly; SDK client module abstracts this |
| **SDK event stream differs from cost-watcher polling** | Medium | Keep polling as a fallback event source; switch when SDK events prove reliable |
| **SDK config API doesn't support write** | Low | Keep direct file writes for config mutations; reads via SDK |
| **Bun compatibility with SDK's fetch** | Low | SDK uses `globalThis.fetch` which Bun supports natively |
| **Regression in session creation** | High | **Critical path** — test createSession → opencode loads → session appears. Keep old code behind a feature flag during migration |

---

## Execution order (actual implementation sequence)

### Phase A — Foundation (Step 1)
1. Install `@opencode-ai/sdk`
2. Create `src/shared/opencode-client.ts` with connect, disconnect, health check
3. Create `src/server/sdk-cost-watcher.ts` using SDK event stream
4. Wire event watcher into both entrypoints alongside the existing one (dual-run for validation)
5. **Verify:** Both polling and event-based cost watchers produce same values for 5 min

### Phase B — Cost replacement (Step 2)
1. Add `getSessionCost()`, `getBatchSessionCosts()` to SDK client
2. Update `cost.ts` routes
3. Update bun handler cost functions
4. Delete `cost-utils.ts` and `cost-watcher.ts`
5. **Verify:** All cost views (summary, history, per-ticket, per-model) return same data

### Phase C — Config + Diff (Steps 3 + 5)
1. Add `getConfig()`, `listAgents()` to SDK client
2. Update `opencode-config.ts` routes and bun handlers
3. Add `getDiff()` to SDK client
4. Update `computeChangedFiles()` in ticket.ts
5. **Verify:** Config reads work, file changes show correct diffs

### Phase D — Prompt flows (Step 4)
1. Add `improvePrompt()` to SDK client
2. Consolidate `sendToSession` into shared module
3. Update both codebases
4. **Verify:** Improve prompt works

### Phase E — Duplication cleanup (Step 6)
1. Extract shared session lifecycle helper
2. Extract shared journal querying
3. Update both codebases
4. **Verify:** Create/stop session works from both entrypoints

### Phase F — Decommission
1. Remove any remaining dead imports
2. Run full typecheck, build, and manual smoke test
3. Delete `src/bun/opencode-session.ts` if fully replaced

---

## Success criteria

- [ ] `cost-watcher.ts` deleted — cost updates via SDK event stream
- [ ] `cost-utils.ts` deleted — no raw SQL queries against opencode DB
- [ ] `cost.ts` routes use SDK client — no direct `bun:sqlite` access to opencode DB
- [ ] Bun handler cost functions use SDK client
- [ ] `opencode-config.ts` reads via SDK — no direct `readFileSync` for config
- [ ] `improvePrompt` exists once in `shared/opencode-client.ts`
- [ ] `sendToSession` exists once in `shared/opencode-client.ts`
- [ ] Bun handlers file reduced from ~1845 lines to ~1200 lines
- [ ] `bun run typecheck` passes
- [ ] `bun run build` succeeds
- [ ] Manual test: create ticket → start session → see costs → see diff → stop session
