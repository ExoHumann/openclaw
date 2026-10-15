import { afterAll, afterEach, expect, it, vi } from "vitest";
import { awaitGateBeforeSettlement } from "../../test/helpers/promise.js";
import { createDeferredCore } from "../shared/deferred.js";
import { loadOpenClawPlugins, loadOpenClawPluginsAsync } from "./loader.js";
import {
  cleanupPluginLoaderFixturesForTest,
  makePluginLoaderTempDir,
  resetPluginLoaderTestStateForTest,
  useNoBundledPlugins,
  writePlugin,
} from "./loader.test-fixtures.js";
import { createPluginCache, retirePluginCache, withPluginCache } from "./plugin-cache.js";
import * as preparation from "./plugin-generation-worker.js";
import { withPluginSourceCaptureStorage } from "./plugin-source-capture-context.js";

afterEach(() => {
  vi.restoreAllMocks();
  resetPluginLoaderTestStateForTest();
});
afterAll(cleanupPluginLoaderFixturesForTest);

function fixture() {
  useNoBundledPlugins();
  const first = writePlugin({
    id: "first-external",
    registration: 'api.registerProvider({ id: "first", label: "First", auth: [] });',
  });
  const second = writePlugin({
    id: "second-external",
    registration: 'api.registerProvider({ id: "second", label: "Second", auth: [] });',
  });
  return {
    first,
    second,
    options: {
      activate: false,
      config: {
        plugins: {
          allow: [first.id, second.id],
          load: { paths: [first.file, second.file] },
          slots: { memory: "none" },
        },
      },
    },
  };
}

async function isolated<T>(run: () => Promise<T>) {
  const cache = createPluginCache();
  try {
    return await withPluginSourceCaptureStorage(
      { stateDir: makePluginLoaderTempDir(), placement: "state" },
      () => withPluginCache(cache, run),
    );
  } finally {
    await retirePluginCache(cache);
  }
}

it("waits for selected external source acquisition before publishing registrations", async () => {
  const { options } = fixture();
  const entered = createDeferredCore();
  const release = createDeferredCore();
  const prepare = preparation.preparePluginGenerationArtifact;
  let published = false;
  vi.spyOn(preparation, "preparePluginGenerationArtifact").mockImplementation(async (params) => {
    entered.resolve();
    await release.promise;
    return prepare(params);
  });
  await isolated(async () => {
    const loading = loadOpenClawPluginsAsync(options).then((registry) => {
      published = true;
      return registry;
    });
    try {
      await awaitGateBeforeSettlement(
        entered.promise,
        loading,
        "Registry published before source acquisition",
      );
      expect(published).toBe(false);
    } finally {
      release.resolve();
    }
    const registry = await loading;
    expect(registry.providers.map(({ provider }) => provider.label)).toEqual(["First", "Second"]);
    expect(registry.plugins.every((plugin) => plugin.status === "loaded")).toBe(true);
  });
});

it("records acquisition failure for one plugin and still loads its sibling", async () => {
  const { first, second, options } = fixture();
  const prepare = preparation.preparePluginGenerationArtifact;
  vi.spyOn(preparation, "preparePluginGenerationArtifact").mockImplementation(async (params) => {
    if (params.rootDir === first.dir) {
      throw new Error("source acquisition failed");
    }
    return prepare(params);
  });
  await isolated(async () => {
    const registry = await loadOpenClawPluginsAsync(options);
    expect(registry.plugins.find((plugin) => plugin.id === first.id)?.status).toBe("error");
    expect(registry.plugins.find((plugin) => plugin.id === second.id)?.status).toBe("loaded");
    expect(registry.providers.map(({ provider }) => provider.label)).toEqual(["Second"]);
  });
});

it("keeps synchronous CLI loading independent of worker acquisition", async () => {
  const { options } = fixture();
  vi.spyOn(preparation, "preparePluginGenerationArtifact").mockRejectedValue(
    new Error("worker unavailable"),
  );
  await isolated(async () => {
    const registry = loadOpenClawPlugins(options);
    expect(registry.providers.map(({ provider }) => provider.label)).toEqual(["First", "Second"]);
  });
});

