import * as crypto from "crypto";
import { LambdaClient, InvokeCommand } from "@aws-sdk/client-lambda";
import {
  createShardSecret,
  updateShardSecret,
  fetchShardSecret,
} from "../common/secrets";
import { getRandomIdParam, putRandomIdParam } from "../common/params";
import { KeyRing, TenantKeyBucket } from "../common/types";

const SHARD_COUNT = parseInt(process.env.ENCRYPTION_KEYS_SHARD_COUNT ?? "6");
const TENANTS_PER_SHARD = parseInt(process.env.TENANTS_PER_SHARD ?? "175");
const SECRET_PREFIX = process.env.ENCRYPTION_KEYS_SECRET!;
const PARAM_NAME = process.env.ENCRYPTION_SECRET_PREFIX_PARAM!;
const API_HANDLER_FUNCTION_ARN = process.env.API_HANDLER_FUNCTION_ARN!;
const MAX_EPOCH_REFS_PER_TENANT = 4;
const INTER_ROUND_PAUSE_MS = 100 * 1000; // 100s between rotation rounds; api-handler loops every 2 min
const ROTATION_ROUNDS = 6; // rounds per invocation; matches api-handler shard batch count

const lambdaClient = new LambdaClient({});

export const handler = async (): Promise<void> => {
  console.log("[token-rotator] handler started");
  const existingRandomId = await getRandomIdParam(PARAM_NAME);
  console.log(
    `[token-rotator] randomId from param store: ${existingRandomId ?? "null — first run"}`,
  );

  if (existingRandomId === null) {
    console.log("[token-rotator] no existing randomId — starting from scratch");
    await runCycleFromScratch();
  } else {
    console.log(
      "[token-rotator] existing randomId found — running rotation cycle",
    );
    await runRotationCycle(existingRandomId);
  }
  console.log("[token-rotator] handler complete");
};

// First-ever EventBridge trigger: create all shards then run 5 more rotation rounds
async function runCycleFromScratch(): Promise<void> {
  const randomId = crypto.randomBytes(8).toString("hex");
  console.log(`[token-rotator] generated randomId: ${randomId}`);
  await putRandomIdParam(PARAM_NAME, randomId);
  console.log(`[token-rotator] stored randomId in param store`);

  // Round 1: create all 6 shards in parallel, fire api-handler async, then sleep
  console.log(`[token-rotator] round 1/${ROTATION_ROUNDS}: generating ${SHARD_COUNT} shards (${TENANTS_PER_SHARD} tenants each)`);
  const shards = Array.from({ length: SHARD_COUNT }, () =>
    generateShardKeyRing(),
  );
  await Promise.all(
    shards.map((shard, index) =>
      createShardSecret(buildSecretName(randomId, index + 1), shard),
    ),
  );
  console.log(`[token-rotator] round 1: all ${SHARD_COUNT} shards created in secrets manager`);
  await invokeApiHandlerAsync();
  console.log(`[token-rotator] round 1: api-handler invoked asynchronously`);
  console.log(`[token-rotator] round 1: sleeping ${INTER_ROUND_PAUSE_MS / 1000}s`);
  await sleep(INTER_ROUND_PAUSE_MS);

  // Rounds 2-6: rotate all shards in parallel, 100s between rounds
  for (let round = 2; round <= ROTATION_ROUNDS; round++) {
    console.log(`[token-rotator] round ${round}/${ROTATION_ROUNDS}: rotating all shards`);
    await rotateAllShards(randomId);
    console.log(`[token-rotator] round ${round}: rotation complete`);
    if (round < ROTATION_ROUNDS) {
      console.log(`[token-rotator] round ${round}: sleeping ${INTER_ROUND_PAUSE_MS / 1000}s`);
      await sleep(INTER_ROUND_PAUSE_MS);
    }
  }
}

