import type { PluginWebFetchProviderEntry } from "./types.js";
import {
  resolveBundledRuntimeWebFetchProvidersFromPublicArtifacts,
  resolveBundledWebFetchProvidersFromPublicArtifacts,
} from "./web-provider-public-artifacts.js";
import {
  mapRegistryProviders,
  resolveBundledWebProviderResolutionConfig,
  resolveManifestDeclaredWebProviderCandidatePluginIds,
} from "./web-provider-resolution-shared.js";
import {
  resolvePluginWebProviders,
  resolvePluginWebProvidersAsync,
  type ResolvePluginWebProvidersParams,
  type ResolveRuntimeWebProvidersParams,
  type WebProviderRuntimeResolution,
} from "./web-provider-runtime-shared.js";

const providerResolution = {
  resolveBundledResolutionConfig: (params) =>
    resolveBundledWebProviderResolutionConfig({ ...params, contract: "webFetchProviders" }),
  resolveCandidatePluginIds: (params) =>
    resolveManifestDeclaredWebProviderCandidatePluginIds({
      ...params,
      contract: "webFetchProviders",
      configKey: "webFetch",
    }),
  mapRegistryProviders: ({ registry, onlyPluginIds }) =>
    mapRegistryProviders({ registry, entries: registry.webFetchProviders, onlyPluginIds }),
} satisfies WebProviderRuntimeResolution<PluginWebFetchProviderEntry>;

/** Resolves web fetch providers from bundled artifacts or scoped plugin loads. */
export function resolvePluginWebFetchProviders(
  params: ResolvePluginWebProvidersParams,
): PluginWebFetchProviderEntry[] {
  return resolvePluginWebProviders(params, {
    ...providerResolution,
    resolveBundledPublicArtifactProviders: resolveBundledWebFetchProvidersFromPublicArtifacts,
    resolveBundledRuntimeArtifactProviders:
      resolveBundledRuntimeWebFetchProvidersFromPublicArtifacts,
  });
}

/** Resolves already-eligible runtime web fetch providers without setup-mode activation. */
export function resolveRuntimeWebFetchProviders(
  params: ResolveRuntimeWebProvidersParams,
): PluginWebFetchProviderEntry[] {
  return resolvePluginWebProviders(params, {
    ...providerResolution,
    resolveBundledRuntimeArtifactProviders:
      resolveBundledRuntimeWebFetchProvidersFromPublicArtifacts,
  });
}

/** Resolve fetch providers while preparing external plugins off the request thread. */
export function resolvePluginWebFetchProvidersAsync(
  params: ResolvePluginWebProvidersParams,
): Promise<PluginWebFetchProviderEntry[]> {
  return resolvePluginWebProvidersAsync(params, {
    ...providerResolution,
    resolveBundledPublicArtifactProviders: resolveBundledWebFetchProvidersFromPublicArtifacts,
    resolveBundledRuntimeArtifactProviders:
      resolveBundledRuntimeWebFetchProvidersFromPublicArtifacts,
  });
}

/** Resolve eligible runtime providers without setup-mode activation. */
export function resolveRuntimeWebFetchProvidersAsync(
  params: ResolveRuntimeWebProvidersParams,
): Promise<PluginWebFetchProviderEntry[]> {
  return resolvePluginWebProvidersAsync(params, {
    ...providerResolution,
    resolveBundledRuntimeArtifactProviders:
      resolveBundledRuntimeWebFetchProvidersFromPublicArtifacts,
  });
}