it("reuses a loaded registry without reacquiring its external sources", async () => {
  const { options } = fixture();
  await isolated(async () => {
    const first = await loadOpenClawPluginsAsync(options);
    vi.spyOn(preparation, "preparePluginGenerationArtifact").mockRejectedValue(
      new Error("new acquisition unavailable"),
    );
    const second = await loadOpenClawPluginsAsync(options);
    expect(second).toBe(first);
    expect(second.providers.map(({ provider }) => provider.label)).toEqual(["First", "Second"]);
  });
});

it("joins a pending async registry load and reuses its completed registration", async () => {
  const { options } = fixture();
  const entered = createDeferredCore();
  const release = createDeferredCore();
  const prepare = preparation.preparePluginGenerationArtifact;
  const acquisition = vi
    .spyOn(preparation, "preparePluginGenerationArtifact")
    .mockImplementation(async (params) => {
      entered.resolve();
      await release.promise;
      return prepare(params);
    });
  await isolated(async () => {
    const first = loadOpenClawPluginsAsync(options);
    let second: ReturnType<typeof loadOpenClawPluginsAsync> | undefined;
    try {
      await awaitGateBeforeSettlement(
        entered.promise,
        first,
        "Registry published before source acquisition",
      );
      second = loadOpenClawPluginsAsync(options);
      // Attach rejection handlers before releasing preparation: an uncoordinated
      // second load throws PluginLoadReentryError while the first is pending.
      const joined = Promise.all([first, second]);
      release.resolve();
      const [firstRegistry, secondRegistry] = await joined;
      expect(secondRegistry).toBe(firstRegistry);
      expect(secondRegistry.providers.map(({ provider }) => provider.label)).toEqual([
        "First",
        "Second",
      ]);
      expect(acquisition).toHaveBeenCalledTimes(2);
    } finally {
      release.resolve();
      await Promise.allSettled(second ? [first, second] : [first]);
    }
  });
});

it("applies each waiting caller's throwOnLoadError policy", async () => {
  const { options } = fixture();
  const entered = createDeferredCore();
  const release = createDeferredCore();
  const acquisition = vi
    .spyOn(preparation, "preparePluginGenerationArtifact")
    .mockImplementation(async () => {
      entered.resolve();
      await release.promise;
      throw new Error("fixture acquisition failed");
    });
  await isolated(async () => {
    const tolerant = loadOpenClawPluginsAsync(options);
    let strict: ReturnType<typeof loadOpenClawPluginsAsync> | undefined;
    try {
      await awaitGateBeforeSettlement(
        entered.promise,
        tolerant,
        "Registry published before source acquisition",
      );
      strict = loadOpenClawPluginsAsync({ ...options, throwOnLoadError: true });
      const settled = Promise.allSettled([tolerant, strict]);
      release.resolve();
      const [ordinary, rejecting] = await settled;
      expect(ordinary.status).toBe("fulfilled");
      expect(rejecting.status).toBe("rejected");
      if (rejecting.status === "rejected") {
        expect(rejecting.reason.name).toBe("PluginLoadFailureError");
      }
      expect(acquisition).toHaveBeenCalledTimes(2);
    } finally {
      release.resolve();
      await Promise.allSettled(strict ? [tolerant, strict] : [tolerant]);
    }
  });
});

it("keeps explicit cache opt-outs as independent registry loads", async () => {
  const { options } = fixture();
  await isolated(async () => {
    const first = await loadOpenClawPluginsAsync({ ...options, cache: false });
    const second = await loadOpenClawPluginsAsync({ ...options, cache: false });
    expect(second).not.toBe(first);
    expect(second.providers.map(({ provider }) => provider.label)).toEqual(["First", "Second"]);
  });
});

it("does not join pending registrations across inventory owners", async () => {
  const { options } = fixture();
  const loads = [
    isolated(() => loadOpenClawPluginsAsync(options)),
    isolated(() => loadOpenClawPluginsAsync(options)),
  ] as const;
  try {
    const [first, second] = await Promise.all(loads);
    expect(second).not.toBe(first);
    expect(second.providers.map(({ provider }) => provider.label)).toEqual(["First", "Second"]);
  } finally {
    await Promise.allSettled(loads);
  }
});
