import type { Model } from "@mariozechner/pi-ai";
import { describe, expect, it } from "vitest";

import { filterSupportedPiCustomModels, resolvePiModel } from "./piRuntime.ts";

function makeAvailableModel(provider: string, id: string, name: string): Model<any> {
  return {
    provider,
    id,
    name,
    api: "openai",
    baseUrl: "https://api.example.com/v1",
    reasoning: true,
    input: ["text"],
    cost: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
    },
    contextWindow: 128_000,
    maxTokens: 16_384,
  } as Model<any>;
}

describe("piRuntime", () => {
  it("keeps only built-in-provider custom model slugs from settings", () => {
    expect(
      filterSupportedPiCustomModels([
        "openai/custom-model",
        "anthropic/custom-claude",
        "invalid",
        "custom-provider/demo",
        "openai/custom-model",
      ]),
    ).toEqual(["openai/custom-model", "anthropic/custom-claude"]);
  });

  it("keeps only custom models whose providers are currently available", () => {
    expect(
      filterSupportedPiCustomModels(["openai/custom-model", "anthropic/custom-claude"], {
        availableProviders: new Set(["openai"]),
      }),
    ).toEqual(["openai/custom-model"]);
  });

  it("synthesizes built-in-provider custom models when that provider is available", () => {
    const model = resolvePiModel(
      {
        find: () => undefined,
        getAvailable: () => [makeAvailableModel("openai", "gpt-5", "GPT-5")],
      },
      "openai/custom-model",
    );

    expect(model).toMatchObject({
      provider: "openai",
      id: "custom-model",
      name: "openai/custom-model",
    });
  });

  it("rejects built-in-provider custom models when that provider is unavailable", () => {
    const model = resolvePiModel(
      {
        find: () => undefined,
        getAvailable: () => [],
      },
      "anthropic/custom-claude",
    );

    expect(model).toBeUndefined();
  });
});
