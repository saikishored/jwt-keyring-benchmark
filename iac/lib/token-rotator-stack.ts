import * as cdk from "aws-cdk-lib";
import * as lambda from "aws-cdk-lib/aws-lambda";
import * as iam from "aws-cdk-lib/aws-iam";
import * as scheduler from "aws-cdk-lib/aws-scheduler";
import { NodejsFunction } from "aws-cdk-lib/aws-lambda-nodejs";
import { Construct } from "constructs";
import * as path from "path";
import { BenchmarkConfig } from "../bin/app";

interface TokenRotatorStackProps extends cdk.StackProps {
  apiHandlerFunction: lambda.Function;
  benchmarkConfig: BenchmarkConfig;
}

export class TokenRotatorStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: TokenRotatorStackProps) {
    super(scope, id, props);

    const role = this.createExecutionRole(
      props.apiHandlerFunction,
      props.benchmarkConfig,
    );
    const tokenRotatorFunction = this.createTokenRotatorFunction(
      role,
      props.apiHandlerFunction.functionArn,
      props.benchmarkConfig,
    );
    this.createEventBridgeSchedule(tokenRotatorFunction);
    this.setOutput(tokenRotatorFunction);
  }

  private createExecutionRole(
    apiHandlerFunction: lambda.Function,
    config: BenchmarkConfig,
  ): iam.Role {
    const role = new iam.Role(this, "TokenRotatorRole", {
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
          "secretsmanager:CreateSecret",
          "secretsmanager:GetSecretValue",
          "secretsmanager:UpdateSecret",
          "secretsmanager:DeleteSecret",
        ],
        resources: ["*"],
      }),
    );

    role.addToPolicy(
      new iam.PolicyStatement({
        actions: [
          "ssm:PutParameter",
          "ssm:GetParameter",
          "ssm:DeleteParameter",
        ],
        resources: [
          `arn:aws:ssm:${this.region}:${this.account}:parameter${config.encryptionSecretPrefixParam}`,
        ],
      }),
    );

    role.addToPolicy(
      new iam.PolicyStatement({
        actions: ["lambda:InvokeFunction"],
        resources: [apiHandlerFunction.functionArn],
      }),
    );

    return role;
  }

  private createTokenRotatorFunction(
    role: iam.Role,
    apiHandlerFunctionArn: string,
    config: BenchmarkConfig,
  ): NodejsFunction {
    return new NodejsFunction(this, "TokenRotatorFunction", {
      functionName: "key-ring-token-rotator",
      entry: path.join(
        __dirname,
        "..",
        "..",
        "src",
        "token-rotator",
        "index.ts",
      ),
      handler: "handler",
      runtime: lambda.Runtime.NODEJS_22_X,
      role,
      timeout: cdk.Duration.minutes(15),
      memorySize: 256,
      environment: {
        ENCRYPTION_SECRET_PREFIX_PARAM: config.encryptionSecretPrefixParam,
        ENCRYPTION_KEYS_SECRET: config.encryptionKeysSecret,
        ENCRYPTION_KEYS_SHARD_COUNT: String(config.encryptionKeysShardCount),
        TENANTS_PER_SHARD: String(config.tenantsPerShard),
        API_HANDLER_FUNCTION_ARN: apiHandlerFunctionArn,
      },
      bundling: {
        minify: false,
        externalModules: [],
      },
    });
  }

  private createEventBridgeSchedule(
    tokenRotatorFunction: lambda.Function,
  ): void {
    const schedulerRole = new iam.Role(this, "SchedulerInvokeRole", {
      assumedBy: new iam.ServicePrincipal("scheduler.amazonaws.com"),
    });

    schedulerRole.addToPolicy(
      new iam.PolicyStatement({
        actions: ["lambda:InvokeFunction"],
        resources: [tokenRotatorFunction.functionArn],
      }),
    );

    // Starts 15 min after deploy; EndDate stops after 10 cycles (~11h 15m from deploy)
    const scheduleStartDate = new Date(Date.now() + 5 * 60 * 1000);
    const scheduleEndDate = new Date(Date.now() + (11 * 60 + 15) * 60 * 1000);

    new scheduler.CfnSchedule(this, "TokenRotatorSchedule", {
      name: "key-ring-token-rotator-hourly",
      description:
        "Triggers key rotation cycle every hour for 10 hours of benchmark data",
      scheduleExpression: "rate(1 hour)",
      flexibleTimeWindow: { mode: "OFF" },
      startDate: scheduleStartDate.toISOString(),
      endDate: scheduleEndDate.toISOString(),
      state: "ENABLED",
      target: {
        arn: tokenRotatorFunction.functionArn,
        roleArn: schedulerRole.roleArn,
        retryPolicy: {
          maximumRetryAttempts: 2,
        },
      },
    });
  }

  private setOutput(tokenRotatorFunction: lambda.Function): void {
    new cdk.CfnOutput(this, "TokenRotatorFunctionArn", {
      value: tokenRotatorFunction.functionArn,
      exportName: "KeyRingTokenRotatorFunctionArn",
    });
  }
}
