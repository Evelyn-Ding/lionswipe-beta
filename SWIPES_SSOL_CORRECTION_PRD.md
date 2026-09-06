# PRD: Swipes Left / SSOL Correction

**Branch:** `updatedashboard`
**Author:** Evelyn Ding
**Status:** Implemented
**Scope:** `index.html` — `meal_plans.swipes_adjustment`, `getSwipesUsedSsol`/`getSwipesLeftSsol`/`updateSwipesLeft`, the Swipes Left stat card + correction modal, the Meal History subtitle. `schema.sql` — new column + migration.

## 1. Problem

"Swipes Used" and "Swipes Left" were originally a pure function of what a student had manually logged into LionSwipe — the sum of `swipes` across every `type:'hall'` row in `meal_logs` since `SEMESTER_START` (`usedSemester_logged`). Two real situations break that assumption:

- A student starts using LionSwipe **partway through the semester**, after already using some of their dining plan — those swipes were never logged in-app, so they don't exist as far as LionSwipe is concerned.
- A student has been logging along the way, but their in-app count **drifts** from Columbia's own system of record (SSOL) — a forgotten entry, a duplicate, a hall visit logged as fewer swipes than it actually cost.

In both cases the pure-log-sum number is simply wrong, and there was no way to fix it short of faking log entries (which pollutes Meal History) or living with an inaccurate dashboard.

## 2. Design: a correction layered on top of the logs, not a rewrite of them

`meal_plans` gained one new column: **`swipes_adjustment`** (int, default `0`) — a signed offset representing "how far the true used-count is from what's actually logged." The logged history (`meal_logs`) is never touched by a correction.

Two getters (`index.html:2264`, `index.html:2269`) are the single source of truth used everywhere on the dashboard — the header, the Breakdown stat cards, and the swipe pacing math:

```
getSwipesUsedSsol(usedSemester_logged) = usedSemester_logged + swipes_adjustment
getSwipesLeftSsol(usedSemester_logged) = max(0, total_swipes - getSwipesUsedSsol(usedSemester_logged))
```

`usedSemester_logged` always means exactly one thing: the sum of what's sitting in Meal History right now. `swipes_adjustment` only changes when a student explicitly corrects "Swipes Left" — the stat card itself is the click-to-correct control (`index.html:2525`), and saving it re-solves the offset from scratch (`updateSwipesLeft`, `index.html:2278`):

```
newSwipesUsed_ssol = total_swipes - newSwipesLeft_ssol   // what they typed in, back-solved
swipes_adjustment  = newSwipesUsed_ssol - usedSemester_logged
```

This **replaces** the stored offset outright each time — it's a full re-sync against "what's true right now," not an increment on top of a previous correction.

To keep the correction visible rather than hidden, a small line sits right under the Meal History heading (`renderMealHistory`, `index.html:2480`):

> **Meal Swipes Used:** *(getSwipesUsedSsol — the corrected number, used everywhere)* / **Meal Swipes Logged by You:** *(raw usedSemester_logged — what Meal History actually contains)*

When the two numbers differ, that gap **is** `swipes_adjustment` — legible without needing to explain the mechanism.

## 3. Use cases

All examples use a 175-swipe plan (`total_swipes = 175`) so the numbers are directly comparable across cases.

### 3a. Joins on time, logs every swipe perfectly

The happy path — no correction ever needed.

