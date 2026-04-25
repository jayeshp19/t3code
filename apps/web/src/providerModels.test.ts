import { describe, expect, it } from "vitest";
import type { ServerProvider } from "@t3tools/contracts";

import { shouldOfferPiGlobalAgentDirShortcut } from "./providerModels";

function makeProvider(overrides: Partial<ServerProvider> = {}): ServerProvider {
  return {
    provider: "pi",
    enabled: true,
    installed: true,
    version: "1.2.3",
    status: "warning",
    auth: {
      status: "unauthenticated",
      type: "pi",
      label: "isolated agent dir",
    },
    checkedAt: "2026-04-22T00:00:00.000Z",
    message:
      'No authenticated Pi models are available in T3 Code\'s isolated Pi agent directory. 1 model is available in the global Pi agent directory. Enable "Use global Pi agent directory" or set the Pi agent directory to `/Users/jayesh/.pi/agent`.',
    models: [],
    slashCommands: [],
    skills: [],
    ...overrides,
  };
}

describe("shouldOfferPiGlobalAgentDirShortcut", () => {
  it("returns true for isolated unauthenticated Pi warnings without an override dir", () => {
    expect(
      shouldOfferPiGlobalAgentDirShortcut({
        provider: makeProvider(),
        agentDir: "",
        useGlobalAgentDir: false,
      }),
    ).toBe(true);
  });

  it("returns false when a custom Pi agent directory override is set", () => {
    expect(
      shouldOfferPiGlobalAgentDirShortcut({
        provider: makeProvider(),
        agentDir: "/tmp/custom-pi-agent",
        useGlobalAgentDir: false,
      }),
    ).toBe(false);
  });

  it("returns false when Pi is already pointed at the global agent directory", () => {
    expect(
      shouldOfferPiGlobalAgentDirShortcut({
        provider: makeProvider(),
        agentDir: "",
        useGlobalAgentDir: true,
      }),
    ).toBe(false);
  });
});