// Subsequent EventBridge triggers: 6 rotation rounds, api-handler fired on round 1
async function runRotationCycle(randomId: string): Promise<void> {
  // Round 1: rotate + kick off api-handler for this benchmark cycle
  console.log(`[token-rotator] round 1/${ROTATION_ROUNDS}: rotating all shards`);
  await rotateAllShards(randomId);
  console.log(`[token-rotator] round 1: rotation complete`);
  await invokeApiHandlerAsync();
  console.log(`[token-rotator] round 1: api-handler invoked asynchronously`);
  console.log(`[token-rotator] round 1: sleeping ${INTER_ROUND_PAUSE_MS / 1000}s`);
  await sleep(INTER_ROUND_PAUSE_MS);

  // Rounds 2-6: rotate while api-handler runs concurrently
  for (let round = 2; round <= ROTATION_ROUNDS; round++) {
    console.log(`[token-rotator] round ${round}/${ROTATION_ROUNDS}: rotating all shards`);
    await rotateAllShards(randomId);
    console.log(`[token-rotator] round ${round}: rotation complete`);
    if (round < ROTATION_ROUNDS) {
      console.log(`[token-rotator] round ${round}: sleeping ${INTER_ROUND_PAUSE_MS / 1000}s`);
      await sleep(INTER_ROUND_PAUSE_MS);
    }
  }
}

// Rotate all 6 shards in parallel — one rotation round
async function rotateAllShards(randomId: string): Promise<void> {
  await Promise.all(
    Array.from({ length: SHARD_COUNT }, async (_, i) => {
      const secretName = buildSecretName(randomId, i + 1);
      const existingKeyRing = await fetchShardSecret(secretName);
      const rotatedKeyRing = rotateEpochRefsAcrossShard(existingKeyRing);
      await updateShardSecret(secretName, rotatedKeyRing);
    }),
  );
}

function generateShardKeyRing(): KeyRing {
  const shardKeyRing: KeyRing = {};

  for (let i = 0; i < TENANTS_PER_SHARD; i++) {
    const tid = crypto.randomUUID();
    const hashedKid = crypto.createHash("sha256").update(tid).digest("hex");
    const epochRef = String(new Date().getTime());
    const signingSecret = crypto.randomUUID();

    shardKeyRing[hashedKid] = {
      tid,
      [epochRef]: signingSecret,
    };
  }

  return shardKeyRing;
}

function rotateEpochRefsAcrossShard(keyRing: KeyRing): KeyRing {
  const rotatedKeyRing: KeyRing = {};

  for (const [hashedKid, tenantBucket] of Object.entries(keyRing)) {
    rotatedKeyRing[hashedKid] = rotateTenantEpochRef(tenantBucket);
  }

  return rotatedKeyRing;
}

function rotateTenantEpochRef(tenantBucket: TenantKeyBucket): TenantKeyBucket {
  const epochRefs = extractEpochRefs(tenantBucket).sort(); // ascending: oldest first

  const newEpochRef = String(new Date().getTime());
  const newSigningSecret = crypto.randomUUID();
  const updatedBucket: TenantKeyBucket = {
    ...tenantBucket,
    [newEpochRef]: newSigningSecret,
  };

  if (epochRefs.length >= MAX_EPOCH_REFS_PER_TENANT) {
    // FIFO: remove oldest ref to cap at MAX_EPOCH_REFS_PER_TENANT
    delete updatedBucket[epochRefs[0]];
  }

  return updatedBucket;
}

function extractEpochRefs(tenantBucket: TenantKeyBucket): string[] {
  return Object.keys(tenantBucket).filter((key) => key !== "tid");
}

async function invokeApiHandlerAsync(): Promise<void> {
  await lambdaClient.send(
    new InvokeCommand({
      FunctionName: API_HANDLER_FUNCTION_ARN,
      InvocationType: "Event", // fire-and-forget
      Payload: JSON.stringify({}),
    }),
  );
}

function buildSecretName(randomId: string, shardIndex: number): string {
  return `${randomId}/${SECRET_PREFIX}${shardIndex}`;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
