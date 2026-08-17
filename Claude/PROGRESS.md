# PROGRESS — M_Schedule

Tracking doc maintained by the Conductor (main loop). See `CLAUDE.md` §0.5.
State values: `TODO` · `RUNNING` · `REVIEW` (awaiting conductor inspection) · `REWORK` · `DONE` · `BLOCKED`

## Round 1 — research & foundation

| # | Unit | State | Output | Verification |
|---|---|---|---|---|
| R1-A | NEXON MapleStory Open API research | **DONE** | `Claude/research-NEXON-API.md` | Conductor re-verified independently: scheduler spec YAML line 29 confirms own-account-only; `registration_flag`/`complete_flag`/`weekly_boss_clear_*` present; no time field anywhere; CORS origin-reflection + preflight 200 + `OPENAPI00005` error shape all reproduced by live probe. Findings folded into `CLAUDE.md` §1.1 / §2.1. |
| R1-D | Boss master data + crystal price table (API has none) | **DONE (with caveats)** | `Claude/research-BOSS-DATA.md` | 78 entries (24 daily / 52 weekly / 2 monthly). Prices verified sound; derived rules corrected — see R1-E. |
| R1-E | Cross-verify R1-D (implementer ≠ verifier, per §0.2) | **DONE** | `Claude/review-BOSS-DATA.md` | Found 8 defects, 5 affecting income math — the review paid for itself. **Numeric price mismatches: 0** across 74/78 entries double-sourced (namu.wiki price table × Inven 1.2.202 patch-note transcription); rules R1–R7 all reproduced. Defects were all in the *derived* layer: carry-over misread, 90-cap self-contradiction, overstated "individually confirmed" party-size list, unsourced Velona prices left in the constant. Conductor turned these into documented product decisions D1–D5 in `CLAUDE.md` §1.3 and relayed them to R2-B. |
| R1-B | KakaoTalk bot integration research | **DONE** | `Claude/research-KAKAO-BOT.md` | Conductor read in full. Official-API-impossible verdict is backed by two Kakao operator replies, not inference. Interface contract (`POST /api/bot/command` → `{reply}`) is runner-agnostic and the §3.6 forbidden-list makes that testable. Two items flagged for on-device verification before implementation (Rhino HMAC support; `bot.send` to a cold room). |
| R1-C | Next.js scaffold + PipelinePro tokens + TanStack Query + KST week utils | **DONE** | repo root, `src/**` | Conductor ran `pnpm typecheck` / `lint` / `build` independently — all exit 0. Read `week.ts` and confirmed the epoch-day-0-is-Thursday truncation and ISO week formula are correct. Diffed `globals.css` against `pipelinepro-DESIGN.md`: colors, type scale, radius, all 5 elevation levels match. `.gitignore` still has the `.serena`/`serena`/`git` lines. 0 raw hex in `src/**/*.ts(x)`. |

## Round 2 — design (blocked on R1-A, R1-B)

