import type { ModelOption } from '@always-on/contracts/models';
import { getSupportedThinkingLevels } from '@earendil-works/pi-ai';
import { type ModelConnection, openPiClient } from './client.js';

/** Reads a provider's public model identities, names and supported reasoning choices from Pi. */
export async function listPiModels({
  directory,
  connection,
}: {
  directory: string;
  connection: ModelConnection;
}): Promise<readonly ModelOption[]> {
  await using client = await openPiClient({ directory, connection });
  const models = await client.runtime.getAvailable(connection.provider);

  return models.map((model) => ({
    provider: model.provider,
    id: model.id,
    name: model.name,
    reasoningEfforts: getSupportedThinkingLevels(model),
  }));
}
