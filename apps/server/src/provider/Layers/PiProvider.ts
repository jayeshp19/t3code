import * as nodePath from "node:path";

import type { PiSettings, ServerProvider, ServerProviderModel } from "@t3tools/contracts";
import { Cause, Effect, Equal, Layer, Stream } from "effect";
import { ChildProcessSpawner } from "effect/unstable/process";

import { ServerConfig } from "../../config.ts";
import { ServerSettingsService } from "../../serverSettings.ts";
import { makeManagedServerProvider } from "../makeManagedServerProvider.ts";
import { buildServerProvider, providerModelsFromSettings } from "../providerSnapshot.ts";
import { PiProvider } from "../Services/PiProvider.ts";
import {
  defaultPiCustomModelCapabilities,
  filterSupportedPiCustomModels,
  parsePiVersion,
  PiRuntime,
  piRuntimeErrorDetail,
  resolvePiAgentDir,
  type PiDiscoveredModel,
  type PiRuntimeShape,
} from "../piRuntime.ts";

const PROVIDER = "pi" as const;
const PI_PRESENTATION = {
  displayName: "Pi",
  showInteractionModeToggle: true,
} as const;
type PiAgentDirKind = "isolated" | "global" | "configured";

function flattenPiModels(
  models: ReadonlyArray<PiDiscoveredModel>,
): ReadonlyArray<ServerProviderModel> {
  return models
    .map((model) => ({
      slug: model.slug,
      name: model.name,
      subProvider: model.model.provider,
      isCustom: false,
      capabilities: model.capabilities,
    }))
    .toSorted((left, right) => left.name.localeCompare(right.name));
}

function buildPiProviderModels(
  builtInModels: ReadonlyArray<ServerProviderModel>,
  settings: PiSettings,
): ReadonlyArray<ServerProviderModel> {
  const availableProviders = new Set(
    builtInModels
      .map((model) => model.subProvider)
      .filter(
        (provider): provider is string => typeof provider === "string" && provider.length > 0,
      ),
  );
  return providerModelsFromSettings(
    builtInModels,
    PROVIDER,
    filterSupportedPiCustomModels(settings.customModels, { availableProviders }),
    defaultPiCustomModelCapabilities(),
  );
}

function buildPendingPiProvider(settings: PiSettings): ServerProvider {
  const checkedAt = new Date().toISOString();
  const models = buildPiProviderModels([], settings);

  if (!settings.enabled) {
    return buildServerProvider({
      provider: PROVIDER,
      presentation: PI_PRESENTATION,
      enabled: false,
      checkedAt,
      models,
      probe: {
        installed: false,
        version: null,
        status: "warning",
        auth: { status: "unknown" },
        message: "Pi is disabled in T3 Code settings.",
      },
    });
  }

  return buildServerProvider({
    provider: PROVIDER,
    presentation: PI_PRESENTATION,
    enabled: true,
    checkedAt,
    models,
    probe: {
      installed: false,
      version: null,
      status: "warning",
      auth: { status: "unknown" },
      message: "Checking Pi availability...",
    },
  });
}

function formatPiProbeError(cause: unknown): {
  readonly installed: boolean;
  readonly message: string;
} {
  const detail = piRuntimeErrorDetail(cause).toLowerCase();
  if (detail.includes("enoent") || detail.includes("notfound")) {
    return {
      installed: false,
      message: "Pi CLI (`pi`) is not installed or not on PATH.",
    };
  }
  return {
    installed: true,
    message: `Failed to check Pi: ${piRuntimeErrorDetail(cause)}`,
  };
}

function getPiAgentDirKind(input: {
  readonly agentDir: string;
  readonly isolatedAgentDir: string;
  readonly globalAgentDir: string;
}): PiAgentDirKind {
  const resolvedAgentDir = nodePath.resolve(input.agentDir);
  if (resolvedAgentDir === nodePath.resolve(input.isolatedAgentDir)) {
    return "isolated";
  }
  if (resolvedAgentDir === nodePath.resolve(input.globalAgentDir)) {
    return "global";
  }
  return "configured";
}

function getPiAgentDirLabel(kind: PiAgentDirKind): string {
  switch (kind) {
    case "isolated":
      return "isolated agent dir";
    case "global":
      return "global agent dir";
    case "configured":
      return "custom agent dir";
  }
}

function getPiAgentDirPhrase(kind: PiAgentDirKind): string {
  switch (kind) {
    case "isolated":
      return "T3 Code's isolated Pi agent directory";
    case "global":
      return "the global Pi agent directory";
    case "configured":
      return "the configured Pi agent directory";
  }
}

const buildMissingPiModelsMessage = Effect.fn("buildMissingPiModelsMessage")(function* (input: {
  readonly settings: PiSettings;
  readonly serverConfig: {
    readonly stateDir: string;
  };
  readonly piRuntime: Pick<PiRuntimeShape, "loadInventory">;
  readonly agentDirKind: PiAgentDirKind;
}) {
  const currentAgentDirPhrase = getPiAgentDirPhrase(input.agentDirKind);
  if (input.agentDirKind !== "isolated") {
    return `Pi is installed, but no authenticated models are available in ${currentAgentDirPhrase}.`;
  }

  const globalAgentDir = resolvePiAgentDir({
    settings: {
      ...input.settings,
      agentDir: "",
      useGlobalAgentDir: true,
    },
    serverConfig: input.serverConfig,
  });
  const globalInventoryExit = yield* Effect.exit(
    input.piRuntime.loadInventory({
      agentDir: globalAgentDir,
      ...(input.settings.sdkRoot ? { sdkRoot: input.settings.sdkRoot } : {}),
    }),
  );

  if (
    globalInventoryExit._tag === "Success" &&
    globalInventoryExit.value.availableModels.length > 0
  ) {
    const globalAvailableCount = globalInventoryExit.value.availableModels.length;
    return `No authenticated Pi models are available in ${currentAgentDirPhrase}. ${globalAvailableCount} model${globalAvailableCount === 1 ? "" : "s"} ${globalAvailableCount === 1 ? "is" : "are"} available in the global Pi agent directory. Enable "Use global Pi agent directory" or set the Pi agent directory to \`${globalAgentDir}\`.`;
  }

  return `No authenticated Pi models are available in ${currentAgentDirPhrase}. Sign in with \`pi\`, or enable "Use global Pi agent directory" if your global Pi setup already works.`;
});

