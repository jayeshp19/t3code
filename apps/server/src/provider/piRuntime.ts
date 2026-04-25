import * as nodePath from "node:path";

import type { ModelCapabilities, PiSettings, ThreadId } from "@t3tools/contracts";
import { Context, Data, Effect, Layer } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";

import type { ServerConfigShape } from "../config.ts";
import { createModelCapabilities } from "@t3tools/shared/model";
import {
  getDefaultPiAgentDir,
  loadPiSdkEffect,
  type PiAgentSession,
  type PiAgentSessionRuntime,
  type PiAuthStorage,
  type PiCreateAgentSessionRuntimeFactory,
  type PiExtensionFactory,
  type PiModel,
  type PiModelRegistry,
  type PiSettingsManager,
  type PiSdk,
} from "./piSdk.ts";
import {
  buildSelectOptionDescriptor,
  parseGenericCliVersion,
  spawnAndCollect,
  type CommandResult,
} from "./providerSnapshot.ts";

export const PI_RESUME_CURSOR_VERSION = 1 as const;
const PI_SESSION_DIR_ROOT = "t3-sessions";
const DEFAULT_PI_REASONING_LEVELS = [
  { value: "off", label: "Off" },
  { value: "minimal", label: "Minimal" },
  { value: "low", label: "Low" },
  { value: "medium", label: "Medium", isDefault: true },
  { value: "high", label: "High" },
  { value: "xhigh", label: "XHigh" },
] as const;
export type PiThinkingLevel = (typeof DEFAULT_PI_REASONING_LEVELS)[number]["value"];
const PI_THINKING_LEVEL_VALUES = new Set<string>(
  DEFAULT_PI_REASONING_LEVELS.map((option) => option.value),
);

export function isPiThinkingLevel(value: string): value is PiThinkingLevel {
  return PI_THINKING_LEVEL_VALUES.has(value);
}

const createPiThinkingCapabilities = (
  levels: ReadonlyArray<(typeof DEFAULT_PI_REASONING_LEVELS)[number]>,
): ModelCapabilities =>
  createModelCapabilities({
    optionDescriptors: [
      buildSelectOptionDescriptor({
        id: "thinkingLevel",
        label: "Thinking",
        options: levels,
      }),
    ],
  });

const EMPTY_PI_MODEL_CAPABILITIES: ModelCapabilities = createModelCapabilities({
  optionDescriptors: [],
});
const DEFAULT_PI_CUSTOM_MODEL_CAPABILITIES: ModelCapabilities = createPiThinkingCapabilities(
  DEFAULT_PI_REASONING_LEVELS,
);
const FALLBACK_BUILT_IN_PI_PROVIDERS = [
  "amazon-bedrock",
  "anthropic",
  "azure-openai-responses",
  "cerebras",
  "fireworks",
  "github-copilot",
  "google",
  "google-antigravity",
  "google-gemini-cli",
  "google-vertex",
  "groq",
  "huggingface",
  "kimi-coding",
  "minimax",
  "minimax-cn",
  "mistral",
  "openai",
  "openai-codex",
  "opencode",
  "opencode-go",
  "openrouter",
  "vercel-ai-gateway",
  "xai",
  "zai",
] as const;
const BUILT_IN_PI_PROVIDERS = new Set<string>(FALLBACK_BUILT_IN_PI_PROVIDERS);
type BuiltInPiProvider = (typeof FALLBACK_BUILT_IN_PI_PROVIDERS)[number];

export interface PiResumeCursor {
  readonly schemaVersion: typeof PI_RESUME_CURSOR_VERSION;
  readonly agentDir: string;
  readonly sessionDir: string;
  readonly sessionFile: string;
}

export interface PiDiscoveredModel {
  readonly model: PiModel;
  readonly slug: string;
  readonly name: string;
  readonly capabilities: ModelCapabilities;
}

export interface PiInventory {
  readonly allModels: ReadonlyArray<PiDiscoveredModel>;
  readonly availableModels: ReadonlyArray<PiDiscoveredModel>;
}

export interface PiRuntimeHandle {
  readonly runtime: PiAgentSessionRuntime;
  readonly agentDir: string;
  readonly sessionDir: string;
  readonly authStorage: PiAuthStorage;
  readonly modelRegistry: PiModelRegistry;
  readonly settingsManager: PiSettingsManager;
}

