import * as cdk from "aws-cdk-lib";
import * as lambda from "aws-cdk-lib/aws-lambda";
import * as iam from "aws-cdk-lib/aws-iam";
import * as apigateway from "aws-cdk-lib/aws-apigateway";
import { NodejsFunction } from "aws-cdk-lib/aws-lambda-nodejs";
import { Construct } from "constructs";
import * as path from "path";

interface HelloServiceStackProps extends cdk.StackProps {
  restApi: apigateway.RestApi;
  authorizerFunction: lambda.Function;
}

export class HelloServiceStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: HelloServiceStackProps) {
    super(scope, id, props);

    const role = this.createExecutionRole();
    const helloFunction = this.createHelloFunction(role);
    const requestAuthorizer = this.createRequestAuthorizer(
      props.authorizerFunction,
    );
    this.createKeyRingTestRoute(
      props.restApi,
      requestAuthorizer,
      helloFunction,
    );
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
      entry: path.join(__dirname, "../../src/hello-service/index.ts"),
      handler: "handler",
      runtime: lambda.Runtime.NODEJS_22_X,
      role,
      timeout: cdk.Duration.seconds(5),
      memorySize: 128,
      bundling: {
        minify: true,
        externalModules: [],
      },
    });
  }

  private createRequestAuthorizer(
    authorizerFunction: lambda.Function,
  ): apigateway.RequestAuthorizer {
    // Authorizer cache TTL = 0: every request hits the authorizer to maximise benchmark samples
    return new apigateway.RequestAuthorizer(this, "KeyRingRequestAuthorizer", {
      handler: authorizerFunction,
      identitySources: [apigateway.IdentitySource.header("Cookie")],
      resultsCacheTtl: cdk.Duration.seconds(0),
    });
  }

  private createKeyRingTestRoute(
    restApi: apigateway.RestApi,
    authorizer: apigateway.RequestAuthorizer,
    helloFunction: lambda.Function,
  ): void {
    const keyRingTestResource = restApi.root.addResource("key-ring-test");
    keyRingTestResource.addMethod(
      "GET",
      new apigateway.LambdaIntegration(helloFunction),
      { authorizer },
    );
  }

  private setOutput(helloFunction: lambda.Function): void {
    new cdk.CfnOutput(this, "HelloServiceFunctionArn", {
      value: helloFunction.functionArn,
      exportName: "KeyRingHelloServiceFunctionArn",
    });
  }
}
