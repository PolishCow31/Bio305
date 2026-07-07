# CyBio305 — Cross-Device Sync Redesign (Design Spec)

- **Date:** 2026-07-07
- **Status:** Approved (Christian), ready for implementation plan
- **Author:** Cy
- **Scope:** Replace the whole-blob last-write-wins sync with an event-sourced, per-card merge plus a throttled live-poll loop, staying entirely on the existing Cloudflare Pages + KV backend.

---

## 1. Problem

Progress does not stay consistent across Christian's laptop and phone. Two defects stack:

1. **Whole-blob last-write-wins.** The entire `state` object (`{srs, sessions, settings, tagW}`) is JSON-stringified and stored under a single KV key `profile:<account>`. Any push overwrites the whole record. There is no merge, so whichever device pushes last silently discards everything the other device did (`api/functions/api/[[path]].js`, `POST /sync`).
2. **Pull fires once, on page load only.** `Store.pull()` is called a single time at boot (`js/app.js:440`) and on manual Settings save (`js/app.js:424`). There is no interval, no visibility-driven refresh. A device that has been open a while never re-pulls.

Combined effect: with both devices open, studying on one and then the other overwrites the first device's work. The user experience is "last device to touch it wins; the other loses its reps."

### What is NOT the problem

The KV-quota exhaustion Christian remembers was **not** sync. It was the retired grade relay (`com.bio305.graderelay`) calling `KV.list` every 30s = ~2,880 list ops/day against a 1,000/day list cap, which failed nightly. That relay is unloaded and — per the decision to keep deep-grade laptop-only — stays off. Sync never polled and never listed, so it could not have burned reads. This redesign performs **zero** list operations.

---

## 2. Goals / Non-goals

### Goals
- **No data loss, ever.** Concurrent edits on two devices must merge; nothing overwrites.
- **Live / "intertwined."** A change on one device appears on the other within seconds (target: ≤ ~30s worst case at default settings, instant on refocus).
- **Stay within Cloudflare KV free quotas** with wide margin (reads « 100k/day, writes « 1k/day, lists = 0).
- **Zero new infrastructure or accounts.** Reuse the existing `bio305-api.pages.dev` Pages Function + `BIO305_KV` namespace and the existing API token (Pages+KV scope).
- **Offline-first preserved.** localStorage remains the local source of truth; sync is best-effort on top.

### Non-goals
- Real-time WebSocket push (Durable Objects) — rejected as overkill and blocked by token scope.
- Phone-side deep-grade — explicitly deferred; deep-grade stays laptop-only.
- Multi-user / auth changes — single user, single `account` string, unchanged.
- Migrating storage to D1 — kept as a documented future upgrade path (see §11), not this project.

---

## 3. Chosen approach

**Event-sourced, per-card CRDT merge + throttled live-poll on KV.**

The per-card answer-history (`hist[]`, already present in the schema) becomes the **source of truth**. Every derived value — `reps, lapses, ease, ivl, due, seen` and all `tagW` weights — is **recomputed by replaying the merged event stream**, never synced directly. State is a pure function of `(merged events, settings)`. Because event-union is commutative/idempotent and replay is deterministic, any two devices that have observed the same events converge to byte-identical derived state. Clobbering is structurally impossible, independent of the transport.

The transport (polling) only controls *latency* of propagation, not correctness.

---

## 4. Data model changes

### 4.1 Event schema

Per-card events grow two fields:

```
before: { ts, lat, grade, correct }
after:  { ts, lat, grade, correct, dev, kind }
```

- **`dev`** — a random per-device id, generated once and stored in localStorage (`bio305.dev`). Makes every event globally unique. Merge dedup key = `` `${dev}:${ts}` ``.
- **`kind`** — `"flip"` | `"problem"`. Lets replay pick the correct scheduling formula without needing the card deck loaded (merge/replay must work before `data/*.json` fetch completes).

### 4.2 Settings stamp

`state.settings.updatedAt` (epoch ms) is written whenever settings change, to drive last-write-wins resolution of the settings object during merge.

### 4.3 Migration (one-time, idempotent)

On load, if `state.schema !== 2`:
- For every existing event lacking `dev`, backfill `dev = <this device id>` (legacy events are single-origin, so this is correct).
- For every event lacking `kind`, infer from the card's `type` via `byId` when the deck is available, else default `"flip"`; problems are re-tagged on first replay if needed.
- Set `state.settings.updatedAt = Date.now()` if absent.
- Set `state.schema = 2`, `save()`.