export interface PiRuntimeShape {
  readonly runPiCommand: (input: {
    readonly binaryPath: string;
    readonly args: ReadonlyArray<string>;
  }) => Effect.Effect<CommandResult, PiRuntimeError, ChildProcessSpawner.ChildProcessSpawner>;
  readonly loadInventory: (input: {
    readonly agentDir: string;
    readonly sdkRoot?: string;
  }) => Effect.Effect<PiInventory, PiRuntimeError>;
  readonly createRuntime: (input: {
    readonly threadId: ThreadId;
    readonly cwd: string;
    readonly agentDir: string;
    readonly sessionDir: string;
    readonly sdkRoot?: string;
    readonly sessionFile?: string;
    readonly modelSlug?: string;
    readonly thinkingLevel?: PiThinkingLevel;
    readonly extensionFactories?: ReadonlyArray<PiExtensionFactory>;
  }) => Effect.Effect<PiRuntimeHandle, PiRuntimeError>;
}

const PI_RUNTIME_ERROR_TAG = "PiRuntimeError";
export class PiRuntimeError extends Data.TaggedError(PI_RUNTIME_ERROR_TAG)<{
  readonly operation: string;
  readonly detail: string;
  readonly cause?: unknown;
}> {
  static readonly is = (u: unknown): u is PiRuntimeError =>
    typeof u === "object" && u !== null && "_tag" in u && u._tag === PI_RUNTIME_ERROR_TAG;
}

export function piRuntimeErrorDetail(cause: unknown): string {
  if (PiRuntimeError.is(cause)) return cause.detail;
  if (cause instanceof Error && cause.message.trim().length > 0) return cause.message.trim();
  return String(cause);
}

export function parsePiModelSlug(slug: string | null | undefined): {
  readonly provider: string;
  readonly modelId: string;
} | null {
  if (typeof slug !== "string") {
    return null;
  }
  const trimmed = slug.trim();
  const separator = trimmed.indexOf("/");
  if (separator <= 0 || separator === trimmed.length - 1) {
    return null;
  }
  return {
    provider: trimmed.slice(0, separator),
    modelId: trimmed.slice(separator + 1),
  };
}

export function parsePiResumeCursor(raw: unknown): PiResumeCursor | undefined {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return undefined;
  }
  const candidate = raw as Record<string, unknown>;
  if (candidate.schemaVersion !== PI_RESUME_CURSOR_VERSION) {
    return undefined;
  }
  if (
    typeof candidate.agentDir !== "string" ||
    typeof candidate.sessionDir !== "string" ||
    typeof candidate.sessionFile !== "string"
  ) {
    return undefined;
  }
  const agentDir = candidate.agentDir.trim();
  const sessionDir = candidate.sessionDir.trim();
  const sessionFile = candidate.sessionFile.trim();
  if (agentDir.length === 0 || sessionDir.length === 0 || sessionFile.length === 0) {
    return undefined;
  }
  return {
    schemaVersion: PI_RESUME_CURSOR_VERSION,
    agentDir,
    sessionDir,
    sessionFile,
  };
}

function sanitizeThreadSegment(threadId: ThreadId): string {
  const normalized = threadId
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "");
  return normalized.length > 0 ? normalized : "thread";
}

export function resolvePiAgentDir(input: {
  readonly settings: PiSettings;
  readonly serverConfig: Pick<ServerConfigShape, "stateDir">;
}): string {
  const configured = input.settings.agentDir.trim();
  if (configured.length > 0) {
    return configured;
  }
  if (input.settings.useGlobalAgentDir) {
    return getDefaultPiAgentDir();
  }
  return nodePath.join(input.serverConfig.stateDir, "pi", "agent");
}

export function resolvePiSessionDir(input: {
  readonly agentDir: string;
  readonly threadId: ThreadId;
}): string {
  return nodePath.join(input.agentDir, PI_SESSION_DIR_ROOT, sanitizeThreadSegment(input.threadId));
}

export function createPiResumeCursor(input: {
  readonly agentDir: string;
  readonly sessionDir: string;
  readonly session: PiAgentSession;
}): PiResumeCursor | undefined {
  const sessionFile = input.session.sessionFile?.trim();
  if (!sessionFile) {
    return undefined;
  }
  return {
    schemaVersion: PI_RESUME_CURSOR_VERSION,
    agentDir: input.agentDir,
    sessionDir: input.sessionDir,
    sessionFile,
  };
}

