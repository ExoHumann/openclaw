import fs from "node:fs";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { withArtifactPreservingStateReads } from "../state/openclaw-state-db-readonly.js";
import { closeOpenClawStateDatabaseByPathAsync } from "../state/openclaw-state-db.js";
import { resolveOpenClawStateSqlitePath } from "../state/openclaw-state-db.paths.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { resolvePluginInstallRoots, withPluginInstallRoots } from "./install-root-context.js";
import { writePersistedInstalledPluginIndex } from "./installed-plugin-index-store-write.js";
import { readPersistedInstalledPluginIndex } from "./installed-plugin-index-store.js";
import { createPluginCache, retirePluginCache, withPluginCache } from "./plugin-cache.js";
import { createFixture } from "./plugin-generation-artifact.admission.test-support.js";
import { preparePluginGenerationArtifact } from "./plugin-generation-worker.js";
import { preparePluginNativeAdmissions } from "./plugin-native-admission-state.js";
import { withPluginSourceAdmissionPublisher } from "./plugin-source-admission-store.js";
import { withPluginSourceCaptureStorage } from "./plugin-source-capture-context.js";

const temp = useAutoCleanupTempDirTracker(afterEach);

it("finishes a capture after more than two minutes without retiring its worker", async () => {
  const root = fs.realpathSync(temp.make("plugin-generation-worker-long-capture-"));
  const fixture = createFixture(path.join(root, "installed"), false);
  const roots = { ...resolvePluginInstallRoots(), stateDir: root };
  const cache = createPluginCache();
  let releasePublication!: () => void;
  const gate = new Promise<void>((resolve) => {
    releasePublication = resolve;
  });
  let publicationStarted!: () => void;
  const started = new Promise<void>((resolve) => {
    publicationStarted = resolve;
  });
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance"] });
  try {
    await withPluginCache(cache, () =>
      withPluginInstallRoots(roots, () =>
        withPluginSourceCaptureStorage({ stateDir: root, placement: "temporary" }, async () => {
          preparePluginNativeAdmissions(fixture.index, cache);
          const preparing = withPluginSourceAdmissionPublisher(
            async () => {
              publicationStarted();
              await gate;
              return false;
            },
            () => preparePluginGenerationArtifact({ rootDir: fixture.root, source: fixture.entry }),
          );
          // Observe rejection while the publication gate is held, then assert the result below.
          void preparing.catch(() => {});
          await started;
          // Advance the real pool's task timer without sleeping for two minutes.
          try {
            await vi.advanceTimersByTimeAsync(120_001);
            releasePublication();
            const prepared = await preparing;
            try {
              expect(fs.readFileSync(prepared.artifact.resolve(fixture.entry), "utf8")).toContain(
                "fixture",
              );
            } finally {
              await prepared.artifact.disposeAsync();
            }
          } finally {
            vi.useRealTimers();
          }
        }),
      ),
    );
  } finally {
    vi.useRealTimers();
    releasePublication();
    await retirePluginCache(cache);
  }
});

it("publishes native admission to pinned install roots while capture storage is redirected", async () => {
  await withOpenClawTestState({ label: "worker-pinned-admission" }, async (state) => {
    const fixture = createFixture(state.path("installed"), false);
    const roots = { ...resolvePluginInstallRoots(state.env), stateDir: state.path("operator") };
    const cache = createPluginCache();
    await writePersistedInstalledPluginIndex(fixture.index, { stateDir: roots.stateDir });
    await writePersistedInstalledPluginIndex(fixture.index, { stateDir: state.stateDir });
    try {
      await withPluginCache(cache, () =>
        withPluginInstallRoots(roots, () =>
          withPluginSourceCaptureStorage(
            { stateDir: state.stateDir, placement: "temporary" },
            async () => {
              preparePluginNativeAdmissions(fixture.index, cache);
              const prepared = await preparePluginGenerationArtifact({
                rootDir: fixture.root,
                source: fixture.entry,
              });
              try {
                const captured = fs.realpathSync(prepared.artifact.resolve(fixture.filename));
                expect(fs.readFileSync(captured).equals(fixture.bytes)).toBe(true);
                const persisted = await readPersistedInstalledPluginIndex({
                  stateDir: roots.stateDir,
                });
                const receipt = Object.values(persisted?.plugins[0]?.sourceAdmissions ?? {})[0];
                expect(receipt?.nativeArtifacts[fixture.filename]?.capturedPath).toBe(captured);
                const redirected = await readPersistedInstalledPluginIndex({
                  stateDir: state.stateDir,
                });
                expect(Object.keys(redirected?.plugins[0]?.sourceAdmissions ?? {})).toHaveLength(0);
              } finally {
                await prepared.artifact.disposeAsync();
              }
            },
          ),
        ),
      );
    } finally {
      await retirePluginCache(cache);
      await closeOpenClawStateDatabaseByPathAsync(
        resolveOpenClawStateSqlitePath({ ...state.env, OPENCLAW_STATE_DIR: roots.stateDir }),
      );
    }
  });
});