No event is mutated twice; the flag guards re-runs.

---

## 5. Merge algorithm

`mergeState(local, remote) -> merged` (pure, no I/O):

1. **Events:** for each card id in either state, concatenate both `hist` arrays, dedup by `` `${dev}:${ts}` `` (legacy events with no `dev` fall back to a positional key and are single-origin, so they never collide), sort ascending by `ts`.
2. **Replay per card:** fold the merged, ts-ordered events through the pure scheduler (`§6`) to produce `{reps, lapses, ease, ivl, due, seen}`.
3. **tagW:** recompute by replaying `bumpTags` over the full merged event stream (all cards, ts-ordered). Fully derived → convergent. (No LWW on tagW.)
4. **sessions:** union of both arrays, dedup by `` `${dev||''}:${ts}` ``, sorted by `ts`.
5. **settings:** last-write-wins — take the settings object with the larger `updatedAt`.

### Invariants (must hold; verified in tests)
- Commutative: `merge(A, B)` ≡ `merge(B, A)` (same derived state).
- Idempotent: `merge(A, A)` ≡ `A`.
- Monotone: merging never removes an event.

These make the scheme a CRDT (OR-Set of events + deterministic fold), which is what guarantees convergence and self-healing under races.

---

## 6. Scheduler refactor (behavior-preserving)

The scheduling math currently lives inline in `grade()` and `logProblem()` and uses `Date.now()`. Factor it into a **pure** function used by both the live path and replay:

```
applyGrade(srs, grade, ts, kind) -> srs'
```

- Reproduces the exact current transitions:
  - Flip (`kind==="flip"`): the `g===1..4` ease/ivl/lapse logic from `grade()` including the Exam-I interval cap.
  - Problem (`kind==="problem"`): the correct/incorrect ivl logic from `logProblem()`.
- **Difference from today (intentional, more correct):** `due` is computed as `ts + ivl*DAY` (event time) instead of `Date.now()`. At live grade-time `ts === now`, so live behavior is unchanged; on replay it yields the historically-correct due date.

The Exam-I cap (`EXAM_I`) and `DAY` constants are unchanged. Live `grade()` / `logProblem()` become thin wrappers: append the event (`{ts:now, lat, grade, correct, dev, kind}`), call `applyGrade`, `bumpTags`, `save()`.

**This is a behavior-preserving refactor of grade data → it must be skeptic-verified (§10) before trust.**

---

## 7. Sync loop

### 7.1 Pull (poll)
- Interval: **`POLL_INTERVAL` = 10s**, only while `document.visibilityState === "visible"`.
- Paused when the tab is hidden/backgrounded; on `visibilitychange → visible`, do an **immediate** pull (so tabbing back is instantly fresh) and resume the interval.
- Request: `GET /sync?account=<a>&since=<rev>` where `rev` is the last-seen server `updatedAt`. The Function returns `{changed:false}` when `rev` matches current → a cheap 1-read poll with a tiny body. Only when changed does it return `{blob, updatedAt}`.
- On change: `state = mergeState(local, JSON.parse(blob))`, `save()` (suppressing push — see no-echo), record `syncMeta.updatedAt`, re-render if the current view reflects synced data (review queue / stats / home counts).

### 7.2 Push (throttled)
- Any **local-originated** change sets `dirty = true` and `localOriginated = true`.
- A push fires at most once per **`PUSH_MIN_INTERVAL` = 20s** while `dirty`, and **flushes immediately** on `visibilitychange → hidden` and `pagehide` (so backgrounding/closing never strands work).
- Push sequence (merge-before-write, so a push can never clobber):
  1. `GET /sync` (current remote).
  2. `merged = mergeState(local, remote)`; adopt merged locally.
  3. `PUT /sync` with the merged blob (one KV write). Server stamps `updatedAt = Date.now()` (server clock authoritative for the poll gate).
  4. `dirty = false`.

### 7.3 No-echo rule (prevents write ping-pong)
- A pull that only **absorbed remote events** (this device produced no new local event since the last successful push) sets `dirty = false` **without** scheduling a push. `localOriginated` gates whether a push is warranted. Two idle-but-open devices therefore never bounce writes at each other.

