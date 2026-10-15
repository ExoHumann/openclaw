import { createRequireRecord } from "openclaw/plugin-sdk/test-fixtures";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferredCore } from "../shared/deferred.js";
import type { PluginManifestRecord } from "./manifest-registry.js";
import { createPluginCache, getPluginCache, withPluginCache } from "./plugin-cache.js";
import { createPluginManifestRecordFixture } from "./plugin-metadata.test-support.js";
import { createEmptyPluginRegistry } from "./registry-empty.js";
import { withPluginRuntimeRegistryScope } from "./runtime/gateway-request-scope.js";
import { withPluginRuntimeGenerationRegistryScope } from "./runtime/generation-state.js";
import type { WebProviderRuntimeResolution } from "./web-provider-runtime-shared.js";

const mocks = vi.hoisted(() => ({
  isPluginRegistryLoadInFlight: vi.fn(() => false),
  loadOpenClawPlugins: vi.fn(),
  loadOpenClawPluginsAsync: vi.fn(),
  getCurrentPluginToolInspection: vi.fn(),
  resolveCompatibleRuntimePluginRegistry: vi.fn(),
  getLoadedRuntimePluginRegistry: vi.fn(),
  resolvePluginRegistryLoadCacheKey: vi.fn((options: unknown) => JSON.stringify(options)),
  resolveRuntimePluginRegistry: vi.fn(),
  getActivePluginRegistry: vi.fn<() => Record<string, unknown> | null>(() => null),
  getActivePluginRegistryWorkspaceDir: vi.fn(() => undefined),
  buildPluginRuntimeLoadOptions: vi.fn((_values: unknown, overrides?: Record<string, unknown>) => ({
    ...overrides,
  })),
  createPluginRuntimeLoaderLogger: vi.fn(() => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  })),
}));

// mock-isolation: Exercise selection and ownership with controlled registries; real preparation is covered by loader and fetch integration tests.
vi.mock("./loader.js", () => ({
  isPluginRegistryLoadInFlight: mocks.isPluginRegistryLoadInFlight,
  loadOpenClawPlugins: mocks.loadOpenClawPlugins,
  loadOpenClawPluginsAsync: mocks.loadOpenClawPluginsAsync,
  resolveCompatibleRuntimePluginRegistry: mocks.resolveCompatibleRuntimePluginRegistry,
  resolvePluginRegistryLoadCacheKey: mocks.resolvePluginRegistryLoadCacheKey,
  resolveRuntimePluginRegistry: mocks.resolveRuntimePluginRegistry,
}));

vi.mock("./tool-inspection-state.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./tool-inspection-state.js")>()),
  getCurrentPluginToolInspection: mocks.getCurrentPluginToolInspection,
}));

vi.mock("./active-runtime-registry.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./active-runtime-registry.js")>()),
  getLoadedRuntimePluginRegistry: mocks.getLoadedRuntimePluginRegistry,
}));

vi.mock("./runtime.js", () => ({
  getActivePluginRegistry: mocks.getActivePluginRegistry,
  getActivePluginRegistryWorkspaceDir: mocks.getActivePluginRegistryWorkspaceDir,
}));

vi.mock("./runtime/load-context.js", () => ({
  buildPluginRuntimeLoadOptions: mocks.buildPluginRuntimeLoadOptions,
  createPluginRuntimeLoaderLogger: mocks.createPluginRuntimeLoaderLogger,
}));

let resolvePluginWebProvidersAsync: typeof import("./web-provider-runtime-shared.js").resolvePluginWebProvidersAsync;

let resolvePluginWebProviders: typeof import("./web-provider-runtime-shared.js").resolvePluginWebProviders;

const requireRecord = createRequireRecord("record", "expected-non-array-record");

function mockArg(mock: ReturnType<typeof vi.fn>, callIndex = 0): Record<string, unknown> {
  return requireRecord(mock.mock.calls[callIndex]?.[0]);
}

function resolution(
  overrides: Partial<WebProviderRuntimeResolution<string>> &
    Pick<WebProviderRuntimeResolution<string>, "mapRegistryProviders">,
): WebProviderRuntimeResolution<string> {
  return {
    resolveBundledResolutionConfig: ({ manifestRecords }) => ({
      config: {},
      activationSourceConfig: {},
      autoEnabledReasons: {},
      manifestRecords,
    }),
    resolveCandidatePluginIds: () => ["brave"],
    ...overrides,
  };
}