export const PiProviderLive = Layer.effect(
  PiProvider,
  Effect.gen(function* () {
    const serverSettings = yield* ServerSettingsService;
    const serverConfig = yield* ServerConfig;
    const piRuntime = yield* PiRuntime;
    const childProcessSpawner = yield* ChildProcessSpawner.ChildProcessSpawner;

    const getProviderSettings = serverSettings.getSettings.pipe(
      Effect.map((settings) => settings.providers.pi),
    );

    const checkPiProviderStatus = Effect.fn("checkPiProviderStatus")(function* (
      settings: PiSettings,
    ): Effect.fn.Return<ServerProvider, never> {
      const checkedAt = new Date().toISOString();
      const isolatedAgentDir = nodePath.join(serverConfig.stateDir, "pi", "agent");
      const globalAgentDir = resolvePiAgentDir({
        settings: {
          ...settings,
          agentDir: "",
          useGlobalAgentDir: true,
        },
        serverConfig,
      });
      const agentDir = resolvePiAgentDir({ settings, serverConfig });
      const baseModels = buildPiProviderModels([], settings);

      if (!settings.enabled) {
        return buildServerProvider({
          provider: PROVIDER,
          presentation: PI_PRESENTATION,
          enabled: false,
          checkedAt,
          models: baseModels,
          probe: {
            installed: false,
            version: null,
            status: "warning",
            auth: { status: "unknown" },
            message: "Pi is disabled in T3 Code settings.",
          },
        });
      }

      const versionExit = yield* Effect.exit(
        piRuntime
          .runPiCommand({
            binaryPath: settings.binaryPath,
            args: ["--version"],
          })
          .pipe(
            Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, childProcessSpawner),
          ),
      );
      if (versionExit._tag === "Failure") {
        const failure = formatPiProbeError(Cause.squash(versionExit.cause));
        return buildServerProvider({
          provider: PROVIDER,
          presentation: PI_PRESENTATION,
          enabled: true,
          checkedAt,
          models: baseModels,
          probe: {
            installed: failure.installed,
            version: null,
            status: "error",
            auth: { status: "unknown" },
            message: failure.message,
          },
        });
      }

      const version = parsePiVersion(versionExit.value.stdout);
      const inventoryExit = yield* Effect.exit(
        piRuntime.loadInventory({
          agentDir,
          ...(settings.sdkRoot ? { sdkRoot: settings.sdkRoot } : {}),
        }),
      );
      if (inventoryExit._tag === "Failure") {
        return buildServerProvider({
          provider: PROVIDER,
          presentation: PI_PRESENTATION,
          enabled: true,
          checkedAt,
          models: baseModels,
          probe: {
            installed: true,
            version,
            status: "error",
            auth: { status: "unknown" },
            message: `Pi is installed, but its agent directory could not be loaded: ${piRuntimeErrorDetail(Cause.squash(inventoryExit.cause))}`,
          },
        });
      }

      const models = buildPiProviderModels(
        flattenPiModels(inventoryExit.value.availableModels),
        settings,
      );
      const availableCount = inventoryExit.value.availableModels.length;
      const configuredAuthProviderCount = new Set(
        inventoryExit.value.availableModels.map((model) => model.model.provider),
      ).size;
      const resolvedAgentDirKind = getPiAgentDirKind({
        agentDir,
        isolatedAgentDir,
        globalAgentDir,
      });
      const resolvedAgentDirLabel = getPiAgentDirLabel(resolvedAgentDirKind);
      const statusMessage =
        availableCount > 0
          ? `${availableCount} Pi model${availableCount === 1 ? "" : "s"} available across ${configuredAuthProviderCount} configured provider${configuredAuthProviderCount === 1 ? "" : "s"} in ${getPiAgentDirPhrase(resolvedAgentDirKind)}.`
          : yield* buildMissingPiModelsMessage({
              settings,
              serverConfig,
              piRuntime,
              agentDirKind: resolvedAgentDirKind,
            });

      return buildServerProvider({
        provider: PROVIDER,
        presentation: PI_PRESENTATION,
        enabled: true,
        checkedAt,
        models,
        probe: {
          installed: true,
          version,
          status: availableCount > 0 ? "ready" : "warning",
          auth: {
            status: availableCount > 0 ? "authenticated" : "unauthenticated",
            type: "pi",
            label: resolvedAgentDirLabel,
          },
          message: statusMessage,
        },
      });
    });

    return yield* makeManagedServerProvider<PiSettings>({
      getSettings: getProviderSettings.pipe(Effect.orDie),
      streamSettings: serverSettings.streamChanges.pipe(
        Stream.map((settings) => settings.providers.pi),
      ),
      haveSettingsChanged: (previous, next) => !Equal.equals(previous, next),
      initialSnapshot: buildPendingPiProvider,
      checkProvider: getProviderSettings.pipe(
        Effect.flatMap((settings) => checkPiProviderStatus(settings)),
      ),
    });
  }),
);
