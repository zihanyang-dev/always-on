import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';

const SERVER_URL_SCHEMA = z.url({ protocol: /^https?$/ });
const CLI_ENV_SCHEMA = z.object({
  ALWAYS_ON_URL: SERVER_URL_SCHEMA.optional(),
  ALWAYS_ON_CONFIG: z.string().min(1).optional(),
  XDG_CONFIG_HOME: z.string().min(1).optional(),
  APPDATA: z.string().min(1).optional(),
});
const CONNECTION_SCHEMA = z.object({ serverUrl: SERVER_URL_SCHEMA });
const PREFERENCES_SCHEMA = CONNECTION_SCHEMA.partial();
const AGENT_SEARCH_ENV_SCHEMA = z
  .object({
    PATH: z.string().default(''),
    PATHEXT: z.string().default('.COM;.EXE;.BAT;.CMD'),
  })
  .transform((env) => ({
    searchPath: env.PATH,
    executableExtensions: env.PATHEXT.split(';').filter((extension) => extension.length > 0),
  }));

/** Non-secret local settings, resolved once by the CLI entry point. */
export type CliConfig = z.infer<typeof CONNECTION_SCHEMA>;

/** Local binary search settings, independent of saved platform connections. */
export type AgentSearchConfig = z.infer<typeof AGENT_SEARCH_ENV_SCHEMA>;

/** Parses only environment values needed by the local discovery command. */
export function parseAgentSearchEnv(input: unknown): AgentSearchConfig {
  return AGENT_SEARCH_ENV_SCHEMA.parse(input);
}

/** Resolves explicit options before environment, local preferences, and defaults. */
export async function loadCliConfig({
  environment,
  serverUrl,
  homeDirectory,
  platform,
}: {
  environment: unknown;
  serverUrl: string | undefined;
  homeDirectory: string;
  platform: NodeJS.Platform;
}): Promise<CliConfig> {
  const env = CLI_ENV_SCHEMA.parse(environment);
  const directory = getConfigDirectory({
    homeDirectory,
    platform,
    xdgDirectory: env.XDG_CONFIG_HOME,
    applicationDirectory: env.APPDATA,
  });
  const configPath = env.ALWAYS_ON_CONFIG ?? join(directory, 'config.json');
  const preferences = await readPreferences({
    configPath,
    isExplicit: env.ALWAYS_ON_CONFIG !== undefined,
  });

  // Resolve precedence once, before any command can consume the selected endpoint.
  return CONNECTION_SCHEMA.parse({
    serverUrl: serverUrl ?? env.ALWAYS_ON_URL ?? preferences.serverUrl ?? 'http://localhost:3001',
  });
}

function getConfigDirectory({
  homeDirectory,
  platform,
  xdgDirectory,
  applicationDirectory,
}: {
  homeDirectory: string;
  platform: NodeJS.Platform;
  xdgDirectory: string | undefined;
  applicationDirectory: string | undefined;
}) {
  if (platform === 'darwin')
    return join(homeDirectory, 'Library', 'Application Support', 'always-on');
  if (platform === 'win32')
    return join(applicationDirectory ?? join(homeDirectory, 'AppData', 'Roaming'), 'always-on');

  return join(xdgDirectory ?? join(homeDirectory, '.config'), 'always-on');
}

async function readPreferences({
  configPath,
  isExplicit,
}: {
  configPath: string;
  isExplicit: boolean;
}) {
  try {
    const contents: unknown = JSON.parse(await readFile(configPath, 'utf8'));

    return PREFERENCES_SCHEMA.parse(contents);
  } catch (error) {
    const isMissing = error instanceof Error && 'code' in error && error.code === 'ENOENT';
    // An absent default profile is normal; an explicitly selected file must exist.
    if (isMissing && !isExplicit) return PREFERENCES_SCHEMA.parse({});

    throw new Error(`Cannot read CLI settings at ${configPath}`, {
      cause: error,
    });
  }
}