export function piModelCapabilitiesForModel(
  model: PiModel,
  options?: {
    readonly supportsXhigh?: (model: PiModel) => boolean;
  },
): ModelCapabilities {
  if (!model.reasoning) {
    return EMPTY_PI_MODEL_CAPABILITIES;
  }
  const thinkingLevels = options?.supportsXhigh?.(model)
    ? DEFAULT_PI_REASONING_LEVELS
    : DEFAULT_PI_REASONING_LEVELS.filter((option) => option.value !== "xhigh");
  return createPiThinkingCapabilities(thinkingLevels);
}

export function defaultPiCustomModelCapabilities(): ModelCapabilities {
  return DEFAULT_PI_CUSTOM_MODEL_CAPABILITIES;
}

export function isBuiltInPiProvider(provider: string): provider is BuiltInPiProvider {
  return BUILT_IN_PI_PROVIDERS.has(provider);
}

export function filterSupportedPiCustomModels(
  customModels: ReadonlyArray<string>,
  options?: {
    readonly availableProviders?: ReadonlySet<string>;
  },
): ReadonlyArray<string> {
  const supportedModels: string[] = [];
  const seen = new Set<string>();
  for (const candidate of customModels) {
    const parsed = parsePiModelSlug(candidate);
    if (
      !parsed ||
      !isBuiltInPiProvider(parsed.provider) ||
      (options?.availableProviders !== undefined &&
        !options.availableProviders.has(parsed.provider))
    ) {
      continue;
    }
    const slug = `${parsed.provider}/${parsed.modelId}`;
    if (seen.has(slug)) {
      continue;
    }
    seen.add(slug);
    supportedModels.push(slug);
  }
  return supportedModels;
}

export function resolvePiModel(
  modelRegistry: Pick<PiModelRegistry, "find" | "getAvailable">,
  modelSlug: string | null | undefined,
  options?: {
    readonly builtInProviders?: ReadonlySet<string>;
    readonly getModels?: (provider: string) => ReadonlyArray<PiModel>;
  },
): PiModel | undefined {
  const parsed = parsePiModelSlug(modelSlug);
  if (!parsed) {
    return undefined;
  }

  const builtInProviders = options?.builtInProviders ?? BUILT_IN_PI_PROVIDERS;
  const availableModels = modelRegistry.getAvailable();
  const availableModel = availableModels.find(
    (model) => model.provider === parsed.provider && model.id === parsed.modelId,
  );
  if (availableModel) {
    return availableModel;
  }

  if (
    !builtInProviders.has(parsed.provider) ||
    !availableModels.some((model) => model.provider === parsed.provider)
  ) {
    return undefined;
  }

  const providerModels = options?.getModels?.(parsed.provider) ?? [];
  const template =
    providerModels.find((model) => model.id === parsed.modelId) ??
    availableModels.find((model) => model.provider === parsed.provider) ??
    providerModels[0];
  if (!template) {
    return undefined;
  }

  return {
    ...template,
    id: parsed.modelId,
    name: template.id === parsed.modelId ? template.name : `${parsed.provider}/${parsed.modelId}`,
  };
}

const toDiscoveredPiModel = (sdk: PiSdk, model: PiModel): PiDiscoveredModel => ({
  model,
  slug: `${model.provider}/${model.id}`,
  name: model.name?.trim().length ? model.name : `${model.provider}/${model.id}`,
  capabilities: piModelCapabilitiesForModel(model, { supportsXhigh: sdk.ai.supportsXhigh }),
});

