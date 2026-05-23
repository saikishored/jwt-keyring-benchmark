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
const INTER_SHARD_PAUSE_MS = 100 * 1000; // 100s wait between shard iterations (api-handler loops every 2 min)

const lambdaClient = new LambdaClient({});

export const handler = async (): Promise<void> => {
  const existingRandomId = await getRandomIdParam(PARAM_NAME);

  if (existingRandomId === null) {
    await handleFirstCycle();
  } else {
    await handleRotationCycle(existingRandomId);
  }
};

async function handleFirstCycle(): Promise<void> {
  const randomId = crypto.randomBytes(8).toString("hex");
  await putRandomIdParam(PARAM_NAME, randomId);

  const shards = Array.from({ length: SHARD_COUNT }, () =>
    generateShardKeyRing(),
  );
  await Promise.all(
    shards.map((shard, index) =>
      createShardSecret(buildSecretName(randomId, index + 1), shard),
    ),
  );

  await invokeApiHandlerAsync();
}

async function handleRotationCycle(randomId: string): Promise<void> {
  for (let shardIndex = 1; shardIndex <= SHARD_COUNT; shardIndex++) {
    const secretName = buildSecretName(randomId, shardIndex);
    const existingKeyRing = await fetchShardSecret(secretName);
    const rotatedKeyRing = rotateEpochRefsAcrossShard(existingKeyRing);
    await updateShardSecret(secretName, rotatedKeyRing);

    if (shardIndex < SHARD_COUNT) {
      await sleep(INTER_SHARD_PAUSE_MS);
    }
  }
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
