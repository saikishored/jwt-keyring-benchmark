# jwt-keyring-benchmark

Benchmarks the JWT Key Ring pattern at p50 / p90 / p99 latency across three
real-world scenarios: cold start, warm cache hit, and cache-refresh.

The pattern replaces the conventional single-secret or JWKS approach with an
in-memory map (`ring[hashed_kid][ref] → secret`) loaded once at Lambda cold
start and refreshed on a TTL. Every token verification on the warm path is a
pure in-memory O(1) map lookup + `jwt.verify()` — zero network calls.

---

## Architecture Overview

```
EventBridge (hourly, 10 cycles)
  └── token-rotator Lambda
        ├── Creates / rotates 6 Secrets Manager shards (1,050 tenants)
        ├── Stores randomId in SSM Parameter Store
        └── Invokes api-handler Lambda (async, first iteration only)

api-handler Lambda
  └── For each of 6 shards (175 tenants each):
        ├── Reads shard secret
        ├── Signs JWT per tenant (HS256, kid + ref in header)
        ├── Calls GET /key-ring-test via API Gateway (Promise.all)
        └── Waits 2 minutes, then repeats for next shard batch

API Gateway (GET /key-ring-test)
  └── authorizer Lambda  ←── X-Ray traces: cold-start / cache-hit / cache-refresh
        └── hello-service Lambda  (returns 200 + hello message)
```

### AWS Resources Deployed

| Resource                 | Name / Purpose                                                      |
| ------------------------ | ------------------------------------------------------------------- |
| API Gateway              | REST API with `GET /key-ring-test`                                  |
| Lambda — `authorizer`    | Custom token authorizer; key ring lookup + jwt.verify               |
| Lambda — `token-rotator` | Creates and rotates 6 key ring shards per cycle                     |
| Lambda — `api-handler`   | Drives 1,050 API calls per batch; cleans up at end                  |
| Lambda — `hello-service` | Downstream handler; returns 200                                     |
| Secrets Manager (x6)     | `{randomId}/auth/encryption-keys/shard_1` … `shard_6`               |
| SSM Parameter Store      | `/encryption-keys-random-id` — shared randomId across lambdas       |
| EventBridge Rule         | Triggers `token-rotator` hourly; auto-disabled after 10 invocations |
| X-Ray                    | Active tracing on `authorizer`; p50/p90/p99 per scenario            |
| CloudWatch Logs          | Log groups for all four lambdas                                     |

---

## Prerequisites

- **Node.js** 20.x or later
- **AWS CLI** configured (`aws configure`) with credentials for the target account
- **AWS CDK** v2 installed globally: `npm install -g aws-cdk`
- CDK bootstrapped in the target account/region (one-time):

```bash
cdk bootstrap aws://<ACCOUNT_ID>/<REGION>
```

---

## Deploy

```bash
# 1. Clone and install
git clone <repo-url>
cd jwt-keyring-benchmark
npm install

# 2. Deploy the full stack
cd iac
cdk deploy --all
```

CDK will print the API Gateway URL on completion. The `api-handler` Lambda
receives this URL automatically via its `API_URL` environment variable — no
manual configuration required.

> **Cost note:** The benchmark uses Secrets Manager (6 secrets), SSM, Lambda,
> API Gateway, and X-Ray. All are pay-per-use. Expected cost for a single
> 10-cycle run: under $1 USD.

---

## Run the Benchmark

The benchmark starts automatically once deployed. EventBridge fires
`token-rotator` once an hour.

Post deployment, wait for 5 minutes when scheduler invokes `token-rotator`

`api-handler` is invoked asynchronously by `token-rotator` on the first
rotation cycle and runs all 1,050 API calls from that point forward without
further intervention. It makes 6 iterations 6 \*1050 calls with sleep time of 2 minutes between each iteration

---

## View Results (X-Ray)

1. Open **AWS Console → X-Ray → Traces**
2. Filter by annotation:

| Annotation    | Values                                    |
| ------------- | ----------------------------------------- |
| `scenario`    | `cold-start`, `warm-hit`, `cache-refresh` |
| `tenantCount` | `1050`                                    |
| `shardCount`  | `6`                                       |

3. Switch to **Trace Analytics** for p50 / p90 / p99 distributions per scenario.

