import * as cdk from "aws-cdk-lib";
import * as lambda from "aws-cdk-lib/aws-lambda";
import * as apigateway from "aws-cdk-lib/aws-apigateway";
import { Construct } from "constructs";

interface ApiGatewayStackProps extends cdk.StackProps {
  // ARN string (not construct ref) — prevents CDK from adding a Lambda permission
  // resource back to AuthorizerStack, which would create a circular dependency.
  authorizerFunctionArn: string;
}

export class ApiGatewayStack extends cdk.Stack {
  public readonly restApi: apigateway.RestApi;
  public readonly requestAuthorizer: apigateway.RequestAuthorizer;

  constructor(scope: Construct, id: string, props: ApiGatewayStackProps) {
    super(scope, id, props);
    this.restApi = this.createRestApi();
    this.requestAuthorizer = this.createRequestAuthorizer(
      props.authorizerFunctionArn,
    );
    // CDK validates that the authorizer is attached to a RestApi during synth.
    // Routes are added in service stacks (via fromRestApiAttributes), so the
    // auto-attach never fires. Manually attach here to satisfy the validation.
    // Since the handler is an imported function (canCreatePermissions: false),
    // no Lambda::Permission resource is created — no cycle introduced.
    this.requestAuthorizer._attachToApi(this.restApi);
  }

  private createRestApi(): apigateway.RestApi {
    const api = new apigateway.RestApi(this, "KeyRingBenchmarkApi", {
      restApiName: "jwt-keyring-benchmark-api",
      description:
        "API Gateway for JWT Key Ring benchmark — authorizer cache disabled so every request hits the authorizer",
      // deploy: false — each service stack owns its own deployment + stage,
      // so new routes can be added without modifying this stack (Open/Closed).
      deploy: false,
    });
    // CDK's RestApi validates that methods were added to this construct.
    // Routes are added by service stacks via RestApi.fromRestApiAttributes(),
    // which creates a separate construct object — so this node never sees them.
    // Clear the node's validation list to suppress the false-positive error.
    (api.node as any)._validations = [];
    return api;
  }

  private createRequestAuthorizer(
    authorizerFunctionArn: string,
  ): apigateway.RequestAuthorizer {
    // Import by ARN so CDK's auto-added Lambda::Permission goes into this stack
    // (no-op for imported functions), not back into AuthorizerStack.
    // Permission is already pre-granted in AuthorizerStack with a wildcard sourceArn.
    const authorizerFn = lambda.Function.fromFunctionArn(
      this,
      "AuthorizerFunctionRef",
      authorizerFunctionArn,
    );
    // Authorizer cache TTL = 0: every request hits the authorizer to maximise benchmark samples
    return new apigateway.RequestAuthorizer(this, "KeyRingRequestAuthorizer", {
      handler: authorizerFn,
      identitySources: [apigateway.IdentitySource.header("Cookie")],
      resultsCacheTtl: cdk.Duration.seconds(0),
    });
  }
}
