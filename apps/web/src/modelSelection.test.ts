import { describe, expect, it } from "vitest";
import { DEFAULT_UNIFIED_SETTINGS } from "@t3tools/contracts/settings";
import type { ServerProvider } from "@t3tools/contracts";
import { createModelCapabilities } from "@t3tools/shared/model";

import { getCustomModelOptionsByProvider } from "./modelSelection";

const EMPTY_CAPABILITIES = createModelCapabilities({ optionDescriptors: [] });

const TEST_PROVIDERS: ReadonlyArray<ServerProvider> = [
  {
    provider: "codex",
    enabled: true,
    installed: true,
    version: "0.116.0",
    status: "ready",
    auth: { status: "authenticated" },
    checkedAt: "2026-04-23T00:00:00.000Z",
    models: [
      {
        slug: "gpt-5.4",
        name: "GPT-5.4",
        isCustom: false,
        capabilities: EMPTY_CAPABILITIES,
      },
    ],
    slashCommands: [],
    skills: [],
  },
  {
    provider: "pi",
    enabled: true,
    installed: true,
    version: "1.2.3",
    status: "ready",
    auth: { status: "authenticated", type: "pi", label: "global agent dir" },
    checkedAt: "2026-04-23T00:00:00.000Z",
    models: [
      {
        slug: "openai/gpt-5",
        name: "GPT-5",
        subProvider: "openai",
        isCustom: false,
        capabilities: EMPTY_CAPABILITIES,
      },
    ],
    slashCommands: [],
    skills: [],
  },
];

describe("getCustomModelOptionsByProvider", () => {
  it("returns empty model lists for providers outside the allowed set", () => {
    const options = getCustomModelOptionsByProvider(
      {
        ...DEFAULT_UNIFIED_SETTINGS,
        providers: {
          ...DEFAULT_UNIFIED_SETTINGS.providers,
          pi: {
            ...DEFAULT_UNIFIED_SETTINGS.providers.pi,
            customModels: ["anthropic/custom-claude"],
          },
        },
      },
      TEST_PROVIDERS,
      "codex",
      "gpt-5.4",
      ["codex"],
    );

    expect(options.codex.map((model) => model.slug)).toEqual(["gpt-5.4"]);
    expect(options.pi).toEqual([]);
  });
});
