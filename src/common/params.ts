import {
  SSMClient,
  GetParameterCommand,
  PutParameterCommand,
  DeleteParameterCommand,
  ParameterNotFound,
} from '@aws-sdk/client-ssm';

const ssmClient = new SSMClient({});

export async function getRandomIdParam(paramName: string): Promise<string | null> {
  try {
    const response = await ssmClient.send(
      new GetParameterCommand({ Name: paramName }),
    );
    return response.Parameter?.Value ?? null;
  } catch (err) {
    if (err instanceof ParameterNotFound) return null;
    throw err;
  }
}

export async function putRandomIdParam(paramName: string, value: string): Promise<void> {
  await ssmClient.send(
    new PutParameterCommand({
      Name: paramName,
      Value: value,
      Type: 'String',
      Overwrite: true,
    }),
  );
}

export async function deleteRandomIdParam(paramName: string): Promise<void> {
  await ssmClient.send(new DeleteParameterCommand({ Name: paramName }));
}
