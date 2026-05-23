import * as jwt from "jsonwebtoken";
import { fetchShardSecret, deleteShardSecret } from "../common/secrets";
import { getRandomIdParam, deleteRandomIdParam } from "../common/params";
import { KeyRing, TenantKeyBucket, TenantJwtPayload } from "../common/types";

const RANDOM_ID_PARAM_NAME = process.env.ENCRYPTION_SECRET_PREFIX_PARAM!;
const SECRET_PREFIX = process.env.ENCRYPTION_KEYS_SECRET!;
const SHARD_COUNT = parseInt(process.env.ENCRYPTION_KEYS_SHARD_COUNT ?? "6");
const API_URL = process.env.API_URL!;

const JWT_TTL_SECONDS = 300; // 5-minute token lifetime
const INTER_BATCH_PAUSE_MS = 2 * 60 * 1000; // 2-minute pause between shard batches

export const handler = async (): Promise<void> => {
  console.log("[api-handler] handler started");
  console.log(`[api-handler] API_URL: ${API_URL}`);
  const randomId = await getRandomIdParam(RANDOM_ID_PARAM_NAME);
  if (!randomId)
    throw new Error(
      "randomId not found in param store — token-rotator must run first",
    );

  console.log(`[api-handler] randomId: ${randomId}`);
  await dispatchAllShardBatches(randomId);
  console.log("[api-handler] all shard batches complete — starting cleanup");
  await cleanupBenchmarkResources(randomId);
  console.log("[api-handler] cleanup complete — handler done");
};

async function dispatchAllShardBatches(randomId: string): Promise<void> {
  for (let shardIndex = 1; shardIndex <= SHARD_COUNT; shardIndex++) {
    const secretName = `${randomId}/${SECRET_PREFIX}${shardIndex}`;
    console.log(
      `[api-handler] shard ${shardIndex}/${SHARD_COUNT}: fetching secret ${secretName}`,
    );
    const shardKeyRing = await fetchShardSecret(secretName);
    const tenantCount = Object.keys(shardKeyRing).length;
    console.log(
      `[api-handler] shard ${shardIndex}: ${tenantCount} tenants found — minting tokens`,
    );

    const tenantTokens = mintTenantTokensForShard(shardKeyRing);
    console.log(
      `[api-handler] shard ${shardIndex}: making ${tenantTokens.length} API calls to ${API_URL}key-ring-test`,
    );
    await callApiGatewayWithBatch(tenantTokens);

    if (shardIndex < SHARD_COUNT) {
      console.log(
        `[api-handler] shard ${shardIndex}: sleeping ${INTER_BATCH_PAUSE_MS / 1000}s before next shard`,
      );
      await sleep(INTER_BATCH_PAUSE_MS);
    }
  }
}

function mintTenantTokensForShard(shardKeyRing: KeyRing): string[] {
  return Object.entries(shardKeyRing).map(([hashedKid, tenantBucket]) => {
    const latestEpochRef = resolveLatestEpochRef(tenantBucket);
    const signingSecret = tenantBucket[latestEpochRef];
    return signTenantJwt(
      hashedKid,
      latestEpochRef,
      tenantBucket.tid,
      signingSecret,
    );
  });
}

function resolveLatestEpochRef(tenantBucket: TenantKeyBucket): string {
  const epochRefs = Object.keys(tenantBucket)
    .filter((key) => key !== "tid")
    .sort((a, b) => Number(b) - Number(a)); // descending: latest first

  return epochRefs[0];
}

function signTenantJwt(
  hashedKid: string,
  epochRef: string,
  tid: string,
  signingSecret: string,
): string {
  const now = Math.floor(Date.now() / 1000);
  const payload: TenantJwtPayload = {
    tid,
    iss: "jwt-keyring-benchmark",
    iat: now,
    exp: now + JWT_TTL_SECONDS,
  };

  return jwt.sign(payload, signingSecret, {
    algorithm: "HS256",
    // kid + ref placed in header for authorizer key ring lookup
    header: {
      alg: "HS256",
      typ: "JWT",
      kid: hashedKid,
      ref: epochRef,
    } as jwt.JwtHeader,
  });
}

async function callApiGatewayWithBatch(tenantTokens: string[]): Promise<void> {
  const endpoint = `${API_URL}key-ring-test`;

  const responses = await Promise.all(
    tenantTokens.map((token) =>
      fetch(endpoint, {
        method: "GET",
        headers: { Cookie: `jwt=${token}` },
      }),
    ),
  );

  const statusCounts: Record<number, number> = {};
  for (const res of responses) {
    statusCounts[res.status] = (statusCounts[res.status] ?? 0) + 1;
  }
  console.log(
    `[api-handler] response status summary: ${JSON.stringify(statusCounts)}`,
  );
}

async function cleanupBenchmarkResources(randomId: string): Promise<void> {
  console.log(
    `[api-handler] deleting ${SHARD_COUNT} secrets and param store entry`,
  );
  await Promise.all(
    Array.from({ length: SHARD_COUNT }, (_, i) =>
      deleteShardSecret(`${randomId}/${SECRET_PREFIX}${i + 1}`),
    ),
  );
  await deleteRandomIdParam(RANDOM_ID_PARAM_NAME);
  console.log("[api-handler] cleanup done");
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
