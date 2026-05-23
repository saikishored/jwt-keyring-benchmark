import * as cdk from "aws-cdk-lib";
import * as apigateway from "aws-cdk-lib/aws-apigateway";
import { Construct } from "constructs";

export class ApiGatewayStack extends cdk.Stack {
  public readonly restApi: apigateway.RestApi;

  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);
    this.restApi = this.createRestApi();
    this.setOutput();
  }

  private createRestApi(): apigateway.RestApi {
    return new apigateway.RestApi(this, "KeyRingBenchmarkApi", {
      restApiName: "jwt-keyring-benchmark-api",
      description:
        "API Gateway for JWT Key Ring benchmark — authorizer cache disabled so every request hits the authorizer",
      deployOptions: {
        stageName: "benchmark",
        tracingEnabled: true,
        dataTraceEnabled: false,
        metricsEnabled: true,
      },
    });
  }

  private setOutput(): void {
    new cdk.CfnOutput(this, "ApiUrl", {
      value: this.restApi.url,
      exportName: "KeyRingBenchmarkApiUrl",
      description: "API Gateway base URL (includes stage)",
    });
  }
}