describe("web-provider-runtime-shared", () => {
  beforeAll(async () => {
    ({ resolvePluginWebProviders, resolvePluginWebProvidersAsync } =
      await import("./web-provider-runtime-shared.js"));
  });

  beforeEach(() => {
    mocks.isPluginRegistryLoadInFlight.mockReset();
    mocks.isPluginRegistryLoadInFlight.mockReturnValue(false);
    mocks.loadOpenClawPlugins.mockReset();
    mocks.loadOpenClawPluginsAsync.mockReset();
    mocks.getCurrentPluginToolInspection.mockReset();
    mocks.resolveCompatibleRuntimePluginRegistry.mockReset();
    mocks.getLoadedRuntimePluginRegistry.mockReset();
    mocks.getLoadedRuntimePluginRegistry.mockReturnValue(undefined);
    mocks.resolvePluginRegistryLoadCacheKey.mockReset();
    mocks.resolvePluginRegistryLoadCacheKey.mockImplementation((options: unknown) =>
      JSON.stringify(options),
    );
    mocks.resolveRuntimePluginRegistry.mockReset();
    mocks.getActivePluginRegistry.mockReset();
    mocks.getActivePluginRegistry.mockReturnValue(null);
    mocks.getActivePluginRegistryWorkspaceDir.mockReset();
    mocks.getActivePluginRegistryWorkspaceDir.mockReturnValue(undefined);
    mocks.buildPluginRuntimeLoadOptions.mockReset();
    mocks.buildPluginRuntimeLoadOptions.mockImplementation(
      (_values: unknown, overrides?: Record<string, unknown>) => ({
        ...overrides,
      }),
    );
  });

  it("preserves explicit empty scopes in runtime-compatible web provider loads", () => {
    const activeRegistry = { source: "active" };
    const mapRegistryProviders = vi.fn(() => []);
    mocks.getLoadedRuntimePluginRegistry.mockReturnValue(activeRegistry as never);

    const result = resolvePluginWebProviders(
      {
        config: {},
        onlyPluginIds: [],
      },
      resolution({
        resolveCandidatePluginIds: () => [],
        mapRegistryProviders,
      }),
    );

    expect(mockArg(mocks.getLoadedRuntimePluginRegistry).requiredPluginIds).toEqual([]);
    expect(mapRegistryProviders).toHaveBeenCalledWith({
      registry: activeRegistry,
      onlyPluginIds: [],
    });
    expect(result).toStrictEqual([]);
    expect(mocks.loadOpenClawPlugins).not.toHaveBeenCalled();
  });

  it("preserves explicit scopes when config is omitted in direct runtime resolution", () => {
    const mapRegistryProviders = vi.fn(() => []);
    mocks.getLoadedRuntimePluginRegistry.mockReturnValue({} as never);

    resolvePluginWebProviders(
      {
        onlyPluginIds: ["alpha"],
      },
      resolution({
        resolveCandidatePluginIds: () => ["alpha"],
        mapRegistryProviders,
      }),
    );

    expect(mockArg(mocks.getLoadedRuntimePluginRegistry).requiredPluginIds).toEqual(["alpha"]);
    expect(mockArg(mapRegistryProviders).onlyPluginIds).toEqual(["alpha"]);
  });

  it("resolves provider candidates from the original config and prepared manifests", () => {
    const activeRegistry = { source: "active" };
    const config = { plugins: { entries: {} } };
    const resolvedConfig = { plugins: { entries: { brave: { enabled: true } } } };
    const manifestRecords: PluginManifestRecord[] = [];
    const resolveCandidatePluginIds = vi.fn(() => ["brave"]);
    const mapRegistryProviders = vi.fn(() => ["provider"]);
    mocks.getLoadedRuntimePluginRegistry.mockReturnValue(activeRegistry);

    const providers = resolvePluginWebProviders(
      {
        config,
        env: { BRAVE_API_KEY: "key" },
        onlyPluginIds: ["brave", "firecrawl"],
        origin: "bundled",
        sandboxed: true,
        workspaceDir: "/workspace",
        manifestRecords,
      },
      resolution({
        resolveBundledResolutionConfig: () => ({
          config: resolvedConfig,
          activationSourceConfig: config,
          autoEnabledReasons: { brave: ["env"] },
          manifestRecords,
        }),
        resolveCandidatePluginIds,
        mapRegistryProviders,
      }),
    );

    expect(providers).toEqual(["provider"]);
    expect(resolveCandidatePluginIds).toHaveBeenCalledWith({
      config,
      workspaceDir: "/workspace",
      env: { BRAVE_API_KEY: "key" },
      onlyPluginIds: ["brave", "firecrawl"],
      origin: "bundled",
      sandboxed: true,
      manifestRecords,
    });
    expect(mapRegistryProviders).toHaveBeenCalledWith({
      registry: activeRegistry,
      onlyPluginIds: ["brave"],
    });
    expect(mockArg(mocks.buildPluginRuntimeLoadOptions).manifestRegistry).toEqual({
      plugins: manifestRecords,
      diagnostics: [],
    });
    expect(mocks.loadOpenClawPlugins).not.toHaveBeenCalled();
  });

  it("reuses the loaded registry for runtime web providers", () => {
    const loadedRegistry = { source: "loaded" };
    const mapRegistryProviders = vi.fn(() => ["provider"]);
    mocks.getLoadedRuntimePluginRegistry.mockReturnValue(loadedRegistry as never);

    resolvePluginWebProviders(
      {
        config: {},
        onlyPluginIds: ["brave"],
      },
      resolution({
        mapRegistryProviders,
      }),
    );

    expect(mockArg(mocks.getLoadedRuntimePluginRegistry).requiredPluginIds).toEqual(["brave"]);
    expect(mocks.loadOpenClawPlugins).not.toHaveBeenCalled();
  });

  it("caches setup web provider plugin loads by default", () => {
    const loadedRegistry = { source: "setup" };
    const mapRegistryProviders = vi.fn(() => ["provider"]);
    mocks.loadOpenClawPlugins.mockReturnValue(loadedRegistry as never);

    const providers = resolvePluginWebProviders(
      {
        config: {},
        mode: "setup",
      },
      resolution({
        mapRegistryProviders,
        resolveBundledPublicArtifactProviders: () => null,
      }),
    );

    expect(providers).toEqual(["provider"]);
    expect(mockArg(mocks.loadOpenClawPlugins).cache).toBe(true);
    expect(mockArg(mocks.loadOpenClawPlugins).onlyPluginIds).toEqual(["brave"]);
  });

  it("uses bundled runtime artifacts before loading a plugin registry", () => {
    const resolveBundledRuntimeArtifactProviders = vi.fn(() => ["provider"]);

    const providers = resolvePluginWebProviders(
      {
        config: {},
        workspaceDir: "/workspace",
        env: { FIRECRAWL_API_KEY: "" },
      },
      resolution({
        resolveCandidatePluginIds: () => ["firecrawl"],
        mapRegistryProviders: vi.fn(() => []),
        resolveBundledRuntimeArtifactProviders,
      }),
    );

    expect(providers).toEqual(["provider"]);
    expect(resolveBundledRuntimeArtifactProviders).toHaveBeenCalledWith({
      config: {},
      workspaceDir: "/workspace",
      env: { FIRECRAWL_API_KEY: "" },
      onlyPluginIds: ["firecrawl"],
    });
    expect(mocks.loadOpenClawPlugins).not.toHaveBeenCalled();
  });

  it("falls back to plugin loading when bundled runtime artifacts do not cover the scope", () => {
    const fallbackRegistry = { source: "fallback" };
    const mapRegistryProviders = vi.fn(() => ["provider"]);
    const resolveBundledRuntimeArtifactProviders = vi.fn(() => null);
    mocks.loadOpenClawPlugins.mockReturnValue(fallbackRegistry as never);

    const providers = resolvePluginWebProviders(
      {
        config: {},
      },
      resolution({
        resolveCandidatePluginIds: () => ["external-provider"],
        mapRegistryProviders,
        resolveBundledRuntimeArtifactProviders,
      }),
    );

    expect(providers).toEqual(["provider"]);
    expect(resolveBundledRuntimeArtifactProviders).toHaveBeenCalledTimes(1);
    expect(mocks.loadOpenClawPlugins).toHaveBeenCalledTimes(1);
    expect(mapRegistryProviders).toHaveBeenCalledWith({
      registry: fallbackRegistry,
      onlyPluginIds: ["external-provider"],
    });
  });

  it("falls back to a scoped provider load when the active runtime registry has no web providers", () => {
    const activeRegistry = { source: "active" };
    const fallbackRegistry = { source: "fallback" };
    const mapRegistryProviders = vi.fn(({ registry }) =>
      registry === fallbackRegistry ? ["brave"] : [],
    );
    mocks.getLoadedRuntimePluginRegistry.mockReturnValue(activeRegistry as never);
    mocks.loadOpenClawPlugins.mockReturnValue(fallbackRegistry as never);

    const result = resolvePluginWebProviders(
      {
        config: {},
      },
      resolution({
        resolveCandidatePluginIds: () => undefined,
        mapRegistryProviders,
      }),
    );

    expect(result).toEqual(["brave"]);
    expect(mocks.loadOpenClawPlugins).toHaveBeenCalledTimes(1);
    expect(mapRegistryProviders).toHaveBeenCalledTimes(2);
  });

  it("retains an empty request-owned web provider selection without registering plugins again", () => {
    const registry = createEmptyPluginRegistry();
    const mapRegistryProviders = vi.fn(() => []);

    const result = withPluginRuntimeRegistryScope(registry, () =>
      resolvePluginWebProviders(
        { config: {}, manifestRecords: [] },
        resolution({ resolveCandidatePluginIds: () => undefined, mapRegistryProviders }),
      ),
    );

    expect(result).toEqual([]);
    expect(mapRegistryProviders).toHaveBeenCalledExactlyOnceWith({
      registry,
      onlyPluginIds: undefined,
    });
    expect(mocks.getLoadedRuntimePluginRegistry).not.toHaveBeenCalled();
    expect(mocks.loadOpenClawPlugins).not.toHaveBeenCalled();
  });

  it.each([undefined, ["external-search"]])(
    "retains an exact generation's empty selection with candidates %j",
    (candidates) => {
      const registry = createEmptyPluginRegistry();
      const requestRegistry = createEmptyPluginRegistry();
      const mapRegistryProviders = vi.fn(() => []);

      const result = withPluginRuntimeRegistryScope(requestRegistry, () =>
        withPluginRuntimeGenerationRegistryScope(registry, () =>
          resolvePluginWebProviders(
            { config: {} },
            resolution({ resolveCandidatePluginIds: () => candidates, mapRegistryProviders }),
          ),
        ),
      );

      expect(result).toEqual([]);
      expect(mapRegistryProviders).toHaveBeenCalledExactlyOnceWith({
        registry,
        onlyPluginIds: candidates,
      });
      expect(mocks.getLoadedRuntimePluginRegistry).not.toHaveBeenCalled();
      expect(mocks.loadOpenClawPlugins).not.toHaveBeenCalled();
    },
  );

  it.each([
    { name: "unknown inventory", manifestRecords: undefined, scopedProviders: [] },
    {
      name: "an uninspected provider",
      manifestRecords: [createPluginManifestRecordFixture({ id: "external-search" })],
      scopedProviders: [],
    },
    {
      name: "an uninspected provider alongside another provider",
      manifestRecords: [createPluginManifestRecordFixture({ id: "external-search" })],
      scopedProviders: ["scoped-search"],
    },
  ])(
    "discovers undeclared providers from a request scope with $name",
    ({ manifestRecords, scopedProviders }) => {
      const registry = createEmptyPluginRegistry();
      const fallbackRegistry = createEmptyPluginRegistry();
      const mapRegistryProviders = vi.fn(({ registry: selected }) =>
        selected === fallbackRegistry ? ["external-search", "scoped-search"] : scopedProviders,
      );
      mocks.loadOpenClawPlugins.mockReturnValue(fallbackRegistry);

      const result = withPluginRuntimeRegistryScope(registry, () =>
        resolvePluginWebProviders(
          { config: {}, manifestRecords },
          resolution({ resolveCandidatePluginIds: () => undefined, mapRegistryProviders }),
        ),
      );

      expect(result).toEqual(["external-search", "scoped-search"]);
      expect(mocks.getLoadedRuntimePluginRegistry).not.toHaveBeenCalled();
      expect(mocks.loadOpenClawPlugins).toHaveBeenCalledTimes(1);
    },
  );

  it("does not treat an active registry missing declared candidates as authoritative", () => {
    // Regression: an active registry with SOME web providers used to win even when a
    // manifest-declared candidate (npm-installed Brave with BRAVE_API_KEY set) was
    // absent from it, so env-var auto-detect could never see the installed provider.
    const activeRegistry = { source: "active" };
    const scopedRegistry = { source: "scoped" };
    const mapRegistryProviders = vi.fn(({ registry }) =>
      registry === scopedRegistry ? ["brave", "grok"] : ["grok"],
    );
    mocks.getLoadedRuntimePluginRegistry.mockImplementation((args: unknown) => {
      const requiredPluginIds = (args as { requiredPluginIds?: readonly string[] })
        ?.requiredPluginIds;
      // Simulate active-registry coverage: brave never loaded at startup.
      if (requiredPluginIds?.includes("brave")) {
        return undefined;
      }
      return activeRegistry as never;
    });
    mocks.loadOpenClawPlugins.mockReturnValue(scopedRegistry as never);

    const result = resolvePluginWebProviders(
      {
        config: {},
        env: { BRAVE_API_KEY: "key" } as never,
      },
      resolution({
        resolveCandidatePluginIds: () => ["brave", "xai"],
        mapRegistryProviders,
      }),
    );

    expect(result).toEqual(["brave", "grok"]);
    expect(mocks.loadOpenClawPlugins).toHaveBeenCalledTimes(1);
  });
  it("retries an async registry preparation that failed", async () => {
    const failure = new Error("capture failed");
    mocks.loadOpenClawPluginsAsync
      .mockRejectedValueOnce(failure)
      .mockResolvedValueOnce(createEmptyPluginRegistry());
    const deps = resolution({ mapRegistryProviders: () => ["external-fetch"] });
    await expect(resolvePluginWebProvidersAsync({ config: {} }, deps)).rejects.toBe(failure);
    await expect(resolvePluginWebProvidersAsync({ config: {} }, deps)).resolves.toEqual([
      "external-fetch",
    ]);
    expect(mocks.loadOpenClawPluginsAsync).toHaveBeenCalledTimes(2);
  });

  it("discovers undeclared providers asynchronously in an incomplete request inventory", async () => {
    const registry = createEmptyPluginRegistry();
    const fallback = createEmptyPluginRegistry();
    mocks.loadOpenClawPluginsAsync.mockResolvedValue(fallback);
    const result = await withPluginRuntimeRegistryScope(registry, () =>
      resolvePluginWebProvidersAsync(
        { config: {} },
        resolution({
          resolveCandidatePluginIds: () => undefined,
          mapRegistryProviders: ({ registry: selected }) =>
            selected === fallback ? ["undeclared-fetch"] : [],
        }),
      ),
    );
    expect(result).toEqual(["undeclared-fetch"]);
    expect(mocks.loadOpenClawPluginsAsync).toHaveBeenCalledTimes(1);
    expect(mocks.loadOpenClawPlugins).not.toHaveBeenCalled();
  });

  it("keeps a complete empty async inventory authoritative", async () => {
    const registry = createEmptyPluginRegistry();
    const result = await withPluginRuntimeRegistryScope(registry, () =>
      resolvePluginWebProvidersAsync(
        { config: {}, manifestRecords: [] },
        resolution({
          resolveCandidatePluginIds: () => undefined,
          mapRegistryProviders: () => [],
        }),
      ),
    );
    expect(result).toEqual([]);
    expect(mocks.loadOpenClawPluginsAsync).not.toHaveBeenCalled();
  });

  it("keeps supplemental loading in its owner cache and rejects retired inspection results", async () => {
    const cache = createPluginCache();
    const manifest = createPluginManifestRecordFixture({ id: "external-fetch" });
    let released = false;
    const failure = new Error("Plugin tool inspection has been released");
    const assertCurrent = vi.fn(() => {
      if (released) {
        throw failure;
      }
    });
    mocks.getCurrentPluginToolInspection.mockReturnValue({
      registry: createEmptyPluginRegistry(),
      inspection: {
        manifests: new Map(),
        assertCurrent,
        withSupplementalCache: <T>(run: () => T) => withPluginCache(cache, run),
      },
      loadContext: { manifestRegistry: { plugins: [manifest], diagnostics: [] } },
    });
    const completion = createDeferredCore<ReturnType<typeof createEmptyPluginRegistry>>();
    mocks.loadOpenClawPluginsAsync.mockImplementation(() => {
      expect(getPluginCache()).toBe(cache);
      return completion.promise;
    });
    const mapRegistryProviders = vi.fn(() => ["external-fetch"]);
    const loading = resolvePluginWebProvidersAsync(
      {},
      resolution({
        resolveCandidatePluginIds: () => undefined,
        mapRegistryProviders,
      }),
    );
    try {
      released = true;
      completion.resolve(createEmptyPluginRegistry());
      await expect(loading).rejects.toBe(failure);
      expect(assertCurrent).toHaveBeenCalledOnce();
      expect(mapRegistryProviders).not.toHaveBeenCalled();
    } finally {
      completion.resolve(createEmptyPluginRegistry());
      await Promise.allSettled([loading]);
    }
  });
});
