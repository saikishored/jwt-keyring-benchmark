import * as cdk from "aws-cdk-lib";
import * as lambda from "aws-cdk-lib/aws-lambda";
import * as iam from "aws-cdk-lib/aws-iam";
import * as apigateway from "aws-cdk-lib/aws-apigateway";
import { NodejsFunction } from "aws-cdk-lib/aws-lambda-nodejs";
import { Construct } from "constructs";
import * as path from "path";

const STAGE_NAME = "benchmark";

interface HelloServiceStackProps extends cdk.StackProps {
  // String IDs (not construct refs) so this stack has a clean one-way dependency
  // on ApiGatewayStack via Fn::ImportValue, with no reverse reference.
  restApiId: string;
  restApiRootResourceId: string;
  authorizerId: string;
}

export class HelloServiceStack extends cdk.Stack {
  public readonly apiUrl: string;

  constructor(scope: Construct, id: string, props: HelloServiceStackProps) {
    super(scope, id, props);
    const role = this.createExecutionRole();
    const helloFunction = this.createHelloFunction(role);
    this.createRouteWithDeployment(helloFunction, props);
    // URL is deterministic from the restApiId token + known stage name
    this.apiUrl = `https://${props.restApiId}.execute-api.${this.region}.amazonaws.com/${STAGE_NAME}/`;
    this.setOutput(helloFunction);
  }

  private createExecutionRole(): iam.Role {
    return new iam.Role(this, "HelloServiceRole", {
      assumedBy: new iam.ServicePrincipal("lambda.amazonaws.com"),
      managedPolicies: [
        iam.ManagedPolicy.fromAwsManagedPolicyName(
          "service-role/AWSLambdaBasicExecutionRole",
        ),
      ],
    });
  }

  private createHelloFunction(role: iam.Role): NodejsFunction {
    return new NodejsFunction(this, "HelloServiceFunction", {
      functionName: "key-ring-hello-service",
      entry: path.join(
        __dirname,
        "..",
        "..",
        "src",
        "hello-service",
        "index.ts",
      ),
      handler: "handler",
      runtime: lambda.Runtime.NODEJS_24_X,
      role,
      timeout: cdk.Duration.seconds(5),
      memorySize: 128,
      bundling: {
        minify: false,
        externalModules: [],
      },
    });
  }

  private createRouteWithDeployment(
    helloFunction: lambda.Function,
    props: HelloServiceStackProps,
  ): void {
    // Import the RestApi by ID — all constructs created here belong to this stack,
    // so ApiGatewayStack has zero dependency on HelloServiceStack.
    const importedApi = apigateway.RestApi.fromRestApiAttributes(
      this,
      "ImportedApi",
      {
        restApiId: props.restApiId,
        rootResourceId: props.restApiRootResourceId,
      },
    );

    const resource = importedApi.root.addResource("key-ring-test");
    const method = resource.addMethod(
      "GET",
      new apigateway.LambdaIntegration(helloFunction),
    );

    // Set authorizerId + authorizationType directly on the L1 resource —
    // IAuthorizer only exposes authorizerId (authorizerType is protected on Authorizer).
    // This avoids importing the Authorizer construct from ApiGatewayStack.
    const cfnMethod = method.node.defaultChild as apigateway.CfnMethod;
    cfnMethod.authorizationType = "CUSTOM"; // CloudFormation value for Lambda authorizers (both TOKEN and REQUEST types)
    cfnMethod.authorizerId = props.authorizerId;

    // Deployment must run after the route method exists — explicit DependsOn.
    const cfnDeployment = new apigateway.CfnDeployment(
      this,
      "KeyRingDeployment",
      { restApiId: props.restApiId },
    );
    cfnDeployment.addDependency(
      method.node.defaultChild as apigateway.CfnMethod,
    );

    new apigateway.CfnStage(this, "KeyRingStage", {
      restApiId: props.restApiId,
      stageName: STAGE_NAME,
      deploymentId: cfnDeployment.ref,
      tracingEnabled: true,
      methodSettings: [
        {
          httpMethod: "*",
          resourcePath: "/*",
          dataTraceEnabled: false,
          metricsEnabled: true,
        },
      ],
    });
  }

  private setOutput(helloFunction: lambda.Function): void {
    new cdk.CfnOutput(this, "HelloServiceFunctionArn", {
      value: helloFunction.functionArn,
      exportName: "KeyRingHelloServiceFunctionArn",
    });
    new cdk.CfnOutput(this, "ApiUrl", {
      value: this.apiUrl,
      exportName: "KeyRingBenchmarkApiUrl",
    });
  }
}
