import { createExtensionRuntime, type ResourceLoader } from '@earendil-works/pi-coding-agent';

/** Supplies only host-approved resources, without discovering workstation configuration or code. */
export function createSessionResources(systemPrompt: string): ResourceLoader {
  // The explicit loader follows Pi's full-control SDK example and excludes filesystem discovery.
  return {
    getExtensions: () => ({ extensions: [], errors: [], runtime: createExtensionRuntime() }),
    getSkills: () => ({ skills: [], diagnostics: [] }),
    getPrompts: () => ({ prompts: [], diagnostics: [] }),
    getThemes: () => ({ themes: [], diagnostics: [] }),
    getAgentsFiles: () => ({ agentsFiles: [] }),
    getSystemPrompt: () => systemPrompt,
    getSystemPromptSource: () => undefined,
    getAppendSystemPrompt: () => [],
    getAppendSystemPromptSources: () => [],
    extendResources: () => {},
    reload: async () => {},
  };
}
