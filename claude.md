# JWT Key Ring Benchmark

This document contains claude instructions to build and deploy resources needed for benchmarking key-ring pattern instead of JWKS in authorization layer

## Objective

Objective of this repo is to benchmark key-ring pattern performance at p50, p90 and p99 levels

## key-ring pattern

Load all tenant secrets once at cold start into an in-memory map (the "ring"), keyed by a hashed tenant ID + epoch ref

ring[hashed_kid][ref] → secret

Every subsequent token verification is a pure in-memory O(1) lookup + jwt.verify() — zero network calls on the hot path.

To enable kill switch, memory refreshal happens every x minutes. 15 minutes could be ideal. In this example, it is 3 minutes

## Data

1050 tenant ids (`tid`) to be generated randomly each having own keys up to 4. These are stored in JSON secret in the following format:

```
{
  <hashed_kid_1>:{
    tid: "1234",
    <epoch_timestamp_as_ref1>:"secret_key",
    <epoch_timestamp_as_ref2>:"secret_key",
    <epoch_timestamp_as_ref3>:"secret_key",
    <epoch_timestamp_as_ref4>:"secret_key"
  },
  <hashed_kid_5>:{
    tid: "1235",
    <epoch_timestamp_as_ref1>:"secret_key",
    <epoch_timestamp_as_ref2>:"secret_key",
    <epoch_timestamp_as_ref3>:"secret_key",
    <epoch_timestamp_as_ref4>:"secret_key"
  }
}

```

secrets naming `{randomId}/auth/encryption-keys/shard_1` to `{randomId}/auth/encryption-keys/shard_6`

Each tenant requires ~ 334 bytes of data. Each AWS secret can store 65,536 bytes. Allocating 175 secrets per secret, 6 secrets needed to store 1050 tenants

value of `{randomId}` is stored in param store `/encryption-keys-random-id`

## Tech Stack

1. API Gateway
2. Lambda
3. X-Ray
4. Param store
5. Cloudwatch log
6. AWS Secrets
7. AWS CDK Typescript as IaC
8. Typescript as programming language

## Resources Needed

1. API Gateway
2. Custom Authorizer lambda `authorizer`
3. Token Rotator lambda `token-rotator`
4. Service lambda (Hello lambda) `hello-service` integration with API Gateway for route `GET /key-ring-test` and attached with `authorizer`
5. API Calls Handler lambda `api-handler`
6. 6 secrets

## Folder structure

1. Root folder has 2 folders - `iac` and `src`
2. `iac` contains CDK Typescript code to deploy all required resources
3. `src` contains source code for all 4 lambdas

### src

#### Workflow

1. Eventbridge invokes lambda `token-rotator` once in an hour for 10 hours (It should have calculated EndDate to ensure it gets disabled). Each rotation for a fresh cycle of benchmark so that average can be taken to arrive at metrics
2. `token-rotator` performs following actions:
   1. Define a constant `randomId` using `crypto.randomBytes(8).toString("hex")` as value. Store this value in param store `/encryption-keys-random-id` (create)
   2. Iterate 6 times using for loop. In first iteration, generate an array of 6 JSON objects each containing 175 `hashed_kid`s. In the subsequent iterations, update those secrets with new ref as explained in following steps (Steps 3 to 8 are for first iteration only)
   3. Each JSON object contains 175 hashed_kids
   4. Need to generate these values randomly
   5. First generate tenant id `tid` using `crypto.randomUUID()`
   6. Generate hashed_kid from `crypto.createHash("sha256").update(tid).digest("hex")`
   7. hashed_kid is a key for JSON object that contains following {"tid":"random_UUID", "new Date().getTime()":"crypto.randomUUID()"}. Here timestamp represents `epoch_timestamp_as_ref`
   8. Create 6 secrets with above Array as mentioned in Data section
   9. invoke `api-handler` lambda asynchronously (only in 1st iteration)
   10. Wait for 100 seconds and go for next iteration
   11. From this iteration#2, retrieve secrets and add additional `epoch_timestamp_as_ref` until 4 keys are generated. Later delete the oldest ref (FIFO basis) and add a new one.
   12. Update the secrets
   13. Repeat Step 10 and complete the iterations in the same way

