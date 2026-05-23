import {
  SecretsManagerClient,
  GetSecretValueCommand,
  CreateSecretCommand,
  UpdateSecretCommand,
  DeleteSecretCommand,
} from "@aws-sdk/client-secrets-manager";
import { KeyRing } from "./types";

const secretsClient = new SecretsManagerClient({});

export async function fetchShardSecret(secretName: string): Promise<KeyRing> {
  const response = await secretsClient.send(
    new GetSecretValueCommand({ SecretId: secretName }),
  );
  return JSON.parse(response.SecretString!) as KeyRing;
}

export async function fetchAllKeyRingShards(
  randomId: string,
  secretPrefix: string,
  shardCount: number,
): Promise<KeyRing> {
  const shards = await Promise.all(
    Array.from({ length: shardCount }, (_, i) =>
      fetchShardSecret(`${randomId}/${secretPrefix}${i + 1}`),
    ),
  );
  return Object.assign({}, ...shards) as KeyRing;
}

export async function createShardSecret(
  secretName: string,
  keyRing: KeyRing,
): Promise<void> {
  await secretsClient.send(
    new CreateSecretCommand({
      Name: secretName,
      SecretString: JSON.stringify(keyRing),
    }),
  );
}

export async function updateShardSecret(
  secretName: string,
  keyRing: KeyRing,
): Promise<void> {
  await secretsClient.send(
    new UpdateSecretCommand({
      SecretId: secretName,
      SecretString: JSON.stringify(keyRing),
    }),
  );
}

export async function deleteShardSecret(secretName: string): Promise<void> {
  await secretsClient.send(
    new DeleteSecretCommand({
      SecretId: secretName,
      ForceDeleteWithoutRecovery: true,
    }),
  );
}
