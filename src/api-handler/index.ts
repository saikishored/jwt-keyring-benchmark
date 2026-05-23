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
  const randomId = await getRandomIdParam(RANDOM_ID_PARAM_NAME);
  if (!randomId)
    throw new Error(
      "randomId not found in param store — token-rotator must run first",
    );

  await dispatchAllShardBatches(randomId);
  await cleanupBenchmarkResources(randomId);
};

async function dispatchAllShardBatches(randomId: string): Promise<void> {
  for (let shardIndex = 1; shardIndex <= SHARD_COUNT; shardIndex++) {
    const secretName = `${randomId}/${SECRET_PREFIX}${shardIndex}`;
    const shardKeyRing = await fetchShardSecret(secretName);

    const tenantTokens = mintTenantTokensForShard(shardKeyRing);
    await callApiGatewayWithBatch(tenantTokens);

    if (shardIndex < SHARD_COUNT) {
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

  await Promise.all(
    tenantTokens.map((token) =>
      fetch(endpoint, {
        method: "GET",
        headers: { Cookie: `jwt=${token}` },
      }),
    ),
  );
}

async function cleanupBenchmarkResources(randomId: string): Promise<void> {
  await Promise.all(
    Array.from({ length: SHARD_COUNT }, (_, i) =>
      deleteShardSecret(`${randomId}/${SECRET_PREFIX}${i + 1}`),
    ),
  );
  await deleteRandomIdParam(RANDOM_ID_PARAM_NAME);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
