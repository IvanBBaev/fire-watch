# Engineering practice

*Decided 2026-10-30 ([founder decision record](decisions/founder-2026-10-30/governance-product.md),
rows GP-2 to GP-4). Sources: review 22 E1–E3 and §6 Q1–Q2, review 21 E5.*

This file holds the rules for how work reaches `main`. It is committed on purpose. Agent-only
notes (`docs/ai/`) are local and never reach a fresh checkout. A rule that changes how work is
integrated must live where every contributor and every agent can read it (review 22 §6 Q2).

## 1. Integrated means committed and green

The execution contract in [`TASKS.md`](TASKS.md) §0 gets a rule 8. The coordinator adds the
text below to §0 verbatim. This file is the rationale.

> 8. **Integrated means committed and green.** No session ends with more than one task of
> unintegrated work. At session end the agent prepares the commit series and asks; the
> dispatching human answers. Work that is not on `main` with CI green is not done, whatever
> the checkbox says. "Green" means the GitHub CI run on the pushed commit, not a local run.

Rule 4 still holds: an agent never commits or pushes unless the dispatching human asks. Rule 8
makes asking the default at session end, so work does not pile up uncommitted.

**Why the last sentence exists.** From 2026-10-02 to 2026-10-24, GitHub CI on `main` was red
(the Supply chain job: `pnpm audit` on fastify 5.11 advisories). Throughout those three weeks the
work log said "all gates green", because the gates had been run on a laptop. Local runs miss
what only CI runs: the audit against today's advisory database, the clean install, the pinned
browser, the PostGIS service. A local run is a useful pre-check, but it does not count as green.

## 2. The integration series

Uncommitted work is integrated as a **series of commits in dependency order**: contracts and
migrations first, then core, then adapters, then web. Each commit is one item and contains only
that item's files. CI must be green at every step, not only on the last commit (review 22 E1).
If a step cannot be made green alone, two items are coupled. Merge them into one commit and
say so in the message. Do not push a red intermediate commit.

## 3. Branch protection on `main`

Policy (review 21 E5, review 22 §6 Q1):

| Setting | Value | Why |
|---|---|---|
| Required status checks | the five `ci.yml` jobs (below), `strict: true` | A push that has not passed CI cannot become the release line |
| Force push | blocked | History on `main` is the audit trail |
| Deletion | blocked | Same |
| Linear history | required | The integration series stays readable and bisectable |
| Required PR reviews | **none** | A solo founder cannot review their own PR. PR ceremony with one person is theatre (review 22 E9) |
| Enforce for admins | **off** | The owner pushes to `main` directly. With admin enforcement off, an admin push that skips the checks is still recorded by GitHub as a bypass, and rule 8 still applies to it |

Required check names are the job `name:` values in `.github/workflows/ci.yml`:

- `Typecheck, lint, boundaries, tests`
- `End-to-end (polling only) + accessibility floors`
- `Map-ready timing budgets (CI-12)`
- `Migrations against PostGIS`
- `Supply chain`

If a job is renamed, update its required-check name in the same commit. Otherwise every push
waits for a check that never reports.

**Applying it is an owner action**, because it changes the GitHub repository. Run the command
below only after `main` is green on GitHub CI, or the first push after it is blocked:

```sh
gh api -X PUT repos/IvanBBaev/fire-watch/branches/main/protection \
  -H "Accept: application/vnd.github+json" \
  --input - <<'JSON'
{
  "required_status_checks": {
    "strict": true,
    "contexts": [
      "Typecheck, lint, boundaries, tests",
      "End-to-end (polling only) + accessibility floors",
      "Map-ready timing budgets (CI-12)",
      "Migrations against PostGIS",
      "Supply chain"
    ]
  },
  "enforce_admins": false,
  "required_pull_request_reviews": null,
  "restrictions": null,
  "required_linear_history": true,
  "allow_force_pushes": false,
  "allow_deletions": false
}
JSON
```

Check the result with `gh api repos/IvanBBaev/fire-watch/branches/main/protection`.

## 4. The review standard

Review 22 E3 defines three tiers. The tier depends on what the harness can check, not on how
large the change is.

| Tier | What changed | Who reviews | What counts as reviewed |
|---|---|---|---|
| **a. Config as data** | thresholds, layer registry, catalogs, fixture parameters, any versioned config | the human | The human reads the diff **and** the written rationale (which source, which doc §). A config change without a rationale is not reviewed |
| **b. Engine code under the harness** | code that a golden replay, a property test, an integration suite or a CI gate covers | a second agent, briefed adversarially | The reviewer either produces a failing fixture or writes "could not" with what it tried. "Looks good" does not count |
| **c. Not covered by the harness** | anything else: new adapters before their tests, infra, deploy scripts, security boundaries, user-facing wording | the human | The human reads the code. An agent review alone is not enough |

When unsure, use the higher tier (c over b, b over a). A tier-b change that adds a new path
the harness does not cover is tier c for that path.
