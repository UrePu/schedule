# M_Schedule — MapleStory Boss Party Scheduler

## 0. Standing Operating Protocol — active from the start of every session

In this repository Claude acts as the **Conductor / PM**.
This protocol applies automatically; the user does not need to restate it.

### 0.1 Role boundaries

- The main Claude loop **does not implement.** Writing, editing, or deleting code, authoring
  migrations, and writing tests are all delegated to subagents (Agent tool).
- The main loop does: interpret requirements → decompose work → write agent briefs →
  **inspect deliverables directly** → order rework → report to the user → update tracking docs.
- Exceptions the main loop may do itself: reading/searching files, status commands,
  typo fixes of three lines or fewer, updating tracking docs under `Claude/`, and small
  repo-housekeeping config edits (`.gitignore`, `.mcp.json`) where delegating costs more than doing.

### 0.1.1 Use serena for existing TypeScript

Once a file exists, prefer serena's symbol tools over reading and rewriting whole files. Say so
explicitly in agent briefs — agents default to plain file tools otherwise.

- `get_symbols_overview` before reading a file you don't know.
- `find_symbol` to jump straight to a function/class instead of reading the whole file.
- `find_referencing_symbols` **before changing any exported signature** — this is the cheap way to
  catch every call site, and skipping it is how signature changes silently break callers.
- `replace_symbol_body` / `insert_after_symbol` for edits scoped to one symbol.
- `rename_symbol` for renames, never a text find-and-replace.

It buys nothing when creating brand-new files, and it does not cover SQL, Markdown, or CSS — the
project's language server is TypeScript only. Use ordinary tools there.

### 0.2 Execution cycle — applied to every unit of work

1. **Decompose** — split the requirement into independently executable units. Fix the output
   file paths for each unit up front.
   - ★ **Sweep for every place the same fix belongs — this is a standing owner instruction**
     (2026-08-18): *"하나 수정할때 비슷하게 적용할부분이 있다면 찾아서 같이 적용하는걸 기본
     프롬프트로 적용해."* A report names **one symptom**; the same defect is almost always
     repeated in sibling files. Before writing the brief, search the repo for those siblings and
     enumerate them in the `[동일 적용]` field (§6). Fixing only the reported instance makes the
     user file the same complaint three more times — that already happened with the repeated
     warning block on the income screen and with `tabular-nums` after the font swap.
     If a search genuinely finds no siblings, **say so in the brief**; never leave the field blank.
2. **Delegate** — spawn a subagent per unit. Units with no dependency on each other are spawned
   **in parallel in a single message.** If file collisions are likely, partition file ownership
   explicitly in the briefs — name both what the agent owns and what it must not touch.
   - **Never delegate a unit whose files another live agent still owns.** An agent that reports
     "done" may have spawned children that are still writing; a second wave launched over them
     produced two complete implementations of the schedule server layer, a broken tree, and an
     hour of cleanup. Confirm the previous unit's files have stopped changing before re-delegating.
   - **Tell subagents not to spawn their own subagents.** Nested delegation is where ownership
     boundaries get lost.
3. **Inspect** — the main loop **reads the produced files itself** and grades them against the DoD
   below. An agent's "done" report is not evidence. Build/typecheck pass only counts when backed
   by an actual command log.
   - **When verifying a running server, prove you are talking to the server you started.**
     A stale `next dev` on port 3000 already caused a false defect report: `pnpm start` died with
     `EADDRINUSE`, the backgrounded log went unread, and every `curl localhost:3000` hit the dev
     build instead. Start on an explicit unused port (`PORT=3100 pnpm start`), then **check the
     server log for bind errors before trusting a single response.**
4. **Re-verify** — spawn a **different** subagent to cross-check (implementer ≠ verifier).
   Instruct the verifier to hunt for defects; never phrase it in a way that invites a pass verdict.
5. **Order rework** — on any shortfall, re-delegate with a **concrete defect list including
   file:line**. Repeat 3→5 until it passes. If the same defect recurs twice, the brief is at
   fault — rewrite the brief, not the instruction.
6. **Report** — report only passing results to the user, concisely, **in Korean**. Never hide
   incomplete items; state them explicitly.

### 0.3 Definition of Done — not done until all of these hold

- [ ] `pnpm typecheck` clean
- [ ] `pnpm lint` clean
- [ ] `pnpm build` succeeds
- [ ] Every new DB object has an RLS policy (except deliberately public-read objects, whose
      policy must still be written out explicitly)
- [ ] **Every new migration ends with `select public.assert_no_public_sensitive_columns();`**
      RLS filters rows, never columns, and a table-wide GRANT silently swallows columns added by
      later migrations — that is exactly how `share_bp` leaked once. Intentional exposure goes in
      that function's whitelist **with a written justification**, never by omitting the call.
- [ ] Design tokens (§4) used instead of hardcoded colors
- [ ] Loading, empty, and error states all exist in the UI
- [ ] Server time logic matches the **KST Thursday 00:00 weekly reset**
- [ ] Screens meant to be viewable while logged out actually open while logged out

### 0.4 Stop conditions — ask the user and halt ONLY for these

- Credentials, API keys, billing, or external account approval are required
- Hard-to-reverse destructive actions (data deletion, force push, outbound sending)
- Requirements contradict each other such that any assumption makes the output useless

Otherwise **do not stop**: pick a reasonable default, proceed, and state the assumption in the report.

### 0.5 Progress tracking

- Keep status in `Claude/PROGRESS.md`: per work unit — state / round / output files / verification result.
- Design docs live under `Claude/`. Code lives under `src/`. When design and code diverge,
  **fix the design doc first**, then the code.

