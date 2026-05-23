import * as jwt from "jsonwebtoken";
import * as AWSXRay from "aws-xray-sdk-core";
import {
  APIGatewayRequestAuthorizerEvent,
  APIGatewayAuthorizerResult,
} from "aws-lambda";
import { fetchAllKeyRingShards } from "../common/secrets";
import { getRandomIdParam } from "../common/params";
import { KeyRing, JwtKeyRingHeader, TenantJwtPayload } from "../common/types";

const CACHE_REFRESH_IN_SECONDS = parseInt(
  process.env.CACHE_REFRESH_IN_SECONDS ?? "180",
);
const ENCRYPTION_KEYS_SECRET = process.env.ENCRYPTION_KEYS_SECRET!;
const ENCRYPTION_KEYS_SHARD_COUNT = parseInt(
  process.env.ENCRYPTION_KEYS_SHARD_COUNT ?? "6",
);
const ENCRYPTION_SECRET_PREFIX_PARAM =
  process.env.ENCRYPTION_SECRET_PREFIX_PARAM!;

// ── Global state: persists across warm invocations on the same Lambda instance ──
let keyRing: KeyRing = {};
let cacheLoadedAtSeconds = 0;
let isColdStart = true;

// Eagerly begin loading the key ring during module initialisation (cold start)
console.log("[authorizer] cold start — beginning key ring load");
let coldStartLoadPromise: Promise<void> = loadAndCacheKeyRing();

async function loadAndCacheKeyRing(): Promise<void> {
  const randomId = await getRandomIdParam(ENCRYPTION_SECRET_PREFIX_PARAM);
  if (!randomId)
    throw new Error("randomId param not found — run token-rotator first");

  console.log(`[authorizer] loading ${ENCRYPTION_KEYS_SHARD_COUNT} key ring shards for randomId: ${randomId}`);
  keyRing = await fetchAllKeyRingShards(
    randomId,
    ENCRYPTION_KEYS_SECRET,
    ENCRYPTION_KEYS_SHARD_COUNT,
  );
  cacheLoadedAtSeconds = Math.floor(Date.now() / 1000);
  console.log(`[authorizer] key ring loaded — ${Object.keys(keyRing).length} tenants cached`);
}

export const handler = async (
  event: APIGatewayRequestAuthorizerEvent,
): Promise<APIGatewayAuthorizerResult> => {
  console.log(`[authorizer] invoked — methodArn: ${event.methodArn}`);
  const segment = AWSXRay.resolveSegment();

  await ensureKeyRingReady(segment);

  const cookieHeader =
    event.headers?.["Cookie"] ?? event.headers?.["cookie"] ?? "";
  const token = extractJwtFromCookie(cookieHeader);
  if (!token) {
    console.log("[authorizer] no jwt cookie found — denying");
    return denyPolicy("anonymous", event.methodArn);
  }

  return await verifyTokenAgainstKeyRing(token, event.methodArn, segment);
};

// ── Key ring cache management ─────────────────────────────────────────────────

async function ensureKeyRingReady(
  segment: AWSXRay.Segment | AWSXRay.Subsegment | undefined,
): Promise<void> {
  if (isColdStart) {
    console.log("[authorizer] scenario: cold-start — awaiting key ring load");
    await trackWithSubsegment(segment, "cold-start", async () => {
      try {
        await coldStartLoadPromise;
      } catch (err) {
        console.log(`[authorizer] cold-start load failed (${(err as Error).message}) — retrying`);
        coldStartLoadPromise = loadAndCacheKeyRing();
        await coldStartLoadPromise;
      }
      isColdStart = false;
    });
    console.log("[authorizer] cold-start complete");
    return;
  }

  const nowInSeconds = Math.floor(Date.now() / 1000);
  const cacheAge = nowInSeconds - cacheLoadedAtSeconds;

  if (cacheAge > CACHE_REFRESH_IN_SECONDS) {
    console.log(`[authorizer] scenario: cache-refresh — cache age ${cacheAge}s > ${CACHE_REFRESH_IN_SECONDS}s threshold`);
    await trackWithSubsegment(segment, "cache-refresh", () =>
      loadAndCacheKeyRing(),
    );
    console.log("[authorizer] cache-refresh complete");
  } else {
    console.log(`[authorizer] scenario: cache-hit — cache age ${cacheAge}s`);
  }
}

