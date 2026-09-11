# Capability Chains & Quota Domains

> **Source:** `server/src/data/routing-curation.ts`, `server/src/services/quota-pressure.ts`,
> `server/src/services/scoring.ts`, `server/src/scripts/apply-routing-curation.ts`

## 1. What this layer is for

FreeLLMAPI's job in a harness stack is narrow:

> satisfy the requested capability class using the best healthy free inference
> capacity available right now.

```
harness (Oh My Pi, Codex, Claude Code, …)
        │  logical capability — "I need a coding worker"
        ▼
   auto:<chain>
        │
   ┌────┴─────────────┬──────────────┐
capability          quota          health
   │               domains            │
   └────┬─────────────┴──────────────┘
        ▼
   route scorer
        │
   ┌────┼────┐
 Groq  NVIDIA Google
```

The harness does not care which physical model answered. FreeLLMAPI does not care
which harness asked. Capability escalation — deciding a request needs a *stronger
class* — belongs above this layer; FreeLLMAPI handles **supply**.

---

## 2. The eight capability classes

Chains are `profiles` rows, addressable as `auto:<lowercased name>` and listed in
`GET /v1/models`. Their contracts live in `CHAIN_CONTRACTS`
(`server/src/data/routing-curation.ts`) so the documentation and the assertion
the tests run are the same statement.

| Chain | Contract | Tools | Vision |
|---|---|---|---|
| `auto:apex` | The **peak** of the free catalogue, for **escalation** — strongest capability available, whether or not it suits daily volume. Deliberately not the same as frontier. | required | — |
| `auto:coding` | Implementation worker: coding ability, tool/edit reliability, adequate context, sustainable quota. | required | — |
| `auto:frontier` | Strongest **reliable** free general driver — the working edge a harness sits on all day. Reasoning, coding, tool use, context and reliability together. Not the longest chain, the best one. | required | — |
| `auto:workhorse` | Balanced middle tier: quota depth, reliability, sustained throughput. | required | — |
| `auto:fast-lane` | Low-latency, high-volume: scouting, search, summaries, classification, bounded subagents. Lowest opportunity cost. | required | — |
| `auto:vision` | Screenshots, UI inspection, image analysis, visual verification. | — | required |
| `auto:extra-tier` | Overflow and experimental capacity. Never early on a critical path. | — | — |
| `auto:default` | Generic safe compatibility endpoint. Behaves like a dependable general-purpose route — **not** a secret alias for the most powerful model available. | required | — |

### frontier is not apex

The distinction decides where escalation goes, and the tests enforce that their
heads differ. `frontier` is the best model to drive all day — the working edge.
`apex` is the peak of what is available for free, whether or not it suits daily
volume. Collapsing them makes free escalation a no-op:

```
ordinary free model insufficient
        ↓
auto:apex              ← a genuinely stronger pool, not the same one again
        ↓
external premium, only if still justified
```

### workhorse has no harness role, and keeps its place

It is the middle tier for ordinary API consumers, fallback within other chains,
medium-complexity delegated work and sustained execution. Absence of a harness
role named WORKHORSE is not a reason to delete a useful tier.

---

## 3. Quota domains

A route is available only if **every** governing domain permits it. Domains are
resolved by `resolveQuotaPolicy` and their limits by `resolveEffectiveQuotas`.

```
MODEL
  ├─ provider/account quota      nvidia::credit-pool, ollama::cloud
  ├─ provider RPM                per-key account minute cap
  ├─ daily quota                 calendar or rolling
  ├─ weekly quota                ollama::weekly
  ├─ credit balance              openrouter::credits (real money)
  └─ model-specific quota        groq::model::<id>, google::project-model::<id>
```

### Independent pools vs capability diversity

The same model on two providers is two allowances and is worth routing twice.
Three different models on one provider are three capabilities and **one**
allowance:

| Shape | Example | Independent capacity? |
|---|---|---|
| One model, several providers | `nemotron-3-ultra` on NVIDIA, OpenRouter, Ollama | **Yes** — three pools |
| Several models, one provider | Kimi K3, DeepSeek V4 Pro, Nemotron 3 Ultra on NVIDIA | **No** — one `nvidia::credit-pool` |
| Several models, per-model pools | `gpt-oss-120b`, `gpt-oss-20b`, `qwen3.8-27b` on Groq | **Yes** — Groq meters per model |

The scheduler understands this distinction, and so does chain order: the tests
assert that the first two members of every critical chain sit on different pools,
because a chain whose head pair shares an allowance has no depth at the moment
depth is needed.

