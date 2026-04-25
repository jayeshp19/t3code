import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import * as nodeOs from "node:os";
import * as nodePath from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { getDefaultPiAgentDir, loadPiSdk, PI_SDK_ROOT_ENV } from "./piSdk.ts";

const ORIGINAL_PI_SDK_ROOT = process.env[PI_SDK_ROOT_ENV];
const ORIGINAL_PI_AGENT_DIR = process.env.PI_CODING_AGENT_DIR;

afterEach(() => {
  if (ORIGINAL_PI_SDK_ROOT === undefined) {
    delete process.env[PI_SDK_ROOT_ENV];
  } else {
    process.env[PI_SDK_ROOT_ENV] = ORIGINAL_PI_SDK_ROOT;
  }
  if (ORIGINAL_PI_AGENT_DIR === undefined) {
    delete process.env.PI_CODING_AGENT_DIR;
  } else {
    process.env.PI_CODING_AGENT_DIR = ORIGINAL_PI_AGENT_DIR;
  }
});

async function writeMockPackage(input: {
  readonly root: string;
  readonly packageName: string;
  readonly version: string;
  readonly source: string;
}): Promise<void> {
  const packageDir = nodePath.join(input.root, "node_modules", ...input.packageName.split("/"));
  const distDir = nodePath.join(packageDir, "dist");
  await mkdir(distDir, { recursive: true });
  await writeFile(
    nodePath.join(packageDir, "package.json"),
    `${JSON.stringify({
      name: input.packageName,
      version: input.version,
      type: "module",
      exports: {
        ".": {
          import: "./dist/index.js",
        },
      },
    })}\n`,
    "utf8",
  );
  await writeFile(nodePath.join(distDir, "index.js"), input.source, "utf8");
}

async function writeMockPiSdk(root: string): Promise<void> {
  await writeMockPackage({
    root,
    packageName: "@mariozechner/pi-ai",
    version: "9.8.7",
    source: `
export const Type = {
  String: (options) => ({ kind: "string", options }),
  Optional: (value) => ({ kind: "optional", value }),
  Array: (value, options) => ({ kind: "array", value, options }),
  Object: (properties) => ({ kind: "object", properties }),
};
export function getProviders() {
  return ["mock-provider"];
}
export function getModels(provider) {
  return [{ provider, id: "mock-model", name: "Mock Model", reasoning: false }];
}
export function supportsXhigh() {
  return false;
}
`,
  });
  await writeMockPackage({
    root,
    packageName: "@mariozechner/pi-coding-agent",
    version: "9.8.6",
    source: `
export const VERSION = "9.8.6";
export const AuthStorage = {};
export const ModelRegistry = {};
export const SessionManager = {};
export const SettingsManager = {};
export async function createAgentSessionFromServices() {}
export async function createAgentSessionRuntime() {}
export async function createAgentSessionServices() {}
export function defineTool(definition) {
  return definition;
}
export function isToolCallEventType() {
  return false;
}
`,
  });
}

describe("piSdk", () => {
  it("loads Pi SDK modules from an external root", async () => {
    const root = await mkdtemp(nodePath.join(nodeOs.tmpdir(), "t3-pi-sdk-root-"));
    await writeMockPiSdk(root);

    const sdk = await loadPiSdk({ sdkRoot: root });

    expect(sdk.source).toMatchObject({
      kind: "external",
      root,
      piAiVersion: "9.8.7",
      piCodingAgentVersion: "9.8.6",
    });
    expect(sdk.ai.getProviders()).toEqual(["mock-provider"]);
    expect(typeof sdk.codingAgent.defineTool).toBe("function");
  });

  it("does not cache failed external root loads", async () => {
    const root = await mkdtemp(nodePath.join(nodeOs.tmpdir(), "t3-pi-sdk-retry-"));

    await expect(loadPiSdk({ sdkRoot: root })).rejects.toThrow();

    await writeMockPiSdk(root);
    await expect(loadPiSdk({ sdkRoot: root })).resolves.toMatchObject({
      source: {
        kind: "external",
        root,
      },
    });
  });

  it("resolves Pi's global agent directory without importing the SDK", () => {
    process.env.PI_CODING_AGENT_DIR = "~/custom-pi-agent";

    expect(getDefaultPiAgentDir()).toBe(nodePath.join(nodeOs.homedir(), "custom-pi-agent"));
  });
});