it("keeps captured files and recovery alive until their owning artifacts are released", async () => {
  const root = fs.realpathSync(temp.make("plugin-generation-worker-"));
  const source = path.join(root, "source");
  fs.mkdirSync(source);
  fs.writeFileSync(
    path.join(source, "package.json"),
    JSON.stringify({ name: "worker-fixture", version: "1.0.0", type: "module" }),
  );
  const entry = path.join(source, "index.js");
  fs.writeFileSync(entry, "export const value = 42;");
  await withArtifactPreservingStateReads(() =>
    withPluginSourceCaptureStorage({ stateDir: root, placement: "temporary" }, async () => {
      const prepared = await preparePluginGenerationArtifact({ rootDir: source, source: entry });
      prepared.attachModuleSource((filename) => filename);
      const artifact = prepared.artifact;
      expect(fs.readFileSync(artifact.resolve(entry), "utf8")).toContain("42");
      const recovery = artifact.captureRecoverySource();
      await artifact.disposeAsync();
      expect(fs.readFileSync(recovery.resolve(entry), "utf8")).toContain("42");
      await recovery.disposeAsync();
    }),
  );
});

it("isolates an active artifact from a sibling capture waiting on host publication", async () => {
  const root = fs.realpathSync(temp.make("plugin-generation-worker-sibling-"));
  const fixture = createFixture(path.join(root, "installed"), false);
  const cache = createPluginCache();
  const roots = { ...resolvePluginInstallRoots(), stateDir: root };
  let releasePublication!: () => void;
  const gate = new Promise<void>((resolve) => {
    releasePublication = resolve;
  });
  let publicationStarted!: () => void;
  const started = new Promise<void>((resolve) => {
    publicationStarted = resolve;
  });
  try {
    await withPluginCache(cache, () =>
      withPluginInstallRoots(roots, () =>
        withPluginSourceCaptureStorage({ stateDir: root, placement: "temporary" }, async () => {
          preparePluginNativeAdmissions(fixture.index, cache);
          const first = await withPluginSourceAdmissionPublisher(
            async () => false,
            () => preparePluginGenerationArtifact({ rootDir: fixture.root, source: fixture.entry }),
          );
          const firstDirectory = path.dirname(first.artifact.boundaryRoot);
          const preparing = withPluginSourceAdmissionPublisher(
            async () => {
              publicationStarted();
              await gate;
              return false;
            },
            () => preparePluginGenerationArtifact({ rootDir: fixture.root, source: fixture.entry }),
          );
          try {
            await started;
            // Registration may schedule a lazy import while another plugin is preparing.
            await new Promise<void>((resolve, reject) => {
              setTimeout(() => {
                try {
                  expect(fs.readFileSync(first.artifact.resolve(fixture.entry), "utf8")).toContain(
                    "fixture",
                  );
                  resolve();
                } catch (error) {
                  reject(error instanceof Error ? error : new Error(String(error)));
                }
              }, 0);
            });
          } finally {
            releasePublication();
            const second = await preparing;
            expect(path.dirname(second.artifact.boundaryRoot)).not.toBe(firstDirectory);
            const secondDirectory = path.dirname(second.artifact.boundaryRoot);
            const recovery = first.artifact.captureRecoverySource();
            await first.artifact.disposeAsync();
            await second.artifact.disposeAsync();
            expect(fs.readFileSync(recovery.resolve(fixture.entry), "utf8")).toContain("fixture");
            await recovery.disposeAsync();
            expect(fs.existsSync(firstDirectory)).toBe(false);
            expect(fs.existsSync(secondDirectory)).toBe(false);
          }
          await expect(
            preparePluginGenerationArtifact({
              rootDir: path.join(root, "missing"),
              source: fixture.entry,
            }),
          ).rejects.toThrow();
        }),
      ),
    );
  } finally {
    releasePublication();
    await retirePluginCache(cache);
  }
});