### Priority of truth

`resolveEffectiveQuotas` ranks sources and never lets a weaker one overwrite a
stronger one:

```
live provider header        (a measurement)
  ↓ provider usage API      (a measurement)
  ↓ operator configuration
  ↓ documentation
  ↓ catalogue metadata
  ↓ provider env cap
  ↓ ceiling learned from a 429   (weakest — inferred from a refusal)
  ↓ unknown
```

Axes are keyed by **subject, metric and period**, so an account-wide limit and a
per-model limit of the same shape both survive resolution. Before that fix the
model limit silently hid the account limit, which is exactly the "model has
capacity but the account is exhausted" case shared-domain resolution exists to
catch.

### Availability is a gate, not a rank

"Available only if all governing domains permit it" is not satisfied by ranking.
A demoted route is still served the instant its alternatives run out — precisely
the moment a spent account pool is guaranteed to refuse. So an exhausted domain
**closes** the route in `selectKeyForModel`, alongside cooldown and the per-model
meters, and the diagnostic names the domain that closed it:
`quota-domain-exhausted(provider_account:requests:operator)`.

The router's older gates are each hard-wired to one meter — `canUseProvider`
reads its own env-cap counters, `canMakeRequest` reads the model's rpm/rpd — so
none of them could see a limit an operator typed into `quota_policy`. That limit
was purely advisory until this gate existed.

`quotaDomainsAdmit` is deliberately separate from the cached `quotaPressure`
used for ranking, and differs in all three ways that matter:

|  | Ranking (`quotaPressure`) | Admission (`quotaDomainsAdmit`) |
|---|---|---|
| Usage counts | 5s memo | fresh read |
| In-flight leases | ignored | counted, plus this request |
| Axes | worst one decides the rank | **any** exhausted one closes the route |

Each difference is a hole that was there first. A gate answered from a 5s memo
enforces one limit per five seconds — the second request inside the window sees
the first one's pre-write number. A gate blind to leases loses the check-then-act
race outright, since usage is only written after an attempt succeeds, so N
concurrent requests all read the same zero. And a gate reading only the binding
axis lets a spent account pool hide behind a model meter with a lower fraction.

Which sources may close a route (`ENFORCEABLE_SOURCES`):

| Source | Closes the route? | Why |
|---|---|---|
| `provider_header`, `provider_api` | **Yes** | the provider measured it and said so |
| `operator` | **Yes** | a human typed this ceiling for this account; treating it as advisory ignores the one person who knows the plan |
| `catalog`, `documentation` | No | shipped guesses |
| `provider_cap_env` | No | already enforced by `canUseProvider` on its own counters |
| `learned_429` | No | a lower bound inferred from a single refusal |

Blocking on a limit nobody stated suppresses capacity that is really there, which
is the expensive direction of this error.

Credits are handled apart from requests and tokens throughout, because they are
money and a request's cost in them is not its token count — Ollama Cloud prices
per model, so a million `nemotron-3-ultra` tokens costs roughly eight times a
million `gpt-oss:20b` tokens. A credit axis therefore:

- is never counted from local usage (no pricing conversion exists locally);
- reserves nothing for the request being admitted;
- closes the route only on a provider-reported or derived balance that is
  already gone.

Both halves of that were live bugs. Counting raw tokens as spend read the stated
166-credit Ollama ceiling as millions consumed, and reserving `estimatedTokens`
against it would have closed the account on the first ordinary 1000-token
request. Until a real pricing conversion exists, over-admitting by one request is
the correct side to err on: the provider's own reported remaining closes it a
moment later.

Recovery needs no bookkeeping: usage is counted inside the axis's own window, so
yesterday's spend falls outside today's period on its own.

### Unknown is not unlimited

An unmeasured pool scores `UNKNOWN_POOL_PRESSURE` (0.5) — between exhausted and
fresh. It gets used enough to be learned and not enough to be depended on, and it
never harvests a preference it has not earned on an unknown reset. OpenCode and
similar promo providers sit here.

---

## 4. How quota pressure reaches the score

Above the gate, the same resolution drives ranking, so a pool that is merely
*getting* scarce is steered away from before it becomes a refusal:

```
base       = w_rel·reliability + w_speed·speed + w_intel·intelligence
headroom   = min(monthlyBudget, rateWindow, quotaScarcity)   ← worst meter, not their product
preference = diversity × harvest
effective  = base × headroom × rateLimitFactor × preference
```

