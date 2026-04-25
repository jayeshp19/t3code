import * as NodeServices from "@effect/platform-node/NodeServices";
import type { ServerProvider } from "@t3tools/contracts";
import { createModelCapabilities } from "@t3tools/shared/model";
import { assert, it } from "@effect/vitest";
import { Effect, FileSystem } from "effect";
import { vi } from "vitest";

import {
  hydrateCachedProvider,
  readProviderStatusCache,
  resolveProviderStatusCachePath,
  writeProviderStatusCache,
} from "./providerStatusCache.ts";

const emptyCapabilities = createModelCapabilities({ optionDescriptors: [] });

const makeProvider = (
  provider: ServerProvider["provider"],
  overrides?: Partial<ServerProvider>,
): ServerProvider => ({
  provider,
  enabled: true,
  installed: true,
  version: "1.0.0",
  status: "ready",
  auth: { status: "authenticated" },
  checkedAt: "2026-04-11T00:00:00.000Z",
  models: [],
  slashCommands: [],
  skills: [],
  ...overrides,
});

it.layer(NodeServices.layer)("providerStatusCache", (it) => {
  it.effect("writes and reads provider status snapshots", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const tempDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-provider-cache-" });
      const codexProvider = makeProvider("codex");
      const claudeProvider = makeProvider("claudeAgent", {
        status: "warning",
        auth: { status: "unknown" },
      });
      const openCodeProvider = makeProvider("opencode", {
        status: "warning",
        auth: { status: "unknown", type: "opencode" },
      });
      const codexPath = resolveProviderStatusCachePath({
        cacheDir: tempDir,
        provider: "codex",
      });
      const claudePath = resolveProviderStatusCachePath({
        cacheDir: tempDir,
        provider: "claudeAgent",
      });
      const openCodePath = resolveProviderStatusCachePath({
        cacheDir: tempDir,
        provider: "opencode",
      });

      yield* writeProviderStatusCache({
        filePath: codexPath,
        provider: codexProvider,
      });
      yield* writeProviderStatusCache({
        filePath: claudePath,
        provider: claudeProvider,
      });
      yield* writeProviderStatusCache({
        filePath: openCodePath,
        provider: openCodeProvider,
      });

      assert.deepStrictEqual(yield* readProviderStatusCache(codexPath), codexProvider);
      assert.deepStrictEqual(yield* readProviderStatusCache(claudePath), claudeProvider);
      assert.deepStrictEqual(yield* readProviderStatusCache(openCodePath), openCodeProvider);
    }),
  );

  it.effect("uses collision-proof temp paths for concurrent writes", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const tempDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-provider-cache-" });
      const cachePath = resolveProviderStatusCachePath({
        cacheDir: tempDir,
        provider: "opencode",
      });
      const nowSpy = vi.spyOn(Date, "now").mockReturnValue(1_777_108_196_843);

      yield* Effect.all(
        Array.from({ length: 12 }, (_, index) =>
          writeProviderStatusCache({
            filePath: cachePath,
            provider: makeProvider("opencode", {
              checkedAt: `2026-04-11T00:00:${String(index).padStart(2, "0")}.000Z`,
            }),
          }),
        ),
        { concurrency: "unbounded" },
      ).pipe(Effect.ensuring(Effect.sync(() => nowSpy.mockRestore())));

      const cachedProvider = yield* readProviderStatusCache(cachePath);
      assert.equal(cachedProvider?.provider, "opencode");
    }),
  );

  it("hydrates cached provider status while preserving current settings-derived models", () => {
    const cachedCodex = makeProvider("codex", {
      checkedAt: "2026-04-10T12:00:00.000Z",
      models: [
        {
          slug: "gpt-5-mini",
          name: "GPT-5 Mini",
          isCustom: false,
          capabilities: emptyCapabilities,
        },
      ],
      message: "Cached message",
      skills: [
        {
          name: "github:gh-fix-ci",
          path: "/tmp/skills/gh-fix-ci/SKILL.md",
          enabled: true,
          displayName: "CI Debug",
        },
      ],
    });
    const fallbackCodex = makeProvider("codex", {
      models: [
        {
          slug: "gpt-5.4",
          name: "GPT-5.4",
          isCustom: false,
          capabilities: emptyCapabilities,
        },
      ],
      message: "Pending refresh",
    });

    assert.deepStrictEqual(
      hydrateCachedProvider({
        cachedProvider: cachedCodex,
        fallbackProvider: fallbackCodex,
      }),
      {
        ...fallbackCodex,
        models: [
          ...fallbackCodex.models,
          {
            slug: "gpt-5-mini",
            name: "GPT-5 Mini",
            isCustom: false,
            capabilities: emptyCapabilities,
          },
        ],
        installed: cachedCodex.installed,
        version: cachedCodex.version,
        status: cachedCodex.status,
        auth: cachedCodex.auth,
        checkedAt: cachedCodex.checkedAt,
        slashCommands: cachedCodex.slashCommands,
        skills: cachedCodex.skills,
        message: cachedCodex.message,
      },
    );
  });

  it("ignores stale cached enabled state when the provider is now disabled", () => {
    const cachedCodex = makeProvider("codex", {
      checkedAt: "2026-04-10T12:00:00.000Z",
      message: "Cached ready status",
    });
    const disabledFallback = makeProvider("codex", {
      enabled: false,
      installed: false,
      version: null,
      status: "disabled",
      auth: { status: "unknown" },
      message: "Codex is disabled in T3 Code settings.",
    });

    assert.deepStrictEqual(
      hydrateCachedProvider({
        cachedProvider: cachedCodex,
        fallbackProvider: disabledFallback,
      }),
      disabledFallback,
    );
  });

  it("does not append stale cached Pi models onto the fallback snapshot", () => {
    const cachedPi = makeProvider("pi", {
      models: [
        {
          slug: "openai/gpt-5",
          name: "GPT-5",
          isCustom: false,
          capabilities: emptyCapabilities,
        },
      ],
      auth: { status: "authenticated", type: "pi", label: "global agent dir" },
    });
    const fallbackPi = makeProvider("pi", {
      status: "warning",
      auth: { status: "unauthenticated", type: "pi", label: "isolated agent dir" },
      models: [],
      message: "No authenticated Pi models are available.",
    });

    assert.deepStrictEqual(
      hydrateCachedProvider({
        cachedProvider: cachedPi,
        fallbackProvider: fallbackPi,
      }),
      {
        provider: fallbackPi.provider,
        enabled: fallbackPi.enabled,
        models: [],
        installed: cachedPi.installed,
        version: cachedPi.version,
        status: cachedPi.status,
        auth: cachedPi.auth,
        checkedAt: cachedPi.checkedAt,
        slashCommands: cachedPi.slashCommands,
        skills: cachedPi.skills,
      },
    );
  });
});
