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
const coldStartLoadPromise: Promise<void> = loadAndCacheKeyRing();

async function loadAndCacheKeyRing(): Promise<void> {
  const randomId = await getRandomIdParam(ENCRYPTION_SECRET_PREFIX_PARAM);
  if (!randomId)
    throw new Error("randomId param not found — run token-rotator first");

  keyRing = await fetchAllKeyRingShards(
    randomId,
    ENCRYPTION_KEYS_SECRET,
    ENCRYPTION_KEYS_SHARD_COUNT,
  );
  cacheLoadedAtSeconds = Math.floor(Date.now() / 1000);
}

export const handler = async (
  event: APIGatewayRequestAuthorizerEvent,
): Promise<APIGatewayAuthorizerResult> => {
  const segment = AWSXRay.resolveSegment();

  await ensureKeyRingReady(segment);

  const cookieHeader =
    event.headers?.["Cookie"] ?? event.headers?.["cookie"] ?? "";
  const token = extractJwtFromCookie(cookieHeader);
  if (!token) return denyPolicy("anonymous", event.methodArn);

  return verifyTokenAgainstKeyRing(token, event.methodArn, segment);
};

// ── Key ring cache management ─────────────────────────────────────────────────

async function ensureKeyRingReady(
  segment: AWSXRay.Segment | AWSXRay.Subsegment | undefined,
): Promise<void> {
  if (isColdStart) {
    await trackWithSubsegment(segment, "cold-start", async () => {
      await coldStartLoadPromise;
      isColdStart = false;
    });
    return;
  }

  const nowInSeconds = Math.floor(Date.now() / 1000);
  const cacheAge = nowInSeconds - cacheLoadedAtSeconds;

  if (cacheAge > CACHE_REFRESH_IN_SECONDS) {
    await trackWithSubsegment(segment, "cache-refresh", () =>
      loadAndCacheKeyRing(),
    );
  }
}

// ── Token verification ────────────────────────────────────────────────────────

function verifyTokenAgainstKeyRing(
  token: string,
  methodArn: string,
  segment: AWSXRay.Segment | AWSXRay.Subsegment | undefined,
): APIGatewayAuthorizerResult {
  const decoded = jwt.decode(token, { complete: true });
  if (!decoded) return denyPolicy("anonymous", methodArn);

  const { kid, ref } = decoded.header as JwtKeyRingHeader;
  const signingSecret = keyRing[kid]?.[ref];
  if (!signingSecret) return denyPolicy("unknown", methodArn);

  const cacheHitSubsegment = segment?.addNewSubsegment("cache-hit");
  cacheHitSubsegment?.addAnnotation("scenario", "cache-hit");

  try {
    const payload = jwt.verify(token, signingSecret) as TenantJwtPayload;
    return allowPolicy(payload.tid, methodArn, payload.tid);
  } catch {
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