Guardrails are ≤ 1 by construction and can only demote. **`preference` is the
one exception** and is capped tightly for exactly that reason — together its two
terms span roughly `[0.88, 1.08]`. Scores are compared against each other and
never against a threshold, so exceeding 1 is safe for ordering.

The split matters. An early version folded harvesting into the guardrail `min`,
where a boost above 1 was clipped straight back to 1 by the two meters that had
no opinion — the feature computed a number and changed nothing.

### Scarcity — a guardrail

Remaining fraction on the binding axis rides the same `headroomRamp` and the same
operator-tuned thresholds as the other two guardrails, then scales by the pool's
reservation weight:

```
healthy capacity  → normal use
getting scarce    → reserved for higher-value requests
nearly exhausted  → strong penalty
```

`quota_reservation_weights` (settings, JSON, keyed by platform) is how an
operator says which pools to hold back. Two pools at 50% are not equally cheap to
spend when one of them is a 50/day allowance, and no formula over absolute counts
can infer that. Current values on this install:

```json
{ "openrouter": 0.3, "ollama": 0.25, "opencode": 0.6 }
```

### Reset urgency — a preference

Free allowance that expires unused was never reserved for anything, it was
wasted. A daily pool at 80% unused with 45 minutes left on its window is the most
attractive place in the fleet to spend, and nothing else in the scorer can say
so: scarcity has no opinion about a pool that is 80% full.

Two conditions, both required:

- **Unspent** — pace deficit beyond `HARVEST_MIN_PACE_DEFICIT`, saturating at
  `HARVEST_FULL_PACE_DEFICIT`. A pool that spent its allowance on schedule has
  nothing to harvest, and steering more traffic at it brings the refusal forward.
- **Expiring** — inside the last `HARVEST_WINDOW_FRACTION` (25%) of the pool's
  **own** period. Relative, not a fixed horizon: 12 hours out is nowhere near the
  end of a daily window and well inside a weekly one. A rolling RPM window has no
  reset instant and is never harvested.

Capped at `HARVEST_MAX_BOOST = 0.08`. "Use it before it expires" is not worth a
worse answer.

### Priority mode gets all of it

Manual (`priority`) strategy never reaches `combineScore`, so each term is
denominated in **positions** there instead:

| Term | Positions | Effect |
|---|---|---|
| 429 penalty (existing) | `0..MAX_PENALTY` (10) | demotion |
| Quota scarcity | `0..MAX_PENALTY` (10) | demotion |
| Reset urgency | `0..HARVEST_MAX_POSITIONS` (1.25) | **promotion** |
| Provider diversity | `0..DIVERSITY_MAX_POSITIONS` (1.25) | demotion |

The two preferences get their own small scales so they move a route past exactly
one neighbour and never two. Reusing the penalty's `0..10` scale for harvesting
produced a 0.8-position promotion — enough to compute, never enough to overtake
the neighbour it was meant to overtake.

This is not an optional refinement: `routing_strategy` is `priority` on this
install, so a term omitted here is a term that never runs. Both spreading and
harvesting were originally left out of this branch and were dead in production
as a result.

### Provider diversity — a preference

Concurrent workers with no skip state between them all pick the same chain head.
Diversity damps a pool by its share of the attempts **currently in flight**, read
from the lease map that already exists for per-key concurrency. A sequential
caller never has two attempts open, so it is never spread and never pays for a
preference it cannot benefit from.

At `DIVERSITY_MAX_DAMP = 0.12` a fully contended route keeps 88% of its score:
enough to shade a close call, far too little to hand difficult work to a
materially worse model.

---

## 5. Verifying it, after the fact

Every signal above is computed per request and would otherwise be gone the
moment the choice was made. Two things make it checkable.

### The decision trace

`request_attempts.routing_json` records, per hop, what the router was looking at
when it picked that route. Served on `GET /api/analytics/requests/:id` as
`attempts[].routing`, and rendered under the hop in the Analytics failover
ladder — but only when something had an opinion, so a fully neutral trace prints
nothing rather than `1.00 · 1.00 · 1.00` on every row of every ladder.

| Field | Meaning |
|---|---|
| `strategy`, `poolKey` | which ordering ran, and the allowance the route draws on |
| `scarcity`, `harvest`, `diversity` | the three multipliers, as applied |
| `inFlightShare` | this pool's share of open attempts; **null below two**, which is why a sequential caller shows an inert diversity term |
| `scoringRank` / `scoringRankWithoutQuotaTerms` | position after scoring, and the counterfactual without the three quota-aware terms |
| `selectionRank` | position in the walk at which the route was actually **attempted** |
| `selectionOverride` | `explore` / `sticky` / `pinned` when a later stage moved it ahead of its score |
| `skipped[]` | verbatim dispositions of the candidates passed over first |