### 7.4 Tunable knobs
| Setting | POLL / PUSH | Worst-case cross-propagation | Reads/day (2 devices, both visible all day) | Writes/day (typical) |
|---|---|---|---|---|
| **Default** | 10s / 20s | ~30s (instant on refocus) | ~17k | ~100–250 |
| **Snappy** | 5s / 10s | ~15s | ~35k | ~200–400 |

Both are safely under the 100k read / 1k write caps. (Poll reads dominate the read column; each push also does one read for its merge-before-write, adding only a few hundred reads/day — negligible.) Default ships; snappy is a one-line change if desired.

---

## 8. Backend changes (`api/functions/api/[[path]].js`)

Minimal, additive:
- `GET /sync` accepts an optional `since` query param. Read the KV record once; if `record.updatedAt === Number(since)`, return `{changed:false, updatedAt}` with no blob. Otherwise return `{changed:true, blob, updatedAt}` (back-compat: absent `since` → always returns the blob as today).
- `POST /sync` unchanged (whole record write, server-stamped `updatedAt`). Merge happens client-side, so the server stays a dumb store.
- No new keys, no `KV.list`, grade/relay routes untouched.

Single-key design keeps push at **one write** and poll at **one read**.

---

## 9. Grader orthogonality

`Store.localGrade` (POST `http://127.0.0.1:8457/grade`, laptop-only) is unchanged and stateless. Its only interaction with sync: a self-graded or deep-graded problem emits a normal `problem` event that syncs like any other. The verdict text is ephemeral (not persisted, not synced). The phone path (heuristic `localCheck` + worked solution) is unchanged. The grader cannot affect sync correctness.

---

## 10. Error handling & edge cases

- **Offline / fetch failure:** localStorage is authoritative; a failed push leaves `dirty = true` to retry next window; a failed poll is skipped. The UI never blocks on sync.
- **Two near-simultaneous pushes (KV read-modify-write race):** a lost update self-heals — every device permanently retains its own events and re-merges each cycle, so a dropped write reappears within one push interval. Union monotonicity guarantees no permanent loss.
- **Clock skew between devices:** event `ts` is device-local (acceptable — cross-device same-card grading inside the skew window is rare and still unions). The "who is newer" poll gate uses the **server** clock (`updatedAt`), which is authoritative and skew-free.
- **Merge before decks load:** merge/replay operate on raw events and the `kind` field only; no deck required.
- **First run / empty remote:** remote `null` → push local up; nothing to merge.
- **Blob growth:** a full summer of events is tens–low-hundreds of KB, far under KV's 25 MB value limit; the `since` gate keeps unchanged polls from shipping it.

---

## 11. Testing & verification

- **Unit:**
  - `mergeState` commutativity, idempotency, monotonicity (property tests over random event sets).
  - `applyGrade` reproduces the pre-refactor `grade()` / `logProblem()` outputs for representative event sequences (behavior preservation).
- **Manual two-tab (or two-device):**
  - Grade *different* cards in each → both converge within a poll cycle, zero loss.
  - Grade the *same* card in both while offline → reconnect → both reps survive (union).
  - Background one tab mid-session → confirm the pending push flushed.
- **Skeptic-verify** (per working agreement — grade data, not cheaply eyeballed): spawn skeptics to refute "replay preserves the current scheduler exactly" and "the merge always converges / never loses an event." Resolve before trusting.
- **Quota instrumentation:** count pushes/polls over a real study day; confirm reads/writes land within §7.4 predictions.

---

## 12. Rollout / deploy notes

- Frontend: bump `js/store.js?v=` and `js/app.js?v=` in `index.html`, and the `sw.js` cache name `bio305-vN`, so the installed PWA picks up the new sync code (per the project's PWA-freshness rule).
- Backend: `cd api && wrangler pages deploy --branch main` (token loaded via `eval`, `CLOUDFLARE_ACCOUNT_ID` exported) after the `[[path]].js` change.
- Migration runs automatically on first load (schema 1 → 2); no user action.
- The pending uncommitted emoji fix (`app.js` Blitz label + `index.html` `app.js?v=7`) folds into this deploy.

---

## 13. Future upgrade path (not this project)

If device count grows or write-quota anxiety ever returns, swap KV for **Cloudflare D1** (100k writes/day, 100× KV): the merge layer is deliberately storage-agnostic, so only the backend read/write of the blob (or a move to per-event rows) changes — the client merge/replay is untouched. Requires creating the D1 database via the CF dashboard (current token lacks D1 scope).
