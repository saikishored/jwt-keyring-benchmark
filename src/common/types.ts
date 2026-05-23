/**
 * A single tenant's key bucket inside the key ring.
 * Index signature allows epoch timestamp strings as keys alongside `tid`.
 */
export interface TenantKeyBucket {
  tid: string;
  [epochRef: string]: string;
}

/**
 * The in-memory key ring: a map of hashed_kid -> TenantKeyBucket.
 * Loaded once on cold start, refreshed every CACHE_REFRESH_IN_SECONDS.
 */
export type KeyRing = Record<string, TenantKeyBucket>;

/**
 * Custom fields added to the JWT header for key ring lookup.
 */
export interface JwtKeyRingHeader {
  alg: string;
  typ: string;
  kid: string;
  ref: string;
}

/**
 * JWT payload shape issued by api-handler and verified by authorizer.
 */
export interface TenantJwtPayload {
  tid: string;
  iss: string;
  iat: number;
  exp: number;
}