// ── Token verification ────────────────────────────────────────────────────────

async function verifyTokenAgainstKeyRing(
  token: string,
  methodArn: string,
  segment: AWSXRay.Segment | AWSXRay.Subsegment | undefined,
): Promise<APIGatewayAuthorizerResult> {
  const decoded = jwt.decode(token, { complete: true });
  if (!decoded) {
    console.log("[authorizer] token decode failed — denying");
    return denyPolicy("anonymous", methodArn);
  }

  const { kid, ref } = decoded.header as JwtKeyRingHeader;
  console.log(`[authorizer] kid: ${kid?.substring(0, 8)}... ref: ${ref}`);

  let signingSecret = keyRing[kid]?.[ref];

  if (!signingSecret) {
    // Post-rotation miss: ref was added by token-rotator after our cache loaded.
    // Reload the ring once and retry — this is the rotation-miss scenario.
    console.log(`[authorizer] scenario: rotation-miss — ref not in cache, reloading ring`);
    await trackWithSubsegment(segment, "rotation-miss", () => loadAndCacheKeyRing());
    console.log("[authorizer] rotation-miss reload complete");
    signingSecret = keyRing[kid]?.[ref];
  }

  if (!signingSecret) {
    console.log(`[authorizer] key ring miss after reload — kid not found or ref invalid — denying`);
    return denyPolicy("unknown", methodArn);
  }

  const cacheHitSubsegment = segment?.addNewSubsegment("cache-hit");
  cacheHitSubsegment?.addAnnotation("scenario", "cache-hit");

  try {
    const payload = jwt.verify(token, signingSecret) as TenantJwtPayload;
    console.log(`[authorizer] token verified — allowing tid: ${payload.tid}`);
    return allowPolicy(payload.tid, methodArn, payload.tid);
  } catch (err) {
    console.log(`[authorizer] jwt.verify failed: ${(err as Error).message} — denying`);
    return denyPolicy("unknown", methodArn);
  } finally {
    cacheHitSubsegment?.close();
  }
}

// ── X-Ray subsegment helper ───────────────────────────────────────────────────

async function trackWithSubsegment(
  segment: AWSXRay.Segment | AWSXRay.Subsegment | undefined,
  name: string,
  work: () => Promise<void>,
): Promise<void> {
  const subsegment = segment?.addNewSubsegment(name);
  subsegment?.addAnnotation("scenario", name);
  subsegment?.addAnnotation("shardCount", ENCRYPTION_KEYS_SHARD_COUNT);

  try {
    await work();
  } finally {
    subsegment?.close();
  }
}

// ── IAM policy builders ───────────────────────────────────────────────────────

function allowPolicy(
  principalId: string,
  methodArn: string,
  tid: string,
): APIGatewayAuthorizerResult {
  return {
    principalId,
    policyDocument: {
      Version: "2012-10-17",
      Statement: [
        { Action: "execute-api:Invoke", Effect: "Allow", Resource: methodArn },
      ],
    },
    context: { tid },
  };
}

function denyPolicy(
  principalId: string,
  methodArn: string,
): APIGatewayAuthorizerResult {
  return {
    principalId,
    policyDocument: {
      Version: "2012-10-17",
      Statement: [
        { Action: "execute-api:Invoke", Effect: "Deny", Resource: methodArn },
      ],
    },
  };
}

// ── Cookie parsing ────────────────────────────────────────────────────────────

function extractJwtFromCookie(cookieHeader: string): string | null {
  const match = cookieHeader.match(/(?:^|;\s*)jwt=([^;]+)/);
  return match ? match[1] : null;
}