3. `api-handler` lambda performs the following:
   Prerequisite: Lambda shall have following env variables
   - `ENCRYPTION_SECRET_PREFIX_PARAM` ("/encryption-keys-random-id")
   - `ENCRYPTION_KEYS_SECRET`("auth/encryption-keys/shard\_")
   - `ENCRYPTION_KEYS_SHARD_COUNT` (6)
   - `API_URL`.
   1. Makes 1050 API calls to API Gateway in 6(`ENCRYPTION_KEYS_SHARD_COUNT`) batches with each batch consisting of 175 tenants. First downloads value of `randomId` from param `ENCRYPTION_SECRET_PREFIX_PARAM` (`/encryption-keys-random-id`).
   2. For every iteration `n`, it retrieves secret `${randomId}/auth/encryption-keys/shard_n` and parse secret value
   3. For each `hashed_kid` in JSON, take the secret from latest `epoch_timestamp_as_ref` and generates an signed JWT cookie (5 minutes expiry). JWT to be in standard format, payload contains `tid` attribute with value from secret. It should also contain standard other standard attributes like `claims`. In metadata, value of `kid` should be `hashed_kid` and should have additional attribute `ref`, which is latest `epoch_timestamp_as_ref`(ref key with highest epoch value).
   4. Make an API caller to API Gateway route `GET /key-ring-test` by setting header `Cookie`. Use Promise.all() to make all calls at once
   5. Once response received, wait for 2 minutes using sleep method
   6. Complete all iterations in the same way
   7. After completing all iterations, delete all 6 secrets and also param as a clean up exercise

4. `hello-service` lambda simply receives request, logs requestContext data from API Gateway event and gives 200 response with a hello message
5. `authorizer` lambda is the key lambda for this benchmarking exercise. It should have `X-Ray` configured to generate metrics later. It performs the following:
   Prerequisite: Lambda shall have following env variables
   - `CACHE_REFRESH_IN_SECONDS`("180")
   - `ENCRYPTION_KEYS_SECRET`("auth/encryption-keys/shard\_")
   - `ENCRYPTION_KEYS_SHARD_COUNT` (6)
   - `ENCRYPTION_SECRET_PREFIX_PARAM` (`/encryption-keys-random-id`)
   1. During cold-start, it downloads all 6 secrets using Promise.all() and merge them as a single JSON. This JSON contains 1050 keys each representing a tenant hashed_kid
   2. It needs to define a global variable `startTime` with epoch timestamp as value
   3. In the handler function, first check difference between `startTime` and current timestamp. If > `CACHE_REFRESH_IN_SECONDS`, then downloads all 6 secrets and refresh the memory of keys
   4. It takes `kid` and `ref` values from header cookie and derives secret key. Use that key to verify token and add payload to requestContext.
   5. Ensure `X-Ray` catches time for `cache-refresh`, `cold-start`, `cache-hit` metrics to get p50 / p90 / p99 metrics per scenario
      1. `cold-start` When `api-handler` makes first batch of calls to 175 tenants, this could make 175 cold start invocations. There 10 cycles resulting into 175 \* 10 = 1750 samples
      2. `cache-refresh` Assuming 100 concurrency for `authorizer` lambda, which of these run multiple times for a period of 12 minutes (`api-handler` waits for 2 minutes at the end of iteration and there are 6 iterations), refresh happens for 3-4 times and for ~100 invocations. It gives a sample of 300-400 refresh scenarios
      3. `cache-hit` - All remaining invocations will come under this category

#### Coding Pattern

1. Each Lambdas should have `handler` method
2. `handler` method works as an orchestrator
3. Create separate methods for each action (Single Responsibility Principle)
4. In src folder, there will be 4 folders each representing a lambda and within it, `index.ts` contains lambda code. Create an additional folder `common` that houses common code between lambdas (if any)
5. Follow `Domain Driven Design` so that variable names represent what they are in the context of `key-ring pattern`

### iac

1. Use CDK Typescript to generate IaC.
2. Single App with separate stacks for each resource
3. Ensure to supply env variables for lambdas as required for their functionality. For ex., `api-handler` needs env variable `API_URL`, which should be API Gateway url including stage name.
4. Based on the functionality, create IAM role for each service as needed.