Two limits, stated because the fields are easy to over-read:

- **The ranks are scoring-stage.** `routeRequest` reorders on top of them — an
  exploration probe, a sticky-session pin, an explicitly pinned model — and then
  walks the result skipping gated candidates. `selectionRank` is where the route
  was attempted; `selectionOverride` names anything that promoted it for reasons
  unrelated to quota, and the UI reports the override *instead of* the rank move
  so the quota terms are not credited for someone else's decision.
- **The counterfactual removes the three terms together.** A move proves the
  quota-aware terms decided the route, not which one did. Where exactly one of
  the three is off-neutral the attribution is unambiguous from those fields;
  where several are, it is not, and the record does not pretend otherwise.

A `GET /api/fallback/routing` snapshot cannot substitute for this. It reports
scores as they are **now** — on quota that has moved, with a different set of
requests in flight — so it can show the machinery exists and never that a
particular past request was decided by it.

Nor can `X-Routed-Via`. It names the winner, not why it won. In particular
"fire three concurrent requests and watch them differ" proves nothing:
`inFlightPoolShare` returns null below two open attempts, and diversity is
capped at a 12% score damp (1.25 priority positions), subordinate to
eligibility, capability and provider preference. It is designed to shade a close
call, so a run where it changes nothing is the expected outcome.

Live rows from a six-way concurrent burst against `auto:fast-lane`:

```
groq/openai/gpt-oss-20b   share=null   div=1.000   rank 1->1   ← sequential: inert, by design
groq/openai/gpt-oss-20b   share=0.75   div=0.910   rank 1->1   ← contended, still the best route
groq/qwen/qwen3.6-27b     share=0      div=1.000   rank 2->1   ← spreading chose an idle pool
```

### The pool inventory

`GET /api/quota/providers` carries `members[]` per pool — the routed models that
spend it — rendered under the pool key in the Quota page's Provider Overview.
Without it the panel reported `ollama::weekly 540/10000` and never said whether
one overflow route or four chain heads were draining it, which is the fact that
decides what to do about it. It is also where a shared allowance stops reading
as depth: seven NVIDIA routes appear as seven names on **one** row.

Membership is resolved through `resolveQuotaPolicy`, the same pure function the
router uses, so the grouping cannot disagree with the accounting. Deriving it
from the pool-key string would break the first time a provider's identity
changes shape — which has happened once already, when Groq moved from
`groq::account` to `groq::model::<id>`.

Two rules the live panel forced out:

- **Window rows fall back to platform-wide.** A locally-limited row names a
  window (`nvidia::rolling-60s`, `nvidia::calendar_day`), not a pool. Those axes
  are account-scoped by construction, so every routed model on the platform
  spends them — platform-wide is the truthful membership, where string matching
  yields an empty set.
- **A paid balance names only what can bill it.** That fallback listed six
  `:free` routes under `openrouter::credits`, none of which can touch the paid
  balance, so credit pools are narrowed by `consumesPaidBalance`. Keyed on
  `::credits` and nothing else: Ollama's weekly balance is also denominated in
  credits but has no free/paid split, and a broader rule would have emptied the
  row that motivated this in the first place.

### The admission reason

When the gate closes a route it pushes `quota-domain-exhausted(<scope>:<metric>:<source>)`
into the routing diagnostics.

A refusal decided before any upstream was tried used to leave **no** database
trace: no `requests` row, no attempts, only a console line inside the container.
So a request the gate correctly turned away and one it wrongly turned away were
indistinguishable from the dashboard — both were simply absent. The loop now
logs one row for it, with platform `routing` (no provider was involved; a null
`key_id` is the documented shape for this class of rejection) and the verbatim
dispositions in the `error` column:

```
platform         routing
model_id         auto:probe
error            rate_limit_exceeded: opencode/nemotron-3-ultra-free:
                 1 key(s) — quota-domain-exhausted(provider_account:requests:operator):1
```

A request that SUCCEEDS after failing over past a blocked route is the harder
half: a 200 looks identical whether or not a gate fired. Those dispositions ride
on the served hop's trace in `skipped[]`, and reach the caller as
`X-Fallback-Skipped`:

