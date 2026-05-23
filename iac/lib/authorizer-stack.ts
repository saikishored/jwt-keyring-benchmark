import * as cdk from "aws-cdk-lib";
import * as lambda from "aws-cdk-lib/aws-lambda";
import * as iam from "aws-cdk-lib/aws-iam";
import { NodejsFunction } from "aws-cdk-lib/aws-lambda-nodejs";
import { Construct } from "constructs";
import * as path from "path";
import { BenchmarkConfig } from "../bin/app";

interface AuthorizerStackProps extends cdk.StackProps {
  benchmarkConfig: BenchmarkConfig;
}

export class AuthorizerStack extends cdk.Stack {
  public readonly authorizerFunction: lambda.Function;

  constructor(scope: Construct, id: string, props: AuthorizerStackProps) {
    super(scope, id, props);
    const role = this.createExecutionRole(props.benchmarkConfig);
    this.authorizerFunction = this.createAuthorizerFunction(
      role,
      props.benchmarkConfig,
    );
    this.grantApiGatewayInvoke();
    this.setOutput();
  }

  private createExecutionRole(config: BenchmarkConfig): iam.Role {
    const role = new iam.Role(this, "AuthorizerRole", {
      assumedBy: new iam.ServicePrincipal("lambda.amazonaws.com"),
      managedPolicies: [
        iam.ManagedPolicy.fromAwsManagedPolicyName(
          "service-role/AWSLambdaBasicExecutionRole",
        ),
        iam.ManagedPolicy.fromAwsManagedPolicyName("AWSXRayDaemonWriteAccess"),
      ],
    });

    role.addToPolicy(
      new iam.PolicyStatement({
        actions: ["secretsmanager:GetSecretValue"],
        resources: ["*"],
      }),
    );

    role.addToPolicy(
      new iam.PolicyStatement({
        actions: ["ssm:GetParameter"],
        resources: [
          `arn:aws:ssm:${this.region}:${this.account}:parameter${config.encryptionSecretPrefixParam}`,
        ],
      }),
    );

    return role;
  }

  private createAuthorizerFunction(
    role: iam.Role,
    config: BenchmarkConfig,
  ): NodejsFunction {
    return new NodejsFunction(this, "AuthorizerFunction", {
      functionName: "key-ring-authorizer",
      entry: path.join(__dirname, "..", "..", "src", "authorizer", "index.ts"),
      handler: "handler",
      runtime: lambda.Runtime.NODEJS_22_X,
      role,
      timeout: cdk.Duration.seconds(15),
      memorySize: 256,
      tracing: lambda.Tracing.ACTIVE,
      environment: {
        CACHE_REFRESH_IN_SECONDS: String(config.cacheRefreshInSeconds),
        ENCRYPTION_KEYS_SECRET: config.encryptionKeysSecret,
        ENCRYPTION_KEYS_SHARD_COUNT: String(config.encryptionKeysShardCount),
        ENCRYPTION_SECRET_PREFIX_PARAM: config.encryptionSecretPrefixParam,
      },
      bundling: {
        minify: false,
        externalModules: [],
      },
    });
  }

  private grantApiGatewayInvoke(): void {
    // Pre-grant APIGW permission here (wildcard) so ApiGatewayStack can import
    // the function by ARN without CDK adding a Lambda permission back to this stack,
    // which would create a circular dependency (AuthorizerStack ↔ ApiGatewayStack).
    this.authorizerFunction.addPermission("AllowApiGatewayInvoke", {
      principal: new iam.ServicePrincipal("apigateway.amazonaws.com"),
      sourceArn: `arn:aws:execute-api:${this.region}:${this.account}:*`,
    });
  }

  private setOutput(): void {
    new cdk.CfnOutput(this, "AuthorizerFunctionArn", {
      value: this.authorizerFunction.functionArn,
      exportName: "KeyRingAuthorizerFunctionArn",
    });
  }
}