| # | Unit | State | Output | Verification |
|---|---|---|---|---|
| R2-A | Architecture: auth model, API adapter layer, TanStack Query cache conventions, bot adapter | TODO | `Claude/ARCHITECTURE.md` | conductor read + cross-review |
| R2-B | DB schema: tables, RLS, invite/pending-member flow, weekly income rollup | **VERIFIED** | `Claude/DB-SCHEMA.md`, `supabase/migrations/2026081709*.sql` (9 files) | **Conductor re-ran verification independently** in an isolated PGlite instance (agent's own harness was not reused; project `package.json` left clean). All 9 migrations apply, twice → idempotent. **28 tables / 28 with RLS enabled / 83 policies** — zero gaps. `week_key` SQL vs the *project's actual* `src/lib/time/week.ts` (compiled with tsc, not reimplemented): **4,900 samples, 0 mismatches**, including ±1 ms probes around 300 Thursday boundaries. `set role anon` → all 7 sampled private tables denied. Migration 090000 also carries self-verifying DO blocks that abort the migration if the Wed/Thu boundary is ever wrong. |
| R2-C | Payout shares (`share_bp`) + other-drop income + `seat_no` | **REWORK** | `supabase/migrations/20260817091000_*.sql`, `Claude/DB-SCHEMA.md` | Conductor re-verified in isolated PGlite: 10 migrations × 2 passes, 30 tables all RLS, 16 views, week_key 2,400 samples 0 mismatch. Payout math confirmed exact — equal 6-way = 8,583,333 each (identical to the game's `floor(base/6)`), 33:67 sums to pot with **0 meso lost**, 3/7/11-way equal splits exact, deterministic, 0-and-1-meso edges correct. The agent's own catch on basis-point precision was right: a `1667/10000` approximation would have been off by 1,716 meso. **One defect found: `share_bp` is readable by `anon`** — see B-5. Sent back for fix. |
| R2-C fix | Column-privilege lockdown + permanent guard | **VERIFIED** | `20260817091100_*.sql` | Conductor confirmed: `run_signups.share_bp` and `.note` now denied to anon. **The guard was tested adversarially** — granting `share_bp` to anon makes `assert_no_public_sensitive_columns()` raise; revoking it makes it pass again. Agent chose *column-level* GRANT over a view precisely because column grants do **not** auto-include later-added columns, so the failure mode is structurally dead. Re-audit closed 5 more leaks (`parties.owner_user_id`, participant UUIDs, `party_runs.share_mode`). Whitelist has 5 entries, each justified in-line; conductor reviewed all 5 and they hold. |
| R2-D | Recurring weekday availability + dated exceptions + overlap query | **VERIFIED** | `20260817091100_*.sql`, `Claude/DB-SCHEMA.md` | `resolve_availability` / `availability_overlap(p_min_count)` / `can_view_availability` all present. Minute-based columns confirm the midnight-crossing choice (`end_minute > 1440`, so 22:00–02:00 stays one row and keeps its intent). **`availability_slots` dropped** — one person's availability must have exactly one source of truth. |
| R2-F | Multi NEXON account linkage | **VERIFIED** | `20260817091200_*.sql` | Conductor inserted a user with a primary + linked credential and resolved login by hash from **both**: same `user_id`, same main-character identity — the user's explicit requirement holds. `characters` points at the *account*, not the key, so key reissue does not orphan characters; `v_character_sync_source` walks account → currently-valid key for API calls. |

## Round 2.5 — availability model (queued; starts when R2-C lands to avoid table collisions)

| # | Unit | State | Output | Verification |
|---|---|---|---|---|
| R2-D | Recurring weekday availability + dated exceptions | TODO | `supabase/migrations/20260817092000_*.sql`, `Claude/DB-SCHEMA.md` | conductor PGlite re-run |

Spec for R2-D (from the user, see `CLAUDE.md` §1.4):
- `availability_patterns` — recurring, **per weekday** time ranges, owned by the *person* (not the
  character; a person's schedule is not per-character). Multiple ranges per weekday allowed.
- `availability_exceptions` — dated override for a single KST date: either "unavailable that day"
  or "these hours instead", plus a free-text note (특이사항).
- A resolver (DB function or view) that returns effective availability for a given date range by
  applying exceptions on top of patterns. Web and the Kakao bot must get identical answers, so this
  logic lives in exactly one place.
- Reconcile with the existing `availability_slots` table — decide whether it becomes the resolved
  output, is replaced, or is kept for one-off slots. State the choice and why.
- Overlap query: given N selected members and a date range, return time windows where all (or
  k-of-N) are free. This powers the left pane of the core screen and must be indexed for it.

## Round 2.6 — tooling (parallel, no schema overlap)

| # | Unit | State | Output | Verification |
|---|---|---|---|---|
| R2-E | NEXON API probe CLI — measure real responses, fill the "미확인" list, detect spec drift | **VERIFIED (minor rework)** | `scripts/nexon-probe/**`, `Claude/NEXON-API-OBSERVED.md` | Conductor verified from **outside** the tool by preloading a `globalThis.fetch` wrapper as a separate `--import`, so the tool's own selftest could not vouch for itself. Results: dry-run with a key present → **0 fetches**; fake key + `--yes` → **exactly 1 API call**, `OPENAPI00005`, then every remaining probe skipped, exit 0 (no wasted quota); 9 spec-YAML fetches correctly counted separately from quota. **Key leakage: 0** in console, 0 in output files, 0 in request URLs — key travels only as a header. Gates pass, `--selftest` 14/14, zero new dependencies (lockfile untouched). One defect sent back: the no-key path does not regenerate its own output doc, so a stale header survives in a committed file. |

Why it exists: every remaining unknown from R1-A/R1-D/R1-E is answerable by one authenticated call
(`difficulty`/`cycle` value strings, `weekly_boss_clear_limit_count`, error codes, real data lag).
Re-running it after a game patch turns it into a drift detector against the published OpenAPI YAML.

Safety rails demanded in the brief, because it spends the user's own API quota:
throttle ≤2 req/s (dev limit is 5/s), hard budget of 100 calls (dev keys get 1,000/day),
immediate abort on 429, `--dry-run` default-safe, and the key must never be printed, logged, or written.

**Doc-overwrite rule (conductor-verified).** Two requirements collided — the header must describe the
run that produced the doc, *and* a keyless run must not erase real measurements. The agent resolved it
with a monotonicity rule: `measured` > `placeholder`, and a doc never gets overwritten in the direction
of less information. Grade is stored in a first-line HTML marker inside the committed doc itself
(`.nexon-probe-out/` is gitignored and vanishes on a fresh clone, so it cannot be the source of truth).
No marker ⇒ treated as human-written and preserved. `--dry-run` writes nothing at all — a mode whose
contract is "zero side effects" must not touch files. Conductor tested all three paths directly:
a fake `measured` doc survived a keyless run byte-for-byte, a marker-less hand-written doc survived,
and a `placeholder` doc correctly refreshed to `mode=no-key`.

## Round 2.7 — notification routing, exception simplification, number unification

| # | Unit | State | Output | Verification |
|---|---|---|---|---|
| R2-G | Party↔room binding, creator, notification composition + outbox | **VERIFIED** | `20260817091300_*.sql` | Destination is the **room, not the person** — routing by person would spam every room a member sits in. Callers must go through `party_notify_channel_ids(party_id)` (returns 0..N) rather than reading `bot_channel_id`, so widening past 1:1 later costs nothing. Enqueue is split: DB owns the rule, server owns the timing — an insert trigger would freeze the notice string before the roster fills and ship `(모집중)`. Guard extended with `%channel%`/`%room%`; conductor confirmed opening `parties.bot_channel_id` to anon makes the migration fail, and that it is closed in the shipped schema. |
| R2-H | Availability exceptions → subtraction only | **VERIFIED** | `20260817091100_*.sql` (rewritten) | `kind` enum, the replacement path, and a partial unique index all deleted — the code shrank, as it should when a requirement narrows. Implemented as **multirange subtraction** (`range_agg(pattern) - range_agg(exception)`) over absolute instants, so midnight crossing needs no special case at all. Conductor reproduced the reported bug end-to-end: pattern Wed 22:00→Thu 02:00 with **Thursday excluded** now yields only Wed 22:00–24:00 (the Thursday spillover is gone), and the symmetric case with **Wednesday excluded** leaves only Thu 00:00–02:00. |
| R2-I | Management numbers unified | **VERIFIED** | `20260817091400_*.sql` | `run_signups.seat_no` **dropped**; one `party_participants.member_no` instead — run participants are always a subset of party participants, and "1번" in `!분배 1번 33` names a *person*, not a signup. Three surviving numbers sit on genuinely different axes: `party_no` (room × week), `run_no` (per party), `member_no` (per party). `run_no` deliberately excludes the week so pushing a run to next week neither renumbers nor collides. Conductor confirmed `seat_no` is absent and `member_no` present in the final schema, and that `member_no` is anon-readable (display) while `bot_channel_id` and `share_bp` are not. |

## Round 3 — implementation (blocked on R2)

| # | Unit | State | Output | Verification |
|---|---|---|---|---|
| R3-UI | PipelinePro component kit + domain components + showcase | **VERIFIED (gates pending)** | `src/components/ui/**`, `src/components/domain/**`, `src/app/page.tsx` | 19 component files, **0 raw hex** in `src/`. Agent found and fixed a genuine silent bug: `tailwind-merge` did not know the PipelinePro tokens and was **deleting** classes — `text-surface` vanished from Primary buttons (white-on-indigo lost), `text-label` from selected FilterChips, and `<Card className="p-0">` failed to override `p-pad-lg`. Conductor wrote an independent regression test against `cn()`: all four bug cases fixed **and** normal same-group merging still works (over-registering tokens could have broken legitimate merges — it didn't). `formatMesoCompact` ko-KR output verified: `324000000 → "3억 2,400만"`. Gates re-run after the concurrent probe edit landed: `typecheck` / `lint` / `build` all clean. **DONE.** |
| R3-CHAR | Character picker modal (top 12 by level, 6×2) + dialog primitive | **VERIFIED** | `src/components/ui/dialog.tsx`, `src/features/characters/**` | Native `<dialog>` + `showModal()` chosen over a hand-rolled trap — the browser guarantees focus trap, Esc, initial focus, focus restore, and top-layer stacking; only backdrop-click and scroll-lock were added. Backdrop close fires on `mousedown`, not `click`, so a drag started inside the panel and released outside does not close it. Conductor independently recomputed the top-12 from the 59-character mock: level set matches, cut is unambiguous (12th = 284 > 13th = 283), and the result is identical across 200 input shuffles — deterministic, as required since `localeCompare` was deliberately avoided (ICU version can differ between server and browser). |
| R3-ROUTES | `/` becomes the app entry, showcase moves to `/showcase` | **VERIFIED** | `src/app/page.tsx`, `src/app/showcase/page.tsx` | `/` renders with no auth or session read, carries the required NEXON attribution, and links to `/showcase` zero times. Public timetable deliberately not faked — inventing plausible data would read as a requirement to whoever picks this up next. |
| R3-DEVFLAG | Dev-tool visibility moved off `NODE_ENV` | **VERIFIED** | `src/lib/env-flags.ts` | Opt-in `NEXT_PUBLIC_DEV_TOOLS=1` replaces `NODE_ENV !== "production"`, which is fail-open and frozen into the bundle at build time. Default is off everywhere including dev servers. Verified on a clean port: `/`, `/schedule`, `/showcase` all render 0 dev-instrumentation strings; rebuilding with the flag brings them back, proving the instrumentation was gated rather than deleted. |
| R3-A | Supabase migrations applied + generated types | **DONE** | live DB `hryikreaxngexhjjxfyl`, `src/types/database.ts` | All 15 migrations applied one at a time (never batched, so a failure would name its own file). Conductor queried the live DB directly: **33 tables / 33 with RLS / 17 views / 90 policies — identical to the PGlite figures**, and PG 18 → **17.6** surfaced zero compatibility problems. `week_key` boundary confirmed on the real server (Wed 23:59:59 → `2026-W33`, Thu 00:00:00 → `2026-W34`). anon column privileges hold: `share_bp` false, `bot_channel_id` false, `member_no` true. Types generated from the live schema; `pnpm typecheck` clean, no clash with `src/types/domain.ts`. Note: Supabase reassigns migration version numbers by apply time, so file names and recorded versions differ — matters if `supabase db push` is used later. |
| R3-HARDEN | `search_path` pinning + FK indexes | **VERIFIED** | `20260817093000_*.sql` | `function_search_path_mutable` **42 → 0**; conductor confirmed **44/44** public functions now carry `search_path`, with table/view/policy counts unchanged at 33/17/90. The agent caught a trap worth recording: this project's default path is `"$user", public, extensions` and **pgcrypto/uuid-ossp live in `extensions`** — pinning to `public, pg_temp` would have broken any unqualified `digest()`/`gen_random_bytes()` call. They scanned `pg_depend` plus plpgsql bodies and proved zero such references *before* applying. FK indexes: 16 created (14 as partial `where col is not null`, since NULL entries never serve a referential check), 3 deliberately skipped on permanently-small children — each decision recorded with its reason. Remaining security advisors: **2, both `rls_auto_enable`**, a pre-existing Supabase platform object, not ours. |
| R3-SEED | Dev seed data on the live DB | **VERIFIED** | `scripts/seed-dev/**`, `pnpm seed:dev` | 163 rows across 14 tables. Conductor re-queried the live DB: counts match, **boss master untouched** (32/78/201), schema objects unchanged (34/34/92), and party visibility now spans `public`/`private`/`link` so the logged-out board is actually exercisable. Two behaviours confirmed by direct query rather than by report: (a) 진서's Fri 23:00→Sat 03:00 pattern with a Sat 00:00–01:00 exclusion resolves to **exactly two fragments** with the hole in the right place; (b) the two Velona clears keep `base_price_meso` and `crystal_share_meso` **null, not 0**. Deletion targets an enumerated id list, not a `like '5eed%'` scan, so a real user row that happened to share the prefix could never be caught. Script refuses to run if `.env.local`'s project ref is not `hryikreaxngexhjjxfyl`. |
| R3-B | Auth: API-key login, session, NEXON proxy | **VERIFIED** | `src/lib/nexon/**`, `src/app/api/{auth,nexon}/**`, `src/features/auth/**` | Login is one `/character/list` call (validity + owned characters together). Conductor confirmed on the live DB: user `더저` created once, **re-login reuses the same `user_id`** (59 characters, 59 distinct ocids, no duplication), `api_key_hash` is 64-hex and `encrypted_api_key` is null — the raw key is nowhere in the DB. A key already bound elsewhere is refused with **409**. Session is an HMAC-signed httpOnly cookie; `secure` is decided from the **request protocol**, not `NODE_ENV`, which would freeze into the bundle and break local http. |
| R3-C | Schedule screen wired to the live DB | **VERIFIED** | `src/features/schedule/server/schedule-repo.ts`, `src/app/api/schedule/**` | Reads happen server-side (the page imports the repo directly — no HTTP round trip to our own API); writes go through Route Handlers with session checks. Overlap, availability and visibility all delegate to `resolve_availability` / `availability_overlap` / `can_view_availability` and the `v_*` views — **nothing recomputed app-side**, so web and the future bot cannot drift. Screen output matched the DB ground truth exactly: Sat 21:00–23:00 · 6 and Sun 22:00–23:00 · 6, plus 진서's midnight-crossing pattern split into two fragments by its exception. All 14 exported signatures in `schedule-queries.ts` survived; **8 of 9 schedule components are byte-identical**, the ninth changed one import line. |
| R3-CHARS | Character tracking persisted | **VERIFIED** | `src/app/api/characters/**`, `src/features/characters/**` | `is_tracked` and `is_main` write through to the live DB and `app_users.main_character_name` follows via trigger. The picker lists from **our own `characters` rows, not NEXON** — login already stored all 59, and the NEXON response carries no PK to save against; NEXON is called only for the 12 visible portraits. A 429 hazard was caught by measurement: 12 concurrent portrait queries against a 5-req/s dev key produced **7×429**, and the gateway then put the whole key in a 60-second cooldown — a client-side 250 ms pacer fixed it (11/11 succeed). The durable fix belongs in `gateway.ts`, since a pacer cannot see other tabs or the bot. |
| R3-D | Friends + link-based invite + pending-member claim | TODO | `src/features/friends/**` | Schema and `claim_guest_profile()` already exist; only the UI is missing. |
| R3-E | Weekly income screen | TODO | `src/features/income/**` | `v_weekly_income`, `v_run_crystal_settlement`, `v_weekly_unsold_drops`, `distribute_meso` are live and correct but **have no caller yet**. |
| R3-F | Kakao bot command endpoint | TODO | `src/app/api/bot/**` | `format_run_notice` / `enqueue_run_notice` / `bot_outbox` are live and waiting. Blocked on B-4 (user's decision on ban risk). |
| R3-G | Weekly chores (lowest priority) | TODO | `src/features/chores/**` | — |

### Known gaps carried forward

- `PUT /api/characters/tracked` runs three sequential updates with **no transaction** (PostgREST has none); a mid-way failure leaves tracking cleared. A DB function would fix it.
- `share_mode='manual'` runs show an **even-split estimate** on screen. `v_run_crystal_settlement` only settles *cleared* runs, so a 33:67 run's pre-clear estimate has no DB counterpart.
- `visiblePersonIds` calls `can_view_availability` once per person, per query — 18 round trips for a 6-person party. Correct, but wants an array-argument DB function.
- Seed data cannot exercise "switch between 4 parties": no single user belongs to more than 2, so 3 is the visible maximum.

## Round 4 — integration verification

| # | Unit | State | Output | Verification |
|---|---|---|---|---|
| R4-A | Full DoD sweep + cross-review | TODO | — | `CLAUDE.md` §0.3 |

---

## Open blockers requiring the user

| # | Blocker | Detail |
|---|---|---|
| B-1 | Supabase MCP needs OAuth | `.mcp.json` declares a project-scoped HTTP MCP server pinned to `hryikreaxngexhjjxfyl`; `claude mcp list` parses it and reports "Pending approval". OAuth cannot run in this non-interactive session — user must restart and authorize via `/mcp`. Migrations are authored as files meanwhile, so only *application* is blocked, not authoring. |
| B-2 | ~~Supabase keys~~ **RESOLVED** | `.env.local` created with real keys (gitignored, verified via `git check-ignore`). Live probe: publishable key → `PGRST205` 404 (auth passed), secret key → 200 with full OpenAPI doc. `public` schema currently holds no tables, only an `rls_auto_enable` RPC. |
| B-5 | ~~`share_bp` leaks to anon~~ **being fixed** | `20260817090800_rls_policies.sql:261` grants `select` on the whole `run_signups` table to `anon`. RLS filters rows, never columns, so once migration 10 added `share_bp` to that table the payout ratios became publicly readable for any `visibility='public'` party. Confirmed via `has_column_privilege('anon','public.run_signups','share_bp','select') = true`. **Structural cause**: the RLS migration runs before later migrations that add columns to already-granted tables, so any future sensitive column leaks silently. Fix ordered includes a permanent DO-block guard that fails the migration if `anon`/`authenticated` ever hold SELECT on `%share%`/`%meso%`/`%_bp`/`%secret%`/`%hash%`/`%token%`/`%api_key%` columns, with explicit whitelisting required for intentional exceptions. |
| B-4 | KakaoTalk account-ban risk — **needs user decision** | Kakao's operating policy explicitly bans bot/macro programs and unofficial protocol/API calls, with penalties extending to *all* KakaoTalk services; there is a 2021-03-03 precedent where bot accounts **and their owners' main accounts** were suspended. Rooms themselves can be sanctioned, affecting other members. Not removable by design. Mitigation: sub-account + dedicated device, and never distributing the runner ourselves. Recommended sequencing puts the Kakao leg last so no work is wasted if declined. |
| B-3 | NEXON ToS Article 5 exception list | Whether the scheduler API is on the "may be provided to others" allowlist is unverified — the list requires a NEXON login. Decides the legal footing of holding user API keys. Design proceeds with the lowest-risk shape (hash identity, client-side key) meanwhile. |

## Assumptions on record

- A-1: Game is MapleStory, NEXON Open API — confirmed by user.
- A-2: Kakao notifier is a dedicated KakaoTalk account acting as a bot inside a chat room, driven
  by `!`-prefixed commands (`!일정`, `!결정석`, …) — clarified by user mid-Round-1. Command→response
  is primary, push is secondary. R1-B was redirected accordingly. See `CLAUDE.md` §2.2.
- A-4: Package manager is pnpm — restated by user, already locked in `CLAUDE.md` §2.
- A-3: App lives at repo root (not a subfolder). `serena/` and `.serena/` are unrelated and off-limits.