- `total_swipes = 175`, set once at signup.
- Every dining hall swipe is logged in LionSwipe the moment it happens, so `usedSemester_logged` is always the true count.
- `swipes_adjustment` stays `0` for the entire semester — it's never touched.
- `getSwipesUsedSsol` = `usedSemester_logged` exactly (adjustment is 0, so they're identical).
- `getSwipesLeftSsol` = `175 − usedSemester_logged`.
- **Dashboard shows:** Meal Swipes Used and Meal Swipes Logged by You always match. Swipes Used / Swipes Left / Swipes-per-Week-Needed are all correct at every point in the semester with zero user intervention.

### 3b. Joins LionSwipe late, after already using some swipes

- Signs up mid-semester, enters `total_swipes = 175` (their real plan total, from SSOL).
- Has already used 35 swipes before ever opening LionSwipe.
- `usedSemester_logged = 0` — a brand-new account has nothing logged yet.
- **Before correcting:** `getSwipesUsedSsol = 0`, `getSwipesLeftSsol = 175` — wrong, overstating what's left by 35.
- They check SSOL, see "140 swipes left," click the Swipes Left card, type `140`, check "I confirm this is the accurate # of swipes updated on SSOL," and save.
  - `newSwipesUsed_ssol = 175 − 140 = 35`
  - `swipes_adjustment = 35 − 0 = 35`
- **Dashboard now shows:** Meal Swipes Used = 35, Swipes Left = 140 (both match SSOL) — but Meal Swipes Logged by You still correctly reads 0, since nothing has actually been logged in-app. That 35-vs-0 gap *is* the correction, visible at a glance.
- **Going forward:** every swipe they now log in-app adds 1 to `usedSemester_logged`; since `swipes_adjustment` stays fixed at 35, `getSwipesUsedSsol` (35 + whatever's now logged) stays accurate without touching the correction again.

### 3c. Realizes SSOL and LionSwipe have drifted apart

- Has been logging normally: `usedSemester_logged = 40` (all 40 visible individually in Meal History), and no correction has ever been made (`swipes_adjustment = 0`), so the dashboard has been showing Used = 40, Left = 135.
- Checks SSOL and sees the real swipes-left is 130 — meaning they've actually used 45 (5 more than logged; e.g. two forgotten dining hall visits).
- Opens the correction modal (pre-filled with 135, the current dashboard number), types `130`, confirms, saves.
  - `newSwipesUsed_ssol = 175 − 130 = 45`
  - `swipes_adjustment = 45 − 40 = 5`
- **Dashboard now shows:** Meal Swipes Used = 45, Swipes Left = 130 (both match SSOL). Meal Swipes Logged by You still correctly reads 40 — all 40 original entries are untouched and still editable in Meal History below. The 45-vs-40 gap documents the 5-swipe discrepancy.
- **Editing Meal History afterward moves the totals directly, on top of whatever correction is active.** `swipes_adjustment` is never touched by editing or deleting a log entry — only `usedSemester_logged` changes, and it flows straight through the same formula. So if this student later fixes one of the 40 logged entries — say a hall visit was logged as 10 swipes but should have been 5 — `usedSemester_logged` drops from 40 to 35, and:
  ```
  Meal Swipes Used = usedSemester_logged + swipes_adjustment = 35 + 5 = 40
  Swipes Left      = total_swipes − Meal Swipes Used         = 175 − 40 = 135
  ```
  i.e. Swipes Left moves by exactly the same 5 the edit changed, exactly as if they'd logged (or un-logged) 5 fewer swipes from the main page — `swipes_adjustment` is just carried forward unchanged underneath it. This is intentional: a correction and a Meal History edit are two independent, additive adjustments to the same running total, not two competing sources of truth. The one thing to know is that this composes literally — if an edit happens to touch entries that a past SSOL correction was already covering for, re-checking SSOL and re-correcting (rather than assuming the two will cancel out automatically) is the way to keep both numbers accurate.

### 3d. Switches dining plans mid-semester

- On Plan A (`total_swipes = 175`), with `usedSemester_logged = 60` and a prior correction of `swipes_adjustment = 5` in effect → dashboard shows Used = 65, Left = 110.
- Upgrades to Plan B (`total_swipes = 210`) via Profile.
- `swipes_adjustment` **carries forward unchanged** (still `5`) — a plan-total change doesn't reset it, because the correction is about how much has actually been used, not about the plan total.
- **Dashboard now shows:** Meal Swipes Used stays 65 (correctly unaffected by the plan swap), Swipes Left recalculates immediately against the new total: `210 − 65 = 145`.

## 4. SSOL correction vs. Meal History edits — not either/or, but don't double-fix the same gap

These are two independent, additive tools, not competing sources of truth — which one to reach for depends on what you actually know is wrong:

- **Know exactly which entry is wrong?** Fix it directly in Meal History (wrong swipe count, forgotten visit, a typo). It flows straight into the total with no offset involved — no need to touch the Swipes Left card at all.
- **Only know the aggregate is off, not which entries caused it?** Use the Swipes Left card to set the real number from SSOL. Just don't *also* go add/fix the same entries in Meal History afterward for the same gap — neither mechanism knows what the other already accounted for, so doing both for the same discrepancy double-counts it (see 3c). If that happens, re-open the Swipes Left card and re-sync to the current real number — each save fully replaces the offset, so that immediately corrects it.

## 5. What never changes, no matter which case applies

- Individual `meal_logs` rows are never edited or deleted by a correction — every dining hall visit a student has logged stays exactly as entered, visible and independently editable in Meal History.
- A correction never touches `total_swipes` — only `swipes_adjustment`.
- Editing the full dining plan (Profile → new `total_swipes`) carries the existing `swipes_adjustment` forward rather than resetting it (see 3d).
- Every correction is a full re-sync ("what's true right now"), never additive on top of a previous one.

## 6. Database migration

`meal_plans` needs one new column. If you're running `schema.sql` fresh, it's already included in the `create table` statement. **On an existing table**, run this once in the Supabase SQL editor for whichever project `lionswipe-beta` points at:

```sql
alter table public.meal_plans add column if not exists swipes_adjustment int not null default 0;
```

That's the only schema change this feature needs — no other tables are touched.
