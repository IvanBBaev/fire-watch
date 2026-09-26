# <Erasure drill (TASKS I7) | Backup/restore + RTO drill (TASKS J2)> — <started at, UTC ISO>

The drill CLIs generate this structure (`server/src/core/drills/render-record.ts`). This
file documents it. Fill in only **Operator notes** by hand, then commit the record.

**Verdict: <PASSED | FAILED | INCOMPLETE>**

| | |
|---|---|
| Environment | `<--environment>` |
| Started | `<ISO>` |
| Finished | `<ISO>` |
| Target: `<key>` | `<value>`: credential-free (database host and name, bucket or store) |

## Facts

| Fact | Value |
|---|---|
| `<name>` | `<value>`: artifact key, latest migration, account id, erasure deadline, … |
| `target_check` | Present only when `--confirm-not-production` overrode the target check |

## Steps

| Step | Mode | RTO path | Status | Duration | Detail |
|---|---|---|---|---|---|
| `<id>` — <title> | automated \| manual | yes \| no | passed \| failed \| skipped \| not_performed | <s or min> | <detail> |

## Recovery time

This section appears in the restore drill only.

- Status: **<met | exceeded | incomplete | failed>** (target 120–240 min; OPERATIONS §5, §6.3 rule 4)
- Measured: <minutes> min. It is a lower bound when steps are missing.
- Not performed: <manual step ids that were not reported>
- An exceeded RTO becomes a freeze-priority work item (OPERATIONS §6.3 rule 4).

## Checks

| Check | Status | Detail | Spec |
|---|---|---|---|
| `<id>` — <title> | pass \| fail \| not_run | <detail> | <ADR / OPERATIONS reference> |

## Findings

- <anything that failed or looked wrong, including an error thrown mid-drill>

## Open items

- <known gaps the drill cannot close by itself>

## Operator notes

_Fill in before committing this record._

- Secrets restored (VAPID private key, zone key, age identity): <restore drill only>
- Runbook defects found:
- Follow-up items (TASKS/RISKS):
