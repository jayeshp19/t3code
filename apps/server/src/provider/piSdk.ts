import { promises as nodeFs } from "node:fs";
import * as nodeOs from "node:os";
import * as nodePath from "node:path";
import { pathToFileURL } from "node:url";

import { Data, Effect } from "effect";

export const PI_SDK_ROOT_ENV = "T3_PI_SDK_ROOT";
const PI_AGENT_DIR_ENV = "PI_CODING_AGENT_DIR";

export type PiAgentSession = import("@mariozechner/pi-coding-agent").AgentSession;
export type PiAgentSessionEvent = import("@mariozechner/pi-coding-agent").AgentSessionEvent;
export type PiAgentSessionRuntime = import("@mariozechner/pi-coding-agent").AgentSessionRuntime;
export type PiAuthStorage = import("@mariozechner/pi-coding-agent").AuthStorage;
export type PiCreateAgentSessionRuntimeFactory =
  import("@mariozechner/pi-coding-agent").CreateAgentSessionRuntimeFactory;
export type PiExtensionFactory = import("@mariozechner/pi-coding-agent").ExtensionFactory;
export type PiExtensionUIContext = import("@mariozechner/pi-coding-agent").ExtensionUIContext;
export type PiModelRegistry = import("@mariozechner/pi-coding-agent").ModelRegistry;
export type PiSettingsManager = import("@mariozechner/pi-coding-agent").SettingsManager;
export type PiToolCallEvent = import("@mariozechner/pi-coding-agent").ToolCallEvent;
export type PiToolCallEventResult = import("@mariozechner/pi-coding-agent").ToolCallEventResult;
export type PiToolDefinition = import("@mariozechner/pi-coding-agent").ToolDefinition;
export type PiImageContent = import("@mariozechner/pi-ai").ImageContent;
export type PiModel = import("@mariozechner/pi-ai").Model<any>;

type PiCodingAgentModule = Pick<
  typeof import("@mariozechner/pi-coding-agent"),
  | "AuthStorage"
  | "ModelRegistry"
  | "SessionManager"
  | "SettingsManager"
  | "createAgentSessionFromServices"
  | "createAgentSessionRuntime"
  | "createAgentSessionServices"
  | "defineTool"
  | "isToolCallEventType"
> & {
  readonly VERSION?: string;
  readonly getAgentDir?: () => string;
};

type PiAiModule = Pick<
  typeof import("@mariozechner/pi-ai"),
  "Type" | "getModels" | "getProviders" | "supportsXhigh"
>;

export interface PiSdkSource {
  readonly kind: "bundled" | "external";
  readonly root?: string;
  readonly piAiVersion?: string;
  readonly piCodingAgentVersion?: string;
}

export interface PiSdk {
  readonly codingAgent: PiCodingAgentModule;
  readonly ai: PiAiModule;
  readonly source: PiSdkSource;
}

export class PiSdkLoadError extends Data.TaggedError("PiSdkLoadError")<{
  readonly detail: string;
  readonly sdkRoot?: string;
  readonly cause?: unknown;
}> {}

const sdkCache = new Map<string, Promise<PiSdk>>();

function expandTilde(pathValue: string): string {
  if (pathValue === "~") {
    return nodeOs.homedir();
  }
  if (pathValue.startsWith("~/")) {
    return nodePath.join(nodeOs.homedir(), pathValue.slice(2));
  }
  return pathValue;
}

function normalizeOptionalPath(pathValue: string | undefined): string | undefined {
  const trimmed = pathValue?.trim();
  if (!trimmed) {
    return undefined;
  }
  return nodePath.resolve(expandTilde(trimmed));
}

export function resolveConfiguredPiSdkRoot(): string | undefined {
  return normalizeOptionalPath(process.env[PI_SDK_ROOT_ENV]);
}

export function getDefaultPiAgentDir(): string {
  const configured = process.env[PI_AGENT_DIR_ENV];
  if (configured?.trim()) {
    return nodePath.resolve(expandTilde(configured.trim()));
  }
  return nodePath.join(nodeOs.homedir(), ".pi", "agent");
}