```
HTTP/1.1 200 OK
X-Routed-Via: nvidia/nvidia/nemotron-3.5-lightning-30b-a3b
X-Fallback-Skipped: groq/openai/gpt-oss-20b: 1 key(s) - quota-domain-exhausted(provider_account:requests:operator):1;
                    groq/qwen/qwen3.6-27b: 1 key(s) - quota-domain-exhausted(provider_account:requests:operator):1
```

Note what is absent: no `X-Fallback-Attempts`, no `X-Fallback-Trail`. Those
describe hops that were **dispatched and failed**, and a route a gate refused is
never dispatched — so the trail structurally cannot carry this, and the request
previously returned 200 with no indication a gate had fired.

Behind the same opt-in as `X-Fallback-Detail` (`expose_fallback_detail_header`),
because the lines name quota scope, metric and which source stated the limit:
operator diagnostics, not something every API client should be handed by
default.

The reason also shapes the response three ways:

- `summarizeExhaustion` counts it under **quota allowance spent** — its own
  bucket, because it contains "domain-exhausted" and matched none of the
  existing patterns, so it previously fell into the catch-all `unavailable`;
- `classifyRoutingDiagLine` classifies it **time_bound**, so the response is a
  `429 rate_limit_exceeded` carrying a retry hint rather than a generic
  `routing_exhausted` with none. A spent allowance resets; waiting is the
  correct advice;
- `RouteError.diagnostics` carries the verbatim per-candidate line, which is
  what names the scope, the metric and **which source stated the limit** — the
  difference between correct enforcement and a misfiring gate.

---

## 6. Supply failure is lateral

Infrastructure failure — 429, timeout, provider unavailable, exhausted quota,
credit unavailable — moves **sideways inside the same capability class**:

```
auto:coding
  Qwen/Groq → 429
        ↓
  another coding-capable free route in the same chain
```

It never promotes the request to `auto:apex` or to a premium model. That is a
capability decision and it belongs to the harness. `skipModels` and
`skipPlatforms` in the fallback loop keep the walk inside the requested chain.

---

## 7. Credit safety

OpenRouter serves free and paid capacity through **one credential**, told apart
only by the model id's `:free` suffix. `consumesPaidBalance` bars anything
without it from auto chains; `routing_allow_paid_balance = true` is the explicit
opt-out. A request that *names* a paid model still routes — an explicit
instruction is not an accident. What cannot happen is `auto:coding` quietly
picking a paid twin because a catalogue sync added one and it scored well.

---

## 8. Curating the routed set

`server/src/data/routing-curation.ts` is the record of which routes are
production and why. `scripts/apply-routing-curation.ts` reconciles the live
`profile_models` rows with it:

```bash
tsx src/scripts/apply-routing-curation.ts             # dry run, prints the plan
tsx src/scripts/apply-routing-curation.ts --apply     # write it
```

It is re-runnable, which is the point: a catalogue sync that adds two hundred
models cannot silently widen a chain, because the next run switches off every
chain row the spec does not name.

**It never deletes catalogue data.** Models drop out of *routing*, not out of
existence — they stay in `/v1/models`, stay pinnable by name, and keep their
metadata. `models.enabled` is catalogue visibility and the applier does not touch
it.

### Classifications

`CORE`, `OVERFLOW`, `SPECIALIST`, `EXPERIMENTAL`; anything the spec does not name
is disabled from routing by omission. There is no classification column — chain
membership already decides eligibility, and adding a second store for the same
fact would only let them disagree. The label records the *intent* behind a
membership so a later reader can tell a deliberate overflow route from an
oversight.

`tools = false` is never a global rejection. It disqualifies a model from
agentic chains and from nothing else: image analysis does not need tool calls,
and rejecting vision models for lacking them would throw away most of the free
multimodal capacity.

---

## 9. Harness mapping

FreeLLMAPI stays harness-independent. This is the recommended Oh My Pi mapping,
not something the server enforces:

| OMP role | Chain |
|---|---|
| `DEFAULT` | `auto:frontier` |
| `TASK` | `auto:coding` |
| `SMOL` | `auto:fast-lane` |
| `TINY` | `auto:fast-lane` |
| `VISION` | `auto:vision` |
| `DESIGNER` | `auto:vision` |
| free escalation | `auto:apex` |

`PLAN`, `SLOW` and `ADVISOR` stay on premium subscription models. FreeLLMAPI
offers `auto:apex` as a free escalation option for when higher-level triage
elects to use it; it does not claim those roles.

Other consumers — Codex, Claude Code, plain OpenAI clients — use the same eight
aliases. They are cross-harness capability classes, not OMP terminology.
