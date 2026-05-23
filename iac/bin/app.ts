import * as cdk from "aws-cdk-lib";
import { ApiGatewayStack } from "../lib/api-gateway-stack";
import { AuthorizerStack } from "../lib/authorizer-stack";
import { HelloServiceStack } from "../lib/hello-service-stack";
import { ApiHandlerStack } from "../lib/api-handler-stack";
import { TokenRotatorStack } from "../lib/token-rotator-stack";

export interface BenchmarkConfig {
  encryptionSecretPrefixParam: string;
  encryptionKeysSecret: string;
  encryptionKeysShardCount: number;
  tenantsPerShard: number;
  cacheRefreshInSeconds: number;
}

const benchmarkConfig: BenchmarkConfig = {
  encryptionSecretPrefixParam: "/encryption-keys-random-id",
  encryptionKeysSecret: "auth/encryption-keys/shard_",
  encryptionKeysShardCount: 6,
  tenantsPerShard: 175,
  cacheRefreshInSeconds: 180,
};

const app = new cdk.App();

// Stack 1: Authorizer Lambda — X-Ray active, key ring loaded at cold start
// Pre-grants APIGW wildcard invoke permission to avoid circular dep with ApiGatewayStack
const authorizerStack = new AuthorizerStack(app, "KeyRingAuthorizerStack", {
  benchmarkConfig,
});

// Stack 2: REST API + RequestAuthorizer (no routes — deploy: false)
// Receives authorizerFunction as ARN string so CDK's auto Lambda permission is a no-op
const apiGatewayStack = new ApiGatewayStack(app, "KeyRingApiGatewayStack", {
  authorizerFunctionArn: authorizerStack.authorizerFunction.functionArn,
});

// Stack 3: Hello Service Lambda + GET /key-ring-test route + deployment + stage
// Owns the deployment: route, CfnDeployment, and CfnStage all live here.
// New services follow this same pattern — ApiGatewayStack never needs to change.
const helloServiceStack = new HelloServiceStack(
  app,
  "KeyRingHelloServiceStack",
  {
    restApiId: apiGatewayStack.restApi.restApiId,
    restApiRootResourceId: apiGatewayStack.restApi.restApiRootResourceId,
    authorizerId: apiGatewayStack.requestAuthorizer.authorizerId,
  },
);

// Stack 4: API Handler Lambda — issues JWTs and drives 1050 concurrent API calls
const apiHandlerStack = new ApiHandlerStack(app, "KeyRingApiHandlerStack", {
  apiUrl: helloServiceStack.apiUrl,
  benchmarkConfig,
});

// Stack 5: Token Rotator Lambda — hourly EventBridge schedule, 10 rotation cycles
new TokenRotatorStack(app, "KeyRingTokenRotatorStack", {
  apiHandlerFunction: apiHandlerStack.apiHandlerFunction,
  benchmarkConfig,
});

app.synth();
