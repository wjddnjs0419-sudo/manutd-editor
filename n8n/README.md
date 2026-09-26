# LEGACY — n8n historical workflows

These exports are retained for audit, parity comparison, and an explicit
temporary rollback. n8n is not required for the M7 production path.

## Why n8n existed

Before M7, n8n supplied the wall-clock schedules, invoke-only HTTP chaining,
fixture-to-Telegram handoff, morning briefing trigger, and Telegram webhook
adapter. The exports deliberately contained credential references only; secret
values and Supabase service keys never belonged in workflow JSON.

## M7 replacement map

The historical responsibilities below were replaced by the corresponding
Supabase-native components.

| Historical n8n responsibility | Supabase-native replacement |
| --- | --- |
| Instagram 30-minute schedule | Supabase Cron → `COLLECT_INSTAGRAM` root job |
| Collector → intelligence → creative chain | `orchestration-worker` and its bounded editorial job chain |
| Notion projection after generation | canonical `creative_briefs.READY` → `PROJECT_NOTION` consumer |
| Fixture sync every 15 minutes | Supabase Cron → `FIXTURE_SYNC` → `DISPATCH_ALERTS` |
| 09:00 Asia/Seoul briefing | Supabase Cron → `MORNING_BRIEF` |
| Telegram Trigger | direct `telegram-agent` webhook with `TELEGRAM_WEBHOOK_SECRET` |

Notion projection is intentionally independent: a Notion outage can retry or
dead-letter `PROJECT_NOTION` without changing the canonical creative-generation
success contract. Future Figma draft generation can consume the same READY
state without modifying creative generation.

## Historical files

- `workflows/instagram-collector-schedule.json`
- `workflows/fixture-sync-schedule.json`
- `workflows/telegram-morning-brief.json`
- `workflows/telegram-editorial-agent.json`

They are inactive historical fixtures. Do not enable them alongside the M7
Cron schedules without an explicit incident decision, because both systems
could enqueue duplicate work.

## Temporary rollback

If a production incident requires rollback, pause the Supabase Cron and
orchestration-worker invocation path, restore the matching n8n export and its
credential references in the n8n instance, and verify the direct function
endpoints. Reverse the rollback after the incident and re-enable only the M7
path. This repository does not perform production deployment or rollback.

## Historical export validation

The validator remains useful when reviewing an old export. It is not part of
the required M7 production smoke path.

```bash
node scripts/validate-n8n-workflow.mjs n8n/workflows/instagram-collector-schedule.json
node --test scripts/validate-n8n-workflow.test.mjs
```