---

## 1. Domain background — required prior knowledge

This is a scheduler for organizing MapleStory boss parties. The following are domain constants
and are assumed throughout the codebase.

- **Weekly reset: every Thursday 00:00 KST (Asia/Seoul).** Daily reset: every day 00:00 KST.
  All week-bucket math must use this boundary. Never compute it in UTC.
- **Boss Crystal (결정석)**: guaranteed drop on any boss clear, exchanged for meso. A user registers
  "I'm going to this boss", and once marked cleared the value must **automatically roll into that
  week's income**. Pricing rules (settled by `Claude/research-BOSS-DATA.md`, cross-verified):
  - Listed prices are **solo prices**. Actual payout is `floor(price / party_size)`, split by the
    party size **at the moment of entry**. Omitting party size overstates income by up to 6×.
  - Max party differs per boss: legacy bosses 6, newer bosses 3, **Extreme Seren-era Su 2**.
    Store `max_party` on the boss master and use it as the input bound.
  - Weekly crystal sales cap: **12 per character**, and since the 2025-08-21 patch a 13th weekly
    boss **cannot be entered at all**. So weekly income is a plain sum in practice — keep a
    `limit 12` on the price-descending sort purely as a defensive guard, and do **not** build
    sale-order tracking or recalculation caches for it.
  - The 12-cap is **per character**. A user's weekly total is the sum across their characters.
  - ⚠️ **A weekly boss can be exempt from the 12.** Season/event bosses arrive from NEXON as
    `cycle: bossWeekly` yet do not consume a crystal slot — 메이린 is the live example
    (owner, 2026-08-25: *"메이린도 기록 해 시즌이지만 도는 보스잖아."*). **Confirmed
    directly 2026-08-26**: *"메이린은 12칸에 안막혀. 주간보스는 12개를 돌아도 추가로
    메이린을 잡을수있음"* — clearing 12 weekly bosses does not block entry. The master carries
    `boss_difficulties.counts_toward_weekly_limit`, and **every 12-slot tally must read that flag,
    never `cycle` alone.** Counting an exempt boss makes the checklist say `13/12` and — worse —
    makes the nightly sync treat the character as full and skip it, so the very boss we added
    never gets recorded. The nightly skip therefore has the same exception it already had for
    monthly bosses.
  - Daily-boss crystals do **not** count toward the 12. A separate cap of 90/week covers
    daily + weekly + monthly combined, and that cap is **per NEXON account, not per world**
    (owner correction, 2026-08-18). The two caps never interfere: daily and weekly crystals
    are counted on separate ledgers, so excluding daily bosses cannot move the 12 counter.
  - Crystals stay valid for **one week after acquisition**, which means a clear can legitimately be
    sold after the following Thursday reset, consuming *that* week's 12-slot counter. We do not
    model this — see §1.3 D1.
  - Prices change only by patch (the ±3% market-fluctuation system has been off since 2024-01-04),
    so a constant table is sufficient. Snapshot the paid amount on each clear record so a later
    price patch never rewrites past income.
- **Boss party**: most weekly bosses are run as a group. Overlaying "when is each person
  available" onto one timetable is the core value of this app.
- **Runs are per character, not per person.** A player brings a specific character to a specific
  boss, and the 12-per-week crystal cap is counted **per character** — so a signup that only records
  "who" cannot compute income correctly. Registering a run must capture **which character** goes.
- **Each character has a standing weekly boss list** ("this character runs these bosses every week").
  That is what the in-game scheduler's `registration_flag` expresses per character, and it is the
  natural place to warn about the 12-boss ceiling. Store it; do not re-derive it from clear history.
- **Weekly chores (주간 숙제)**: recurring tasks other than crystals. Secondary feature, lower
  priority than boss scheduling.

### 1.0 Measured API facts — from a live key, 2026-08-17

Full record: `Claude/NEXON-API-OBSERVED.md` (regenerate with `pnpm probe --yes`). Decisive values:

- `boss_contents[].difficulty` = **`easy` `normal` `chaos` `hard` `extreme`** — lowercase English,
  which already matches our `boss_difficulty_tier` enum exactly.
  - **`destiny` is NOT a sixth tier and must never be added to the enum.** A boss-icon set the owner
    supplied carries `destiny_*` art for 대적자 · 발드릭스 · 카링 · 칼로스 · 림보 · 세렌, which looks
    like a missing difficulty. It is not: 데스티니 is **quest content**, not a boss entry
    (owner-confirmed, 2026-08-18). Those icons are deliberately dropped. Do not re-open this.
- `boss_contents[].cycle` = **`bossDaily` `bossWeekly` `bossMonthly`** — camelCase with a `boss`
  prefix, which does **not** match our `boss_cycle` enum (`daily`/`weekly`/`monthly`). Map it.
- `content_name` is the **Korean boss name** (`더스크`, `스우`, `카링`, …) — this is the join key
  into our boss master via `bosses.nexon_content_name`.
- All flags are **strings** `"true"` / `"false"`, never booleans. Parse accordingly.
- `weekly_boss_clear_limit_count` = **12**, confirmed live.
- **No rate-limit headers exist.** We must count our own calls.
- `date` lookback: 1 day OK, 7 days OK, **30 days rejected** (`OPENAPI00004`). Exact bound unmeasured.
- Error codes — several earlier *estimates* were wrong, use these:
  unknown character name → `OPENAPI00004` · bad ocid → `OPENAPI00003` ·
  unknown path → **403 `OPENAPI00002`** · another account's ocid on scheduler → `OPENAPI00004`.
