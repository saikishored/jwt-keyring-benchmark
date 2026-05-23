import * as cdk from 'aws-cdk-lib';
import { ApiGatewayStack } from '../lib/api-gateway-stack';
import { AuthorizerStack } from '../lib/authorizer-stack';
import { HelloServiceStack } from '../lib/hello-service-stack';
import { ApiHandlerStack } from '../lib/api-handler-stack';
import { TokenRotatorStack } from '../lib/token-rotator-stack';

export interface BenchmarkConfig {
  encryptionSecretPrefixParam: string;
  encryptionKeysSecret: string;
  encryptionKeysShardCount: number;
  tenantsPerShard: number;
  cacheRefreshInSeconds: number;
}

const benchmarkConfig: BenchmarkConfig = {
  encryptionSecretPrefixParam: '/encryption-keys-random-id',
  encryptionKeysSecret: 'auth/encryption-keys/shard_',
  encryptionKeysShardCount: 6,
  tenantsPerShard: 175,
  cacheRefreshInSeconds: 180,
};

const app = new cdk.App();

// Stack 1: REST API — no routes yet, just the gateway
const apiGatewayStack = new ApiGatewayStack(app, 'KeyRingApiGatewayStack');

// Stack 2: Authorizer Lambda — X-Ray active, key ring loaded at cold start
const authorizerStack = new AuthorizerStack(app, 'KeyRingAuthorizerStack', { benchmarkConfig });

// Stack 3: Hello Service Lambda + GET /key-ring-test route with authorizer attached
const helloServiceStack = new HelloServiceStack(app, 'KeyRingHelloServiceStack', {
  restApi: apiGatewayStack.restApi,
  authorizerFunction: authorizerStack.authorizerFunction,
});

// Stack 4: API Handler Lambda — issues JWTs and drives 1050 concurrent API calls
const apiHandlerStack = new ApiHandlerStack(app, 'KeyRingApiHandlerStack', {
  apiUrl: apiGatewayStack.restApi.url,
  benchmarkConfig,
});

// Stack 5: Token Rotator Lambda — hourly EventBridge schedule, 10 rotation cycles
new TokenRotatorStack(app, 'KeyRingTokenRotatorStack', {
  apiHandlerFunction: apiHandlerStack.apiHandlerFunction,
  benchmarkConfig,
});

// Explicit dependency: hello-service route must deploy after API Gateway
helloServiceStack.addDependency(apiGatewayStack);
apiHandlerStack.addDependency(apiGatewayStack);

app.synth();
