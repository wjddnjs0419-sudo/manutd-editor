# ManUtd Editor Card-News Style Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Apply the concise, natural Korean football-editorial tone to canonical card-news generation, repair, captions, and shared revisions, with lightweight deterministic validation.

**Architecture:** Keep the existing `manutd_editor` profile as the single source of style rules. Extend its validator for page-one shape, caption engagement/hashtag limits, evidence-backed numbers, hype, and source-strength preservation; pass the frozen evidence text into validation. Reuse the same style instructions for initial generation, repair, and shared M6 revision callbacks without changing Telegram navigation or discovery behavior.

**Tech Stack:** TypeScript, Deno tests, Supabase Edge Functions, OpenAI Responses structured JSON output.

**Spec:** `/Users/jeongwonkim/.codex/attachments/d7dfc981-1acc-4591-b2ad-688c753a92c5/pasted-text-1.txt`

## Global Constraints

- Change only editorial writing style, card-news prompts/profile, captions, style validation, and related tests.
- Preserve source strength: verified can be direct; reported and unconfirmed claims retain attribution/uncertainty.
- Page 1 defaults to two short main-copy lines with no body paragraph or filler.
- Captions contain one easy engagement question and no more than five hashtags.
- Never invent numeric evidence.
- Do not change Telegram navigation, scheduling, eligibility, discovery cadence, alert thresholds, Notion, Figma, or publishing.

## Review Focus

- Weak transfer monitoring must not become a strong negotiation or offer claim; test the validator against weak, medium, and strong evidence.
- A page-one hook with body or more than two long lines must fail without rejecting valid two-field hooks.
- Captions with a generic question, repeated formal endings, or six hashtags must fail while concise fan-account captions pass.
- Numeric claims must be present in frozen evidence text, including Korean percent/fee-style tokens where applicable.
- Shared revisions must preserve the same style identity and evidence boundary as canonical generation.

---

### Task 1: Extend the shared style contract and validator

**Files:**
- Modify: `supabase/functions/_shared/editorial-style/types.ts`
- Modify: `supabase/functions/_shared/editorial-style/manutd_editor.ts`
- Modify: `supabase/functions/_shared/editorial-style/validator.ts`
- Test: `supabase/functions/tests/editorial-style/manutd_editor_test.ts`

- [x] Write failing tests for two-line page-one hooks, body/length rejection, hype rejection, caption question/hashtag/formality rules, weak-to-strong rumor rejection, and unsupported-number rejection.
- [x] Run the focused style test and confirm the new assertions fail for missing validation.
- [x] Add profile limits and deterministic error codes, keeping the existing style identity/version stable for compatible stored rows.
- [x] Implement lightweight copy, caption, rumor-strength, and evidence-number checks.
- [x] Run the focused style test and confirm it passes.

### Task 2: Wire evidence-aware validation into canonical generation and repair

**Files:**
- Modify: `supabase/functions/creative-generation/quality_gate.ts`
- Modify: `supabase/functions/creative-generation/prompts.ts`
- Test: `supabase/functions/tests/creative-generation/quality_gate_test.ts`
- Test: `supabase/functions/tests/creative-generation/provider_test.ts`

- [x] Add failing assertions that prompts describe the new page-one, rumor-strength, caption, and no-invented-number rules.
- [x] Pass frozen evidence text into the style validator and add targeted quality-gate fixtures for page-one, caption, rumor, hype, and numeric failures.
- [x] Make repair reuse the same canonical style instructions and preserve valid evidence-bound content.
- [x] Run the focused creative-generation tests and confirm they pass.

### Task 3: Apply the style contract to shared M6 revisions

**Files:**
- Modify: `supabase/functions/_shared/m6/revisions.ts`
- Test: `supabase/functions/tests/m6/revisions_test.ts`

- [x] Add failing tests proving slide/caption revision callbacks receive the canonical style rules and that invalid revised page-one/caption output is rejected.
- [x] Preserve style metadata/internal grounding when converting stored briefs to revision output; enable the ManUtd validator for revision materialization.
- [x] Prefix revision callback instructions with the shared style rules without altering Telegram action routing.
- [x] Run the M6 revision tests and confirm they pass.

### Task 4: Verify the scoped change

- [x] Run all focused style, creative-generation, provider, and M6 revision tests.
- [x] Run the existing M8.6 smoke because shared creative logic changed.
- [x] Inspect `git diff` and confirm no scheduling, discovery, eligibility, alert, Notion, Figma, or broad Telegram UX files were modified.
- [x] Report the alternate-hook placeholder as an integration point because no separate active generation path exists in this checkout.
