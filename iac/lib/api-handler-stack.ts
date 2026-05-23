import * as cdk from "aws-cdk-lib";
import * as lambda from "aws-cdk-lib/aws-lambda";
import * as iam from "aws-cdk-lib/aws-iam";
import { NodejsFunction } from "aws-cdk-lib/aws-lambda-nodejs";
import { Construct } from "constructs";
import * as path from "path";
import { BenchmarkConfig } from "../bin/app";

interface ApiHandlerStackProps extends cdk.StackProps {
  apiUrl: string;
  benchmarkConfig: BenchmarkConfig;
}

export class ApiHandlerStack extends cdk.Stack {
  public readonly apiHandlerFunction: lambda.Function;

  constructor(scope: Construct, id: string, props: ApiHandlerStackProps) {
    super(scope, id, props);
    const role = this.createExecutionRole(props.benchmarkConfig);
    this.apiHandlerFunction = this.createApiHandlerFunction(
      role,
      props.apiUrl,
      props.benchmarkConfig,
    );
    this.setOutput();
  }

  private createExecutionRole(config: BenchmarkConfig): iam.Role {
    const role = new iam.Role(this, "ApiHandlerRole", {
      assumedBy: new iam.ServicePrincipal("lambda.amazonaws.com"),
      managedPolicies: [
        iam.ManagedPolicy.fromAwsManagedPolicyName(
          "service-role/AWSLambdaBasicExecutionRole",
        ),
      ],
    });

    role.addToPolicy(
      new iam.PolicyStatement({
        actions: [
          "secretsmanager:GetSecretValue",
          "secretsmanager:DeleteSecret",
        ],
        resources: ["*"],
      }),
    );

    role.addToPolicy(
      new iam.PolicyStatement({
        actions: ["ssm:GetParameter", "ssm:DeleteParameter"],
        resources: [
          `arn:aws:ssm:${this.region}:${this.account}:parameter${config.encryptionSecretPrefixParam}`,
        ],
      }),
    );

    return role;
  }

  private createApiHandlerFunction(
    role: iam.Role,
    apiUrl: string,
    config: BenchmarkConfig,
  ): NodejsFunction {
    return new NodejsFunction(this, "ApiHandlerFunction", {
      functionName: "key-ring-api-handler",
      entry: path.join(__dirname, "..", "..", "src", "api-handler", "index.ts"),
      handler: "handler",
      runtime: lambda.Runtime.NODEJS_22_X,
      role,
      // 6 shards × 2-minute pause + API call time — needs close to max timeout
      timeout: cdk.Duration.seconds(900),
      memorySize: 512,
      environment: {
        ENCRYPTION_SECRET_PREFIX_PARAM: config.encryptionSecretPrefixParam,
        ENCRYPTION_KEYS_SECRET: config.encryptionKeysSecret,
        ENCRYPTION_KEYS_SHARD_COUNT: String(config.encryptionKeysShardCount),
        API_URL: apiUrl,
      },
      bundling: {
        minify: false,
        externalModules: [],
      },
    });
  }

  private setOutput(): void {
    new cdk.CfnOutput(this, "ApiHandlerFunctionArn", {
      value: this.apiHandlerFunction.functionArn,
      exportName: "KeyRingApiHandlerFunctionArn",
    });
  }
}