- This account: `account_list` length 1, **59 characters** across 8 worlds. A full scheduler sync is
  therefore ~59 calls; a dev key's 1,000/day allows roughly 17 full syncs per day. Budget for it.
- Spec drift check against the 8 published OpenAPI YAMLs: **0 mismatched fields.**

### 1.1 What the NEXON API can and cannot give us — VERIFIED, do not re-litigate

Established by `Claude/research-NEXON-API.md` and independently re-verified against the official
OpenAPI spec and live HTTP probes. Treat as settled fact.

**Available from the API:**
- `GET /maplestory/v1/scheduler/character-state` — the in-game scheduler. `boss_contents[]` carries
  `content_name`, `difficulty`, `cycle`, `registration_flag` ("I intend to run this boss"),
  `complete_flag`, plus `weekly_boss_clear_count` / `weekly_boss_clear_limit_count`.
- `GET /maplestory/v1/character/list` — key validity **and** owned-character list in one call.
- `GET /maplestory/v1/guild/basic` → `guild_member[]` — the only public path to discover other players.

**NOT available — must be built by us:**
- **Time of day.** The in-game scheduler is a checklist, not a timetable. There is no hour field
  anywhere in the spec. The app's #1 value (a merged timetable) is 100% ours to build.
- **Other people's schedules.** Spec text: "자신의 계정에 속한 캐릭터만 조회가 가능합니다."
  A user's key reads only their own account's characters. Overlaying multiple people's intent is
  therefore driven by **in-app registration, never by the API**.
- **Party / friend relationships.** No such API exists.
- **Boss crystal prices and meso income.** Absent from the entire API. Maintained as our own
  constant table, updated manually on game patches.
- **Historical week-by-week records.** `complete_flag` is current state only.

**Hard constraints:**
- Data lags **up to** ~15 min — but **not on a fixed timer.** It refreshes **immediately when the
  character logs out or enters the cash shop** (owner, 2026-08-24). So 15 minutes is the worst case
  for someone still standing in-game, not a delay everyone always pays. Previous-day data lands next
  day 02:00 KST. → TanStack Query `staleTime` must be **at least 15 minutes**; anything shorter burns
  quota for no new data on the *automatic* paths.
  ⚠️ Design consequence: an **explicit user refresh must bypass the 15-minute server cache**
  (`createNexonGateway({ bypassCache: true })`, reached via `force: true` on the sync endpoint).
  Without it the button lies — the gateway's cache *read* ignores TTL, so pressing refresh right
  after an automatic sync returns the same stale bytes without calling NEXON at all. Automatic paths
  (entry sync, nightly cron, post-run sync) must **not** bypass, or the cache has no reason to exist.
- `ocid` is explicitly documented as mutable. **Never use it as a primary key** — own UUID PK,
  `ocid` as a refreshable column.
- Rate limit: dev key 5/s and 1,000/day; service key 500/s and 20,000,000/day, summed per application.
- Errors: `{"error":{"name":"OPENAPI00005","message":"..."}}`. Key validation precedes path
  validation. `OPENAPI00005` = invalid key, `OPENAPI00007` = 429 quota.
- Empty scheduler response means "character didn't log in that day" — render as an empty state,
  **never as an error**.
- **Attribution is mandatory**: the UI must display "Data based on NEXON Open API".

### 1.1.1 Screens are grouped 현황 / 관리 — there is no dashboard

**The dashboard was deleted on 2026-08-20** (owner: *"대시보드를 삭제하고"*). It had become five
cards stacked on one screen, four of which repeated something another screen already said better.
Navigation is now two dropdown groups, and the axis that splits them is **"came to look / came to
change"** — read-only and daily on one side, writes and occasional on the other:

```
현황  ├ 이번주 일정 `/`            ├ 계정 보스 현황 `/boss-status`
      ├ 결정석 수익 `/income`      └ 기타 숙제 `/chores`
관리  ├ 파티 관리 `/parties`       ├ 일정 관리 `/schedule`
      ├ 캐릭별 보스 관리 `/boss-plans` ├ 친구 `/friends`   └ 기타 `/etc`
```

**`/` is the week timetable and answers exactly one question**: *"나 언제 어디로 보스 가야 하지?"*
(owner). Weekday columns 목→수 (the reset boundary is the left edge), time on the vertical axis,
one block per **contiguous run group** — not per run, because three 20-minute bosses back to back
are one 22:00~23:00 commitment, not three slivers. Each block carries the **boss faces**, the
**party name**, and **the character I am bringing**. Nothing else. Only runs where the viewer has a
`going` signup appear.