For additional percentiles, use **CloudWatch Logs Insights** on the authorizer
log group:

```
filter @type = "REPORT"
| stats pct(@duration, 50), pct(@duration, 90), pct(@duration, 99) by bin(5m)
```

### Expected Sample Sizes

| Scenario        | How it occurs                                                                             | Approx. samples |
| --------------- | ----------------------------------------------------------------------------------------- | --------------- |
| `cold-start`    | First batch of 175 calls per cycle × 10 cycles — Lambda initialises, fetches all 6 shards | ~1,750          |
| `warm-hit`      | TTL has not expired — pure in-memory O(1) lookup, zero network calls                      | ~8,600          |
| `cache-refresh` | 180 s TTL expired — all 6 shards reloaded in parallel before lookup                       | ~300–400        |

> **Note — `rotation-miss` (not currently instrumented):** A fourth scenario
> exists where `ring[kid][ref]` returns `undefined` because `token-rotator`
> added a new epoch ref after the last cache load but before the 3-minute TTL
> fires. This is distinct from `cache-refresh`: it would reload only the single
> affected shard (~2 ms) rather than all 6 (~10 ms). Adding a `rotation-miss`
> X-Ray subsegment on ref-miss + targeted single-shard reload is recommended
> when building the authorizer Lambda.

---

## Destroy

The `api-handler` Lambda cleans up the 6 Secrets Manager shards and the SSM
parameter automatically after completing all iterations. To tear down the
remaining CDK infrastructure:

```bash
cd iac
cdk destroy --all
```

---

## How It Works (Post-Deploy Detail)

### 1. token-rotator — Key Ring Bootstrapping and Rotation

EventBridge triggers this Lambda once per hour for 10 hours (the EventBridge
rule has a calculated end time so it disables itself automatically).

**First invocation:**

1. Generates a `randomId` (`crypto.randomBytes(8).toString("hex")`) and stores
   it in SSM Parameter Store at `/encryption-keys-random-id`.
2. Generates 1,050 tenant IDs (`crypto.randomUUID()`), each with a
   SHA-256-derived `hashed_kid` and one initial epoch-keyed signing secret.
3. Packs 175 tenants per shard → creates 6 Secrets Manager secrets named
   `{randomId}/auth/encryption-keys/shard_1` through `shard_6`.
4. Invokes `api-handler` **asynchronously** (fire-and-forget).
5. Waits 100 seconds, then proceeds to the next internal iteration (adding
   more epoch refs to the ring to simulate rotation).

**Subsequent invocations (rotations):**

- Reads each shard, adds a new epoch timestamp ref with a fresh secret, and
  deletes the oldest ref (FIFO). Maximum 4 refs per tenant at any time.
- Updates all 6 shards in Secrets Manager.
- This mimics production rotation: existing tokens (signed with the previous
  ref) remain valid while the ring holds that ref; only the oldest ref
  is dropped.

### 2. api-handler — Driving the Load

Reads `randomId` from SSM, then iterates over all 6 shards:

1. For each shard, reads the current secret.
2. For each `hashed_kid` in the shard, takes the **latest epoch ref** (highest
   timestamp) and signs a JWT:
   - Header: `{ alg: "HS256", typ: "JWT", kid: <hashed_kid>, ref: <epoch_ref> }`
   - Payload: `{ tid, iss, iat, exp }` (5-minute expiry)
3. Makes all 175 calls in a single `Promise.all()` to `GET /key-ring-test`
   with the JWT in the `Cookie` header.
4. Waits 2 minutes (the 3-minute TTL will fire during this gap, generating
   `cache-refresh` samples on the next batch of calls).
5. Repeats for all 6 shards.
6. After all iterations complete, deletes all 6 secrets and the SSM parameter.

### 3. authorizer — The Key Ring Verifier

This is the Lambda under measurement. X-Ray active tracing is enabled.

**Cold start (measured as `cold-start` segment):**

```
Lambda initialises
  → reads randomId from SSM Parameter Store
  → fetches all 6 shards in parallel (Promise.all)
  → merges into single in-memory KeyRing map (1,050 entries)
  → sets global startTime = Date.now()
```

**Every invocation:**