function createPiRuntimeImpl(): PiRuntimeShape {
  const runPiCommand: PiRuntimeShape["runPiCommand"] = ({ binaryPath, args }) => {
    const command = ChildProcess.make(binaryPath, [...args], {
      shell: process.platform === "win32",
    });
    return spawnAndCollect(binaryPath, command).pipe(
      Effect.mapError(
        (cause) =>
          new PiRuntimeError({
            operation: "runPiCommand",
            detail: piRuntimeErrorDetail(cause),
            cause,
          }),
      ),
    );
  };

  const loadInventory: PiRuntimeShape["loadInventory"] = (input) =>
    Effect.gen(function* () {
      const sdk = yield* loadPiSdkEffect(
        input.sdkRoot ? { sdkRoot: input.sdkRoot } : undefined,
      ).pipe(
        Effect.mapError(
          (cause) =>
            new PiRuntimeError({
              operation: "loadInventory",
              detail: piRuntimeErrorDetail(cause),
              cause,
            }),
        ),
      );

      return yield* Effect.try({
        try: () => {
          const authStorage = sdk.codingAgent.AuthStorage.create(
            nodePath.join(input.agentDir, "auth.json"),
          );
          const modelRegistry = sdk.codingAgent.ModelRegistry.create(
            authStorage,
            nodePath.join(input.agentDir, "models.json"),
          );
          const allModels = modelRegistry.getAll().map((model) => toDiscoveredPiModel(sdk, model));
          const availableModels = modelRegistry
            .getAvailable()
            .map((model) => toDiscoveredPiModel(sdk, model));
          return {
            allModels,
            availableModels,
          } satisfies PiInventory;
        },
        catch: (cause) =>
          new PiRuntimeError({
            operation: "loadInventory",
            detail: piRuntimeErrorDetail(cause),
            cause,
          }),
      });
    });

  const createRuntime: PiRuntimeShape["createRuntime"] = (input) =>
    Effect.gen(function* () {
      const sdk = yield* loadPiSdkEffect(
        input.sdkRoot ? { sdkRoot: input.sdkRoot } : undefined,
      ).pipe(
        Effect.mapError(
          (cause) =>
            new PiRuntimeError({
              operation: "createRuntime",
              detail: piRuntimeErrorDetail(cause),
              cause,
            }),
        ),
      );

      return yield* Effect.tryPromise({
        try: async () => {
          const authStorage = sdk.codingAgent.AuthStorage.create(
            nodePath.join(input.agentDir, "auth.json"),
          );
          const modelRegistry = sdk.codingAgent.ModelRegistry.create(
            authStorage,
            nodePath.join(input.agentDir, "models.json"),
          );
          const settingsManager = sdk.codingAgent.SettingsManager.inMemory({
            compaction: { enabled: false },
          });

          const createRuntimeFactory: PiCreateAgentSessionRuntimeFactory = async ({
            cwd,
            agentDir,
            sessionManager,
            sessionStartEvent,
          }) => {
            const services = await sdk.codingAgent.createAgentSessionServices({
              cwd,
              agentDir,
              authStorage,
              modelRegistry,
              settingsManager,
              resourceLoaderOptions: {
                noExtensions: true,
                noSkills: true,
                noPromptTemplates: true,
                noThemes: true,
                extensionFactories: [...(input.extensionFactories ?? [])],
              },
            });
            const model = resolvePiModel(services.modelRegistry, input.modelSlug, {
              builtInProviders: new Set(sdk.ai.getProviders()),
              getModels: (provider) =>
                sdk.ai.getModels(provider as Parameters<typeof sdk.ai.getModels>[0]),
            });

            return {
              ...(await sdk.codingAgent.createAgentSessionFromServices({
                services,
                sessionManager,
                ...(sessionStartEvent ? { sessionStartEvent } : {}),
                ...(model ? { model } : {}),
                ...(input.thinkingLevel ? { thinkingLevel: input.thinkingLevel } : {}),
                tools: ["read", "ls", "find", "grep", "bash", "edit", "write"],
              })),
              services,
              diagnostics: services.diagnostics,
            };
          };

          const sessionManager = input.sessionFile
            ? sdk.codingAgent.SessionManager.open(input.sessionFile, input.sessionDir, input.cwd)
            : sdk.codingAgent.SessionManager.create(input.cwd, input.sessionDir);

          const runtime = await sdk.codingAgent.createAgentSessionRuntime(createRuntimeFactory, {
            cwd: input.cwd,
            agentDir: input.agentDir,
            sessionManager,
          });

          return {
            runtime,
            agentDir: input.agentDir,
            sessionDir: input.sessionDir,
            authStorage,
            modelRegistry,
            settingsManager,
          } satisfies PiRuntimeHandle;
        },
        catch: (cause) =>
          new PiRuntimeError({
            operation: "createRuntime",
            detail: piRuntimeErrorDetail(cause),
            cause,
          }),
      });
    });

  return {
    runPiCommand,
    loadInventory,
    createRuntime,
  };
}

export class PiRuntime extends Context.Service<PiRuntime, PiRuntimeShape>()(
  "t3/provider/PiRuntime",
) {}

export const PiRuntimeLive = Layer.succeed(PiRuntime, createPiRuntimeImpl());

export function parsePiVersion(output: string): string | null {
  return parseGenericCliVersion(output);
}