**파티 관리와 일정 관리는 갈라져 있다 — owner, 2026-08-25** (*"일정짜기를 두가지로
분리하자. 파티 관리 + 일정관리."*). One screen used to ask **"누구와 무엇을"** and
**"언제"** at the same time, which is what made it "너무 헷갈리게 되어있"다.
- `/parties` — 파티 만들기·구성원·묶어서 도는 보스·분배 배율. Creation is a **4-step
  wizard** (이름 → 파티원 → 갈 보스 → 분배); the 분배 step can only exist *after* the
  party is saved, because share ratios hang off `party_participants.id`.
- `/schedule` — the availability overlay owns the **whole page**, and run registration is
  a **3-step modal** (시간(고정) → 보스 → 참여자). Later steps depend on earlier ones:
  the boss count sets total duration, and the participant count is the 1/n denominator.
- Both are one component (`ScheduleWorkspace`, `mode` prop). The data and the mutation
  invalidation lists are the same; only what is drawn differs. Splitting the component
  would duplicate ~400 lines of mutation wiring and let the two screens drift.

`/etc` exists because the settings buttons (tracked characters · API keys · KakaoTalk room ·
logout) had no other entrance once the dashboard header was gone. They are setup, not daily use.

Measured live on 2026-08-17 for one character (`/scheduler/character-state`, HTTP 200):

```
weekly_boss_clear_count / limit = 10 / 12
boss_contents = 77 entries · registration_flag=true 12 · complete_flag=true 10
remaining (registered ∧ ¬complete):
  bossMonthly extreme 검은 마법사 · bossWeekly hard 최초의 대적자 · bossWeekly normal 유피테르
weekly_contents = 22 (now_count / max_count / quest_state) · daily_contents = 18
```

So the API already knows both the **plan** (`registration_flag`) and the **progress**
(`complete_flag`) per character — the user does not have to build the list by hand. That is what
**계정 보스 현황** (`/boss-status`) draws:

- `보스 N/12` from `weekly_boss_clear_count` / `weekly_boss_clear_limit_count`
- **the bosses still to clear**, listed — registered but not complete. A to-do list, not a trophy case.
- weekly contents (주간 숙제) and daily bosses, grouped separately; **only weekly bosses count toward 12**
- one section per tracked character, since the 12-cap is per character
- **The weekly-boss denominator is `tracked_characters × 12`, never a bare 12.** The 12-cap is *per
  character* (§1), so a total that sums every character against a per-character limit renders
  nonsense — the live screen showed **`40 / 12건`**. With 6 tracked characters the ceiling is 72.
  Keep the arithmetic this obvious; do not reintroduce the 90-per-account ceiling here (owner
  decision, 2026-08-18 — see D2, which stays documented but is not what this screen leads with).
- **It syncs on entry, once, and only when the data is stale.** NEXON data lags ~15 min, so a call
  inside that window returns the same bytes and buys nothing but quota. Skip when fresh, never block
  the render, and keep the manual refresh button for "I just cleared it, update now". Budget math to
  respect: one call per tracked character, and a dev key gets 1,000 a day.
  **This is the only screen that syncs *all tracked characters*.** `/chores` reads the same snapshot
  and must not sync too, or one visit to each burns the per-character call twice.

  ⚠️ **The scheduled sync runs hourly at :50** (owner, 2026-08-25: *"밤 11시 크론 없애고
  그냥 매 시간 50분에 크론돌리는게 낫지않나? 결국 아침에 돈사람들은 자동으로 !결정석
  했을때 못보네"*). Nightly-only meant a boss cleared in the morning was invisible
  everywhere until that night. It is cheap: `character_scheduler_snapshots.snapshot_at`
  is the NEXON observation **day**, so the upsert overwrites one row per character per day —
  **storage does not grow with frequency** (measured 2026-08-26). NEXON cost is
  `characters × 24` per credential against a 1,000/day key, and full characters are skipped.
  The scheduler is **pg_cron only** now (`50 * * * *`); the Vercel crons and the Wednesday
  pre-reset sweep are gone, and with them the nominal-time drift compensation — pg_cron does
  not drift, so the real firing time is both simpler and more accurate. If pg_net dies,
  syncing stops silently: check `net._http_response` for hourly 200s.

  ⚠️ **One narrow exception, added 2026-08-21** (owner: *"각 보스시간이 끝나고 그 캐릭을 동기화
  돌리는게 좋을듯"*). The week timetable (`/`) syncs **one character at a time**, and only for a run
  that has *ended, is still unclear-ed, and whose end is more than 15 minutes ago*. That is a
  different shape from what this rule forbids: the target is a single character rather than the whole
  roster, the condition is true only for a few minutes after a raid, and it **stops itself** once the
  clear lands. Measured scale: 10–20 runs a week, so single-digit calls a day.
  Waiting the 15 minutes is not optional — NEXON lags that long (§1.1), so calling at run-end returns
  a response with no clear in it *and* marks the character fresh, which blocks the call that would
  have worked. See `features/schedule/lib/use-post-run-sync.ts`.

⚠️ Superseded, kept so the reasoning is not re-litigated: *"Crystal income comes first on the
dashboard, then parties, then the checklist"* (owner, 2026-08-18). That ordering was about a screen
that no longer exists. Crystal income now owns `/income` outright, which is strictly more than the
card it used to get.

### 1.2 Value priority order

1. Overlay boss-participation intent from multiple characters/users into **one merged timetable**.
2. Clear checkbox → automatic weekly boss-crystal income tally.
3. Schedule sharing between friends.
4. KakaoTalk notifier.
5. Weekly chores.

### 1.3 Deliberate approximations — we knowingly diverge from game mechanics here

Cross-verification (`Claude/review-BOSS-DATA.md`) found places where exact in-game behavior cannot
be modeled. These are **product decisions**, not mistakes. Present them in the UI as approximations
rather than as exact game truth.

- **D1 — Income is attributed to the week of the CLEAR, not the week of the sale.**
  A Wednesday clear can legitimately be sold after Thursday's reset, consuming the *next* week's
  12-slot counter. We cannot observe actual sale timing (the NEXON API exposes none), and the stated
  requirement is "when marked cleared, roll it into that week's income." So clear-week attribution is
  what we implement. A user who defers sales will see our numbers drift from in-game meso.
- **D2 — The 90-per-ACCOUNT weekly cap is tracked and warned about, never enforced.**
  Corrected by the owner on 2026-08-18: the cap is **per NEXON account**, not per world. The earlier
  "per world" wording was wrong and any code that bucketed by `(world, week_key)` is wrong with it.
  Count crystals per `(nexon_account, week_key)` and warn on approach/exceed; do not block, and do
  not silently cap the displayed income.
  It still binds even after daily bosses left scope: 12 per character × 8 tracked characters is
  already 96 > 90.
  ⚠️ **The 90-cap card is GONE from the income screen — owner decision, 2026-08-25** (*"이거
  필요없고"*). The reason is the caveat this rule itself demanded: daily bosses are out of scope, so
  the tally is a **lower bound** and the warning can fail to fire before the real 90. A ceiling
  warning that under-reports the ceiling is worse than none, and it was taking the most valuable
  strip of the screen. The data is untouched (`accountCrystalUsage` still ships in the payload); if
  the card comes back, **count daily crystals first** or the same objection returns.
- **D3 — `party_size` means "how many actually entered", defaulting to the registered participant
  count.** The 1/n split is fixed at entry time and users must be able to correct it. Whether `n`
  counts party members or actual map entrants is unverified and worth up to a 50% error — confirm
  in-game before launch.
  - **Where the 6× overstatement actually lives**: only on clears with **no `run_id`** — i.e. the
    ones observed through the NEXON API, which carries no party information at all. Those land at
    `party_size = 1` and must be corrected by the user.
  - For a clear that *is* linked to one of our runs, `resolve_crystal_payout` divides the pot by the
    run's **`going` signup count**, not by `party_size`. Since `pot = n × floor(base/n)` is ~the base
    price regardless of `n`, editing `party_size` there changes the pot but not the per-person share.
    That is deliberate, and the UI surfaces the "entered 3 vs signed up 6" mismatch as a warning
    rather than silently picking one.
- **D4 — `null` price means unknown, never zero.** Exclude nulls from income sums and count them
  separately rather than adding them as 0. The rule stands on its own and applies to any future
  boss whose price we cannot source.
  - **Velona is no longer an example of it** (owner, 2026-08-20, read in-game): Hard 2,950,000,000 ·
    Normal 850,000,000 · Easy 440,000,000. The Normal 850M-vs-890M source conflict resolves to
    **850M**. Recorded as a *new* price row effective 2026-08-20 00:00 KST rather than an edit of the
    old `null` row — `boss_crystal_prices` is a history, and rewriting it would erase the fact that
    the price was unknown before release and make old snapshots unexplainable (R3).
  - As of that migration **no tracked (weekly/monthly) boss has an unknown price.** Clears already
    snapshotted with `base_price_meso = null` stay null; the snapshot is the record of what we knew.
- **D5 — `max_party = 6` is mostly inferred, not per-boss sourced.** Only ~11 bosses state it
  individually. Use it as a soft input bound (warn), never a CHECK constraint that could block a
  real party. Extreme Su = 2 and the newer-generation 3 are individually confirmed and trustworthy.

### 1.4 The core screen — availability overlay

This is what the app *is*. Everything else is support.

```
[ party member picker ]
┌──────────────────────────────┬──────────────────────────────┐
│ LEFT — each selected member's │ RIGHT — pick a slot and       │
│ available hours, stacked so   │ register the run              │
│ overlap is visible at a glance│  #1  Chaos Von Leon  Thu 21:00│
│  #1 Urepu   weekdays 21–24    │  #2  Hard Lucid      Fri 22:00│
│  #2 Ryan    Tue off, else 20– │                               │
└──────────────────────────────┴──────────────────────────────┘
```

- Availability is **recurring by weekday**, not entered week by week: people work regular hours.
  Never make users re-enter a normal week.
- An exception is **subtraction only**: "this date (or this window on it) is out." Nothing more.
  No reason, no note required, no "these hours instead." effective availability = pattern
  **minus** exceptions, and that is still all `availability_exceptions` ever does.
- **A day CAN now override the pattern — owner decision, 2026-08-20** (*"가능시간선택으로 바꿔"*).
  This reverses the earlier "adding availability the pattern does not cover is deliberately not
  supported" rule. Why it had to change: shift workers rotate their **sleep** along with their
  shifts, so a subtract-only model made them describe their whole day (work *and* sleep) and any
  omission left them "available" while asleep. Selecting the hours that *do* work needs no such
  description. The mechanism is `shift_assignments` (migration 35), not exceptions:
  - no row for that date → the pattern applies, exactly as before;
  - row with a preset → **that day's availability is the preset's hours**, replacing the pattern;
  - row with `preset_id = null` → that day is fully unavailable.
  - **The override replaces by wall-clock instant, not by pattern row** — the same rule exceptions
    follow. Assigning a day wipes every instant falling on that KST date, including hours that
    spilled in from the previous day's 22:00–02:00 pattern. A preset that itself crosses midnight
    keeps its spill: the user said those hours out loud.
  Effective availability is therefore `(pattern − assigned days + selected hours) − exceptions`.
- **Exceptions clip by wall-clock instant, not by pattern row.** "Thursday is out" means *no instant
  falling on Thursday KST is available* — including 00:00–02:00 that spilled over from Wednesday's
  22:00–02:00 pattern. Subtracting whole pattern rows instead would leave that person bookable at
  1 a.m. Thursday after they said they cannot make it. In scheduling, a false *unavailable* costs a
  missed slot; a false *available* gets someone booked who cannot come — always prefer the former.
- Everything registered here is **shared** with the people involved — that is the point.
- **Numbers (`seat_no`, run numbers) are management identifiers, not a queue or a vote.**
  They exist so a person can say "1번" instead of typing a long nickname — vital in KakaoTalk
  plaintext where `!분배 1번 33` must work.
  **Numbers are never renumbered.** If #3 leaves, #4 stays #4 and the gap stays empty; renumbering
  would silently invalidate a conversation already in progress. New joiners take max+1.

---

## 2. Locked technical decisions

| Area | Decision |
|---|---|
| Framework | Next.js (App Router) + TypeScript strict |
| Package manager | pnpm |
| Server state | TanStack Query v5. See **§2.4** — the cache is the single owner of screen data; server components only *prefetch* into it |
| Backend | Supabase (Postgres + RLS) |
| Styling | Tailwind CSS + PipelinePro design tokens (§4) |
| Game API | NEXON Open API (MapleStory). The user-issued API key doubles as the login credential |
| Kakao notifier | A dedicated KakaoTalk **account acting as a bot** sitting in a chat room, answering `!`-prefixed commands. Our server exposes a runner-agnostic command endpoint (see §2.2) |
| Time | Store UTC (`timestamptz`); display and week math pinned to Asia/Seoul |

### 2.4 Caching strategy — the cache owns the screen, the server only seeds it

Established 2026-08-18 after the owner reported "invalidateQueryKey가 제대로 안된거같음". The
invalidation calls were fine; the problem was that **all four pages read the DB inside the server
component and passed the rows down as props.** `invalidateQueries()` cannot touch a prop. Measured
at the time: 26 mutations, 26 `invalidateQueries` calls, and only **5** `router.refresh()` calls —
all five in auth flows. Every boss-plan edit, party edit, run creation and clear check left the
server-rendered half of the screen stale until a manual reload.

**Rule 1 — one owner per piece of screen data: the query cache.** Server components may *prefetch*
into a request-scoped QueryClient and dehydrate it; the client hydrates and owns it from then on.
Server components must not hand DB rows to client components as props for anything a mutation can
change. `initialData` on a single query is acceptable for a leaf that nothing else reads, but it
must carry `initialDataUpdatedAt` or the row is treated as fresh forever.

**Rule 2 — the server QueryClient is per request. Never module-level.** A shared server cache serves
one person's parties and income to the next visitor. That is a data-leak bug, not a performance note.

**Rule 3 — `router.refresh()` is for the server render itself, not for data.** Keep it where the
*page shape* depends on the server (logged-out landing vs the week timetable, account status). Do not reach
for it to make a number update — that is Rule 1's job, and a refresh costs a full server round trip.

**Rule 4 — staleTime is chosen per tier, and every query states its tier:**

| Tier | staleTime | Why |
|---|---|---|
| NEXON-hitting (`/api/nexon/*`, scheduler sync) | **>= 15 min** | The upstream data itself lags ~15 min (§1.1). A shorter window returns identical bytes and burns quota — a dev key gets 1,000/day. |
| ~~Boss master (catalog, aliases, `short_name`, prices)~~ | **not a query at all** | Owner call, 2026-08-18: *"보스같은건 그냥 고정값으로 박아버리던가"*. It changes only on game patches, so it is now a **generated code constant** (`src/lib/boss-master/`), not a fetch — 78 entries, 32 bosses, 210 aliases, prices included. Generated **from the seed migrations** by `pnpm boss-master`, with `pnpm boss-master:check` wired into `prebuild` so a drifting constant fails the build. The DB tables stay (four tables carry `boss_difficulty_id` foreign keys, and settlement math stays in SQL so web and bot cannot diverge); only the **read path** moved. Do not reintroduce a `bossMaster` staleTime tier — there is no query left to tier. |
| Our mutable DB reads (parties, plans, availability, income) | **60 s** default | Freshness here comes from **invalidation after mutation**, not from polling. |
| Session / auth | short | Account status gates whole screens. |

**Rule 5 — every mutation names the key prefixes it invalidates, and the key factory owns every
key.** Keys live in `src/lib/query-keys.ts`. A key written as an array literal at a call site
(`["db","characters"]`) silently stops matching the day the factory changes shape.

⚠️ **A shared prefix is not automatic coverage — check the actual key.** `runs.timetable(weekKey)`
sits under `db.runs.*`, but the run mutations invalidate `runs.list(partyId, weekKey)`, which is a
*sibling*, not an ancestor. Creating a run therefore did **not** refresh the timetable until each of
those sites named the timetable key explicitly (2026-08-20). Before assuming a new query is already
covered, read the mutation's invalidate list rather than the key's shape.

### 2.1 Auth model (important)

- **Logged out**: public timetables are viewable. No writes.
- **Logged in**: user enters their NEXON Open API key → validate → confirm character ownership →
  create account.
- **One person, many NEXON accounts.** Players routinely run a main account plus alts, and one API
  key only ever reads the account that issued it. So an `app_users` row owns **many**
  `user_credentials` (one key per NEXON account, each with a user-facing `label`), and every
  `characters` row must record which credential/account it came from.
- **The account is identified by the main character's nickname.** The key that owns the main
  character is the **primary credential**; every other key is a *linked* credential added afterwards.
  Display identity everywhere is the main character nickname, not a key or an internal id.
- **Any linked key logs into the same account.** Login resolves `sha256(key)` →
  `user_credentials.api_key_hash` → `app_users`. Since the hash is globally unique, signing in with
  an alt key — on a new device, months later, with no prior session — lands on the same person and
  shows the same main-character identity. There is no "primary key required to sign in" rule.
- Adding a key requires an **existing session** (that is what binds it to a person). A key already
  bound to a different `app_users` row is **refused**, never silently re-pointed — silent
  re-pointing would be account takeover.

### 2.1.1 Character selection — never sync everything

Registering a key opens a **character picker modal**: a card grid of image + nickname + level +
class, sorted by level descending, multi-select, **12 per page with paging**. The user chooses which
to track; only those sync.

Sizing this correctly matters: the live account grew from 59 characters to **304** once alt-account
keys were linked, so a fixed top-N would hide most of the roster. Paging is required, and with it:

- **Fetch portraits for the visible page only** — `/character/basic` costs one call per character, so
  a 304-character roster would otherwise burn a third of a dev key's daily budget in one modal.
- **Selection is global, not per page.** Checking someone on page 1, paging away, and coming back
  must keep the check; the footer count reflects every page.

### 2.1.2 The browser holds every key, one per credential

One person owns several NEXON accounts, and **a key only ever reads the account that issued it**.
Holding a single raw key in `localStorage` therefore left every alt-account character permanently
unsyncable — the failure looked like a NEXON error but was ours.

- Store a **`credentialId` → raw key map**, and pick the key per character by walking
  `characters.nexon_account_ref` → `credential_nexon_accounts` → `user_credentials.id`.
  That join already exists in `v_character_sync_source`; no schema change is needed.
- **The raw key IS stored in the DB, AEAD-encrypted** (owner decision, 2026-08-18 — this reverses
  the original rule). Keeping it only in `localStorage` meant a new browser could list all three
  linked credentials and all 304 characters but sync none of the alt accounts: the keys simply were
  not there to send. The exposure was stated and accepted — a NEXON key carries no billing and reads
  only game data, but a DB leak lets someone else read that account. So `localStorage` becomes a
  cache, not the only copy, and a fresh browser syncs every linked account with no re-entry.
- Verify the key belongs to the character's account **before calling NEXON**. The API does reject
  the mismatch with `OPENAPI00004`, but only after spending the call.
- A character whose key is absent is **not an error** — it is a distinct "key not in this browser"
  state with a path to enter that key. Say which cause it is and what to do about it; a message like
  "check the character name or date" names something the user cannot act on and is not even true.

Why it must work this way: the measured account holds **59 characters**, one scheduler call each,
against a dev key's 1,000/day — a full sync would burn a sixth of the daily budget every time.

- `/character/list` returns `{ocid, character_name, world_name, character_class, character_level}`
  and **no image**. Portraits come from `/character/basic`, one call per character.
  So fetch portraits **only for the visible page**, and render a silhouette placeholder otherwise.
  A missing portrait is a normal state, never an error.
- The picker is reopenable later to add or drop tracked characters.
- The API key is **kept in localStorage** so it is never re-entered.
- Validate with a single `GET /maplestory/v1/character/list` call — it returns key validity and the
  owned-character list together. Do **not** use `/v1/id` for login; it cannot prove ownership.
- **Store the raw API key in the DB under AEAD encryption — never as plaintext.** The account is
  still *identified* by the key SHA-256 hash (`api_key_hash`); the encrypted copy exists so the
  server can replay the key to NEXON for the user, not to look accounts up. `encrypted_api_key` /
  `encryption_key_id` / `consent_at` are **service_role-only** and must never appear in an anon or
  authenticated GRANT — `assert_no_public_sensitive_columns()` enforces this, and a migration that
  exposes them has to fail. Encryption is not optional: it costs nothing at call time (the server
  decrypts transparently) and it keeps a DB dump from being a pile of live credentials.
- Also persist `account_list[].account_id` as a secondary identifier: if a user reissues their API
  key the SHA-256 hash changes and they would otherwise lose their account.
- NEXON API calls go through a **Next.js Route Handler proxy**. Note: CORS is *not* the reason —
  the API reflects any Origin and allows browser calls (verified). The proxy exists for
  **quota control, caching (data is 15 min stale anyway), and shrinking the key's exposure surface**.

### 2.2 Kakao bot model

Not an official Kakao API integration. A KakaoTalk account is logged into a bot runner (phone or
emulator) and sits in the chat room. When someone types a command, the runner posts it to us and
replies with whatever string we return.

- **Command → response (pull) is the primary path.** Proactive push is secondary.
- Core endpoint: `POST /api/bot/command` — `{ room, sender, message, timestamp, signature }`
  → `{ reply: string }`. The runner just prints `reply` into the room.
- **Replies are KakaoTalk plaintext.** No markdown, no HTML. Use aligned text and emoji; respect
  message length limits; define newline behavior explicitly.
- Commands are `!`-prefixed (e.g. `!일정`, `!등록 카룡 21시`, `!결정석`, `!클리어`, `!도움말`).
  Parsing must tolerate Korean boss aliases and loose time formats (`21시` / `21:00` / `오후9시`).
- **Sender identity**: the room only gives a nickname, which is mutable and not a key. Users link
  their account by issuing a 6-digit code on the web and typing `!연결 <코드>` in the room.
- Security: per-room token + HMAC signature, timestamp replay protection, per-room rate limit.
- Push path: runner polls `GET /api/bot/outbox?room=...` and acks delivery to prevent duplicates.
- **Runner-agnostic**: no runner-specific concept may leak into our API surface.

### 2.3 Where a notification goes

A party has a **creator**, and notifications follow the party's **bound room** — not the creator's
person record. A person can sit in several rooms; broadcasting to all of them is spam.

- A run created from a room (`!보스등록 더저`) binds that party to **that room**.
- A run created on the web binds to a room the user picks from the rooms they are linked in,
  or to none (web-only party, no push).
- The sender of a bot command resolves to a person through `bot_channel_members`
  (the `!연결 <코드>` mapping), never through a nickname.
- Parties carry a **number scoped to room + week** (`1파티`, `2파티`) so a plaintext line can
  identify them. Like `seat_no`, these numbers are stable and never renumbered.
- Notification line shape (KakaoTalk plaintext, no markdown):
  `19시 1파티 스우 (우레푸, 라이언, 어피치, 프로도)`

---

## 3. Supabase connection status ⚠️

- Target project: **`hryikreaxngexhjjxfyl`** (M_Schedule / Urepu's Project)
- A project-scoped MCP server pinned to that ref is declared in `.mcp.json`. It is an HTTP MCP
  server requiring OAuth, so it only becomes usable after the user authorizes it in an interactive
  session (restart + `/mcp`). Until then its tools are unavailable.
- The older claude.ai Supabase connector is bound to a *different* project
  (`xmgszbqxrjlzpndzbwqi`) and times out. Do not use it for this project.
- Regardless of connector state, **`supabase/migrations/*.sql` files are the source of truth**
  for schema changes. `apply_migration` over MCP is a convenience, never the record.
- Apply path: MCP once authorized, or `npx supabase db push`.

---

## 4. Design system — PipelinePro

Source: `Claude/pipelinepro-DESIGN.md`. **Color, spacing, and typography must follow that document.**
Port it into Tailwind theme tokens; never write raw hex in components.

Summary (see source for full detail):

- Primary `#4F46E5` / Secondary `#06B6D4` / Tertiary `#F97316`
- Background `#FAFAFA` / Surface `#FFFFFF`
- Success `#22C55E` / Warning `#F59E0B` / Error `#EF4444`
- Fonts: the design doc names Outfit / Inter / Source Code Pro, but **Outfit and Inter carry no
  Hangul**. This product is entirely Korean, so every glyph was falling back to the OS default
  (Malgun Gothic on Windows) — inconsistent across machines and the reason the type looked wrong.
  **A Hangul-capable family is the primary UI font**; the doc's Latin choices survive only where
  they do not fragment a mixed Korean+Latin line. Mono stays Source Code Pro (code, keys, IDs).
  Record the substitution and its reasoning in `Claude/DARK-PALETTE.md`'s sibling notes or the
  font module's comments — never edit `pipelinepro-DESIGN.md`.
- 4px spacing base, 8px radius (cards/buttons/inputs), 9999px (avatars/pill badges)
- Transitions with perceived latency stay under 200ms

**Dark mode is required.** `pipelinepro-DESIGN.md` specifies only a light palette, so the dark one is
*derived* — document the derivation and its contrast ratios in `Claude/DARK-PALETTE.md`, and never
edit the original design doc. Rules:

- **Do not invert.** In dark mode surfaces get *lighter* as they rise (background < surface < raised);
  in light mode they get lighter too, but from the other end. Elevation in dark is carried by surface
  lightness, not by shadow — shadows barely read on dark ground.
- Primary `#4F46E5` is too dark to sit on a dark background. Lighten the brand ramp for dark mode
  while keeping hue identity, and verify **WCAG AA (4.5:1)** for body text, 3:1 for large text and
  UI boundaries.
- Semantics never flip: tertiary orange still means imminent, red still means failure/cancel.
- Density encodings (the overlay's `primary/25 → /70` ramp) must be re-tuned for dark — the same
  alpha steps that read as four levels on white collapse into mud on near-black.
- Default to `prefers-color-scheme`, allow a manual override, and persist the choice.
- **No flash of the wrong theme**: resolve and apply the theme before first paint.

**Legibility rules — these were learned the hard way, twice.**

- **Judge contrast on the rendered pairing, not on a token table.** A palette table checked against
  `surface` alone passed while the screen was unreadable, because real text sat on `hover-surface`,
  at 11–12px, in a token meant for something else. Compute the ratio for the actual color pair at
  the actual size, in *both* themes — the first pass here found light mode was the worse of the two.
- **Sentences never go below 14px** (`text-body-sm`). `text-caption` (12px) and `text-overline`
  (11px) are for badges, labels, and numeric annotations only.
- **`ink-placeholder` is for input placeholders, decorative icons, and disabled affordances.**
  Text a user is expected to read uses `ink-muted` or darker.
- Warning orange carries background and icon; **the sentence itself is ink**. Orange body text does
  not reach AA on either theme.

Domain-specific rules:

- Encode boss difficulty / status via **left border color** (borrowed from the deal-card rule).
- Imminent / overdue warnings use **tertiary orange, not red**. Red is reserved for failure and cancellation.
- Meso amounts are always locale-formatted (`ko-KR`).
- Kanban and list views are toggled, never shown side by side on one page.

---

## 5. Development commands

```bash
pnpm install
pnpm dev          # dev server
pnpm typecheck    # tsc --noEmit
pnpm lint
pnpm build
```

---

## 6. Subagent brief template

Fill in **every** field when delegating. A blank field produces a misaligned deliverable.
Briefs are written in Korean (agents produce Korean-facing docs), but this protocol file stays in English.

```
[목표]     One sentence. What state means "done".
[배경]     Point at CLAUDE.md §1 (domain) and §2 (tech decisions); tell them to read it first.
[산출물]   Every file path to create/modify. Nothing outside that list may be touched.
[동일 적용] Sibling occurrences of the same problem that must be fixed in the same pass (§0.2-1).
           List them explicitly, or state that a search found none. Never leave this blank.
[제약]     Design tokens, RLS required, KST Thursday reset, no hardcoding, etc.
[검증]     Commands the agent must run itself before finishing, and the pass bar.
[보고]     Changed-file list + open issues + assumptions made. No pasting full source code.
```

<!-- BEGIN:nextjs-agent-rules -->

# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->