1. Checks `Date.now() - startTime > CACHE_REFRESH_IN_SECONDS` (180 seconds).
   - If true: reloads all 6 shards → recorded as `cache-refresh` X-Ray segment.
   - If false: uses cached ring → no network calls.
2. Decodes the incoming JWT header (no verification yet) → extracts `kid` + `ref`.
3. Looks up `ring[kid][ref]` — O(1) map access (~0.1 ms).
   - On miss: token is denied. A `rotation-miss` subsegment (targeted
     single-shard reload + retry) is not yet instrumented — see note in
     Expected Sample Sizes.
4. Calls `jwt.verify(token, secret)` (~1 ms).
5. Returns an API Gateway allow policy with tenant context; returns deny on
   any failure.

**Key Ring data structure in memory:**

```
{
  "<hashed_kid_sha256>": {
    "tid": "<uuid>",
    "<epoch_ms_1>": "<signing_secret>",
    "<epoch_ms_2>": "<signing_secret>",
    "<epoch_ms_3>": "<signing_secret>",
    "<epoch_ms_4>": "<signing_secret>"
  },
  ...  // 1,049 more tenants
}
```

### 4. hello-service — Downstream Handler

Receives the request after the authorizer allows it, logs
`event.requestContext` (which contains tenant context injected by the
authorizer), and returns:

```json
{ "message": "Hello from Key Ring Benchmark!" }
```

Its sole purpose is to confirm that authorized requests reach the downstream
handler and to generate a complete end-to-end trace in X-Ray.

---

## Key Design Decisions

### Why HS256 and not RS256 / JWKS?

The same platform both issues and verifies tokens. There is no external IdP.
HS256 (symmetric) is the correct choice — the secret never needs to be shared
with a third party, and there is no `/.well-known/jwks.json` endpoint to
maintain or cache-stampede.

RS256 + JWKS is correct when an external IdP (Okta, Auth0, Cognito) issues
tokens to your API. Both patterns are valid at different trust boundaries.

### Why not KMS per-verification?

KMS adds 50–300 ms network latency per invocation (same-region p50) and
charges per API call. At 10 M verifications/day that is $900–$4,500/month
in KMS cost alone. The Key Ring achieves per-tenant secret isolation through
in-memory map partitioning — KMS is used only at key submission time (envelope
encryption in transit), not on the hot path.

### Cache TTL — 3 minutes (benchmark) vs 15 minutes (production)

3 minutes is used here so that the `cache-refresh` scenario fires 3–4 times
per Lambda instance within the 12-minute `api-handler` run window (6 shard
batches × 2-minute waits), producing 300–400 cache-refresh samples. Production
default is 15 minutes, which is also the kill-switch exposure window —
deleting an epoch ref from Secrets Manager invalidates all tokens signed with
that ref within 15 minutes, no blocklist required.

---

## Project Structure

```
jwt-keyring-benchmark/
├── iac/                    # CDK TypeScript (IaC)
│   ├── bin/app.ts          # CDK App entry point
│   ├── cdk.json
│   └── lib/                # CDK stacks (one per resource group)
├── src/
│   ├── common/
│   │   ├── types.ts        # KeyRing, TenantKeyBucket, JwtKeyRingHeader types
│   │   ├── secrets.ts      # Secrets Manager helpers (fetch/create/update/delete)
│   │   └── params.ts       # SSM Parameter Store helpers
│   ├── authorizer/
│   │   └── index.ts        # Lambda authorizer — key ring verifier (X-Ray instrumented)
│   ├── token-rotator/
│   │   └── index.ts        # Key ring bootstrap + rotation
│   ├── api-handler/
│   │   └── index.ts        # Load driver — signs JWTs and makes API calls
│   └── hello-service/
│       └── index.ts        # Downstream handler — returns 200
├── package.json
└── README.md
```

---

## Tech Stack

- **Runtime:** Node.js 24.x / TypeScript
- **IaC:** AWS CDK v2 (TypeScript)
- **JWT:** `jsonwebtoken` (HS256)
- **Tracing:** AWS X-Ray (`aws-xray-sdk-core`)
- **AWS Services:** Lambda, API Gateway, Secrets Manager, SSM Parameter Store,
  EventBridge, X-Ray, CloudWatch Logs
