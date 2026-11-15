import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { ModelRuntime } from '@earendil-works/pi-coding-agent';

/** A host-resolved provider connection; tool backends never receive these credentials. */
export type ModelConnection = {
  readonly provider: string;
  readonly apiKey: string;
  readonly baseUrl?: string;
};

/** Owns model authentication and pending credential writes for an SDK invocation. */
export interface PiClient extends AsyncDisposable {
  readonly runtime: ModelRuntime;
}

/** Opens provider access without inheriting the deployment machine's Pi configuration. */
export async function openPiClient({
  directory,
  connection,
}: {
  directory: string;
  connection: ModelConnection;
}): Promise<PiClient> {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const runtime = await ModelRuntime.create({
    authPath: join(directory, 'auth.json'),
    modelsPath: null,
  });
  await runtime.setRuntimeApiKey(connection.provider, connection.apiKey);
  if (connection.baseUrl)
    runtime.registerProvider(connection.provider, { baseUrl: connection.baseUrl });
  return {
    runtime,
    [Symbol.asyncDispose]: runtime.settleCredentialWrites.bind(runtime),
  };
}