async function readPackageJson(
  root: string,
  packageName: string,
): Promise<{
  readonly packageDir: string;
  readonly version?: string;
  readonly importPath: string;
}> {
  const packageDir = nodePath.join(root, "node_modules", ...packageName.split("/"));
  const packageJsonPath = nodePath.join(packageDir, "package.json");
  const raw = await nodeFs.readFile(packageJsonPath, "utf8");
  const parsed = JSON.parse(raw) as {
    readonly version?: unknown;
    readonly exports?: unknown;
    readonly module?: unknown;
    readonly main?: unknown;
  };
  const exportRoot =
    parsed.exports && typeof parsed.exports === "object"
      ? (parsed.exports as Record<string, unknown>)["."]
      : undefined;
  const exportImport =
    exportRoot && typeof exportRoot === "object"
      ? (exportRoot as Record<string, unknown>).import
      : undefined;
  const importPath =
    (typeof exportImport === "string" && exportImport) ||
    (typeof parsed.module === "string" && parsed.module) ||
    (typeof parsed.main === "string" && parsed.main);

  if (!importPath) {
    throw new Error(`${packageName} does not expose an importable entry point.`);
  }

  return {
    packageDir,
    ...(typeof parsed.version === "string" ? { version: parsed.version } : {}),
    importPath,
  };
}

async function importExternalPackage(
  root: string,
  packageName: string,
): Promise<{
  readonly module: unknown;
  readonly version?: string;
}> {
  const packageJson = await readPackageJson(root, packageName);
  const entryPath = nodePath.resolve(packageJson.packageDir, packageJson.importPath);
  return {
    module: await import(pathToFileURL(entryPath).href),
    ...(packageJson.version ? { version: packageJson.version } : {}),
  };
}

async function loadBundledPiSdk(): Promise<PiSdk> {
  const [codingAgent, ai] = await Promise.all([
    import("@mariozechner/pi-coding-agent"),
    import("@mariozechner/pi-ai"),
  ]);
  return {
    codingAgent,
    ai,
    source: { kind: "bundled" },
  };
}

async function loadExternalPiSdk(root: string): Promise<PiSdk> {
  const [codingAgent, ai] = await Promise.all([
    importExternalPackage(root, "@mariozechner/pi-coding-agent"),
    importExternalPackage(root, "@mariozechner/pi-ai"),
  ]);
  return {
    codingAgent: codingAgent.module as PiCodingAgentModule,
    ai: ai.module as PiAiModule,
    source: {
      kind: "external",
      root,
      ...(ai.version ? { piAiVersion: ai.version } : {}),
      ...(codingAgent.version ? { piCodingAgentVersion: codingAgent.version } : {}),
    },
  };
}

export function loadPiSdk(options?: { readonly sdkRoot?: string }): Promise<PiSdk> {
  const sdkRoot = normalizeOptionalPath(options?.sdkRoot) ?? resolveConfiguredPiSdkRoot();
  const cacheKey = sdkRoot ? `external:${sdkRoot}` : "bundled";
  const cached = sdkCache.get(cacheKey);
  if (cached) {
    return cached;
  }

  const next = (sdkRoot ? loadExternalPiSdk(sdkRoot) : loadBundledPiSdk()).catch((cause) => {
    sdkCache.delete(cacheKey);
    throw cause;
  });
  sdkCache.set(cacheKey, next);
  return next;
}

export const loadPiSdkEffect = (options?: {
  readonly sdkRoot?: string;
}): Effect.Effect<PiSdk, PiSdkLoadError> =>
  Effect.tryPromise({
    try: () => loadPiSdk(options),
    catch: (cause) =>
      new PiSdkLoadError({
        detail: cause instanceof Error ? cause.message : String(cause),
        ...(options?.sdkRoot ? { sdkRoot: options.sdkRoot } : {}),
        cause,
      }),
  });
