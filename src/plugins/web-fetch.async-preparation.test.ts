// Gateway-thread preparation requires the plugin suite's process pool on every platform.
import { setImmediate as nextTurn } from "node:timers/promises";
import { afterAll, afterEach, expect, it, vi } from "vitest";
import { awaitGateBeforeSettlement } from "../../test/helpers/promise.js";
import { createWebFetchTool } from "../agents/tools/web-fetch.js";
import type { OpenClawConfig } from "../config/types.js";
import { createDeferredCore } from "../shared/deferred.js";
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
import { createEmptyPluginRegistry } from "./registry-empty.js";
import { withPluginRuntimeRegistryScope } from "./runtime/gateway-request-scope.js";
const { fetchWithWebToolsNetworkGuardMock } = vi.hoisted(() => ({
  fetchWithWebToolsNetworkGuardMock: vi.fn(),
}));

// mock-isolation: Force the network failure while retaining real provider discovery and preparation.
vi.mock("../agents/tools/web-guarded-fetch.js", () => ({
  fetchWithWebToolsNetworkGuard: fetchWithWebToolsNetworkGuardMock,
}));

afterEach(() => {
  vi.restoreAllMocks();
  resetPluginLoaderTestStateForTest();
});
afterAll(cleanupPluginLoaderFixturesForTest);

it("serves cold web-fetch fallbacks through worker preparation and reuses the captured provider", async () => {
  useNoBundledPlugins();
  // Deliberately omit manifest contracts: legacy providers must remain discoverable.
  const plugin = writePlugin({
    id: "cold-fetch",
    registration: `api.registerWebFetchProvider({
      id: "cold-fetch", label: "Cold fetch", hint: "fixture", requiresCredential: false,
      credentialLabel: "unused", envVars: [],
      getCredentialValue: () => undefined, setCredentialValue: () => {},
      createTool: () => ({ description: "fixture", parameters: {},
        execute: async () => ({ text: "worker-backed provider content", extractor: "cold-fetch" }) })
    });`,
  });
  const config: OpenClawConfig = {
    plugins: { allow: [plugin.id], load: { paths: [plugin.file] }, slots: { memory: "none" } },
    tools: { web: { fetch: { provider: plugin.id, cacheTtlMinutes: 0 } } },
  };
  fetchWithWebToolsNetworkGuardMock.mockRejectedValue(new Error("fixture upstream unavailable"));
  const entered = createDeferredCore();
  const release = createDeferredCore();
  const prepare = preparation.preparePluginGenerationArtifact;
  const capture = vi
    .spyOn(preparation, "preparePluginGenerationArtifact")
    .mockImplementation(async (params) => {
      entered.resolve();
      await release.promise;
      return prepare(params);
    });
  const cache = createPluginCache();
  try {
    await withPluginSourceCaptureStorage(
      { stateDir: makePluginLoaderTempDir(), placement: "state" },
      () =>
        withPluginCache(cache, () =>
          withPluginRuntimeRegistryScope(createEmptyPluginRegistry(), async () => {
            const tool = createWebFetchTool({ config });
            if (!tool) {
              throw new Error("web_fetch tool unavailable");
            }
            const invoke = (id: string) => tool.execute(id, { url: `https://example.com/${id}` });
            const first = invoke("cold-first");
            const owned = [first];
            try {
              await awaitGateBeforeSettlement(
                entered.promise,
                first,
                "fallback completed without worker preparation",
              );
              let completed = false;
              void first.then(
                () => {
                  completed = true;
                },
                () => {
                  completed = true;
                },
              );
              const second = invoke("cold-concurrent");
              owned.push(second);
              // A queued event-loop callback remains serviceable while preparation is pending.
              await nextTurn();
              expect(completed).toBe(false);
              release.resolve();
              const results = await Promise.all([first, second]);
              for (const result of results) {
                expect(result.details).toMatchObject({
                  extractor: "cold-fetch",
                  text: expect.stringContaining("worker-backed provider content"),
                });
              }
              expect(capture).toHaveBeenCalledTimes(1);
              const repeated = await invoke("cold-repeated");
              expect(repeated.details).toMatchObject({ extractor: "cold-fetch" });
              expect(fetchWithWebToolsNetworkGuardMock).toHaveBeenCalledTimes(3);
              expect(capture).toHaveBeenCalledTimes(1);
            } finally {
              release.resolve();
              await Promise.allSettled(owned);
            }
          }),
        ),
    );
  } finally {
    release.resolve();
    await retirePluginCache(cache);
  }
});
