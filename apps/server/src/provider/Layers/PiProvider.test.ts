import assert from "node:assert/strict";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { it } from "@effect/vitest";
import { DEFAULT_SERVER_SETTINGS } from "@t3tools/contracts";
import { createModelCapabilities } from "@t3tools/shared/model";
import type { Model } from "@mariozechner/pi-ai";
import { Effect, Layer } from "effect";

import { ServerConfig } from "../../config.ts";
import { ServerSettingsService } from "../../serverSettings.ts";
import { PiProvider } from "../Services/PiProvider.ts";
import {
  PiRuntime,
  resolvePiAgentDir,
  type PiDiscoveredModel,
  type PiRuntimeShape,
} from "../piRuntime.ts";
import { PiProviderLive } from "./PiProvider.ts";

function makeModel(provider: string, id: string, name: string): Model<any> {
  return {
    provider,
    id,
    name,
    reasoning: true,
    input: ["text"],
    cost: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
    },
    contextWindow: 1_000_000,
    maxTokens: 16_000,
  } as Model<any>;
}

function makeDiscoveredModel(provider: string, id: string, name: string): PiDiscoveredModel {
  return {
    model: makeModel(provider, id, name),
    slug: `${provider}/${id}`,
    name,
    capabilities: createModelCapabilities({ optionDescriptors: [] }),
  };
}

const PiProviderTestRuntime = Layer.effect(
  PiRuntime,
  Effect.gen(function* () {
    const serverConfig = yield* ServerConfig;
    const globalAgentDir = resolvePiAgentDir({
      settings: {
        ...DEFAULT_SERVER_SETTINGS.providers.pi,
        agentDir: "",
        useGlobalAgentDir: true,
      },
      serverConfig,
    });
    const globalModels = [makeDiscoveredModel("openai-codex", "gpt-5", "GPT-5")];

    return {
      runPiCommand: () =>
        Effect.succeed({
          stdout: "pi 1.2.3\n",
          stderr: "",
          code: 0,
        }),
      loadInventory: ({ agentDir }) =>
        Effect.succeed({
          allModels: agentDir === globalAgentDir ? globalModels : [],
          availableModels: agentDir === globalAgentDir ? globalModels : [],
        }),
      createRuntime: () =>
        Effect.die(new Error("PiProviderTestRuntime.createRuntime should not be called")),
    } satisfies PiRuntimeShape;
  }),
);

const PiProviderServerConfigLayer = ServerConfig.layerTest(process.cwd(), {
  prefix: "t3-pi-provider-test-",
});

const PiProviderTestLayer = PiProviderLive.pipe(
  Layer.provideMerge(
    ServerSettingsService.layerTest({
      providers: {
        pi: {
          ...DEFAULT_SERVER_SETTINGS.providers.pi,
          enabled: true,
          agentDir: "",
          useGlobalAgentDir: false,
        },
      },
    }),
  ),
  Layer.provideMerge(PiProviderServerConfigLayer),
  Layer.provideMerge(PiProviderTestRuntime.pipe(Layer.provide(PiProviderServerConfigLayer))),
  Layer.provideMerge(NodeServices.layer),
);

it.layer(PiProviderTestLayer)("PiProviderLive", (it) => {
  it.effect(
    "explains isolated Pi auth issues and points to the global agent directory when it has models",
    () =>
      Effect.gen(function* () {
        const provider = yield* PiProvider;
        const snapshot = yield* provider.refresh;

        assert.equal(snapshot.provider, "pi");
        assert.equal(snapshot.status, "warning");
        assert.equal(snapshot.auth.status, "unauthenticated");
        assert.equal(snapshot.auth.label, "isolated agent dir");
        assert.match(
          snapshot.message ?? "",
          /^No authenticated Pi models are available in T3 Code's isolated Pi agent directory\. 1 model is available in the global Pi agent directory\. Enable "Use global Pi agent directory" or set the Pi agent directory to `.+`\.$/,
        );
      }),
  );
});
