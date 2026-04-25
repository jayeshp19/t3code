import assert from "node:assert/strict";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { it } from "@effect/vitest";
import { ApprovalRequestId, type ProviderRuntimeEvent, ThreadId } from "@t3tools/contracts";
import type {
  AgentSessionEvent,
  ExtensionAPI,
  ExtensionFactory,
  ExtensionUIContext,
  ToolCallEvent,
  ToolCallEventResult,
  ToolDefinition,
} from "@mariozechner/pi-coding-agent";
import type { Model } from "@mariozechner/pi-ai";
import { Effect, Layer, Stream } from "effect";
import { beforeEach } from "vitest";

import { ServerConfig } from "../../config.ts";
import { ServerSettingsService } from "../../serverSettings.ts";
import { PiAdapter } from "../Services/PiAdapter.ts";
import { PiRuntime, type PiRuntimeShape } from "../piRuntime.ts";
import { makePiAdapterLive } from "./PiAdapter.ts";

const PI_USER_INPUT_TOOL_NAME = "t3_ask_user";

const asThreadId = (value: string): ThreadId => ThreadId.make(value);
type PiAssistantMessage = Extract<
  Extract<AgentSessionEvent, { type: "message_start" | "message_update" | "message_end" }>,
  { message: unknown }
>["message"];

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

function assistantMessage(text: string): PiAssistantMessage {
  return {
    role: "assistant",
    content: [{ type: "text", text }],
  } as PiAssistantMessage;
}

type PersistedEntry = {
  readonly type: "custom";
  readonly id: string;
  readonly customType: string;
  readonly data: unknown;
};

class FakeSessionManager {
  private readonly entries: Array<PersistedEntry>;
  private nextEntryIndex: number;

  constructor(entries: ReadonlyArray<PersistedEntry> = []) {
    this.entries = [...entries];
    this.nextEntryIndex = entries.length;
  }

  getEntries(): ReadonlyArray<PersistedEntry> {
    return [...this.entries];
  }

  appendCustomEntry(customType: string, data: unknown): string {
    const id = `pi-entry-${++this.nextEntryIndex}`;
    this.entries.push({
      type: "custom",
      id,
      customType,
      data,
    });
    return id;
  }

  cloneThrough(entryId: string): FakeSessionManager {
    const index = this.entries.findIndex((entry) => entry.id === entryId);
    const retainedEntries = index >= 0 ? this.entries.slice(0, index + 1) : [];
    return new FakeSessionManager(retainedEntries);
  }
}

type PromptPlan = (input: {
  readonly session: FakePiSession;
  readonly runtime: FakePiRuntimeInstance;
  readonly text: string;
  readonly options:
    | {
        readonly preflightResult?: ((success: boolean) => void) | undefined;
      }
    | undefined;
}) => Promise<void>;

class FakePiExtensionHarness {
  readonly registeredTools: Array<ToolDefinition> = [];
  readonly toolCallHandlers: Array<
    (
      event: ToolCallEvent,
    ) => Promise<ToolCallEventResult | undefined> | ToolCallEventResult | undefined
  > = [];

  readonly api = {
    on: (event: string, handler: unknown) => {
      if (event === "tool_call") {
        this.toolCallHandlers.push(
          handler as (
            event: ToolCallEvent,
          ) => Promise<ToolCallEventResult | undefined> | ToolCallEventResult | undefined,
        );
      }
    },
    registerTool: (tool: ToolDefinition) => {
      this.registeredTools.push(tool);
    },
  } as unknown as ExtensionAPI;
}

class FakePiSession {
  readonly listeners = new Set<(event: AgentSessionEvent) => void>();
  readonly owner: FakePiRuntimeInstance;
  readonly sessionManager: FakeSessionManager;
  readonly sessionId: string;
  readonly sessionFile: string;
  uiContext: ExtensionUIContext | undefined;
  model: Model<any> | undefined;
  thinkingLevel: "off" | "minimal" | "low" | "medium" | "high" | "xhigh";

  constructor(
    owner: FakePiRuntimeInstance,
    sessionManager: FakeSessionManager,
    sessionId: string,
    sessionFile: string,
    model: Model<any> | undefined,
    thinkingLevel: FakePiSession["thinkingLevel"],
  ) {
    this.owner = owner;
    this.sessionManager = sessionManager;
    this.sessionId = sessionId;
    this.sessionFile = sessionFile;
    this.model = model;
    this.thinkingLevel = thinkingLevel;
  }

  subscribe(listener: (event: AgentSessionEvent) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  emit(event: AgentSessionEvent): void {
    for (const listener of this.listeners) {
      listener(event);
    }
  }

  async bindExtensions(bindings: {
    readonly uiContext?: ExtensionUIContext | undefined;
  }): Promise<void> {
    this.uiContext = bindings.uiContext;
  }

  async prompt(
    text: string,
    options?: {
      readonly preflightResult?: ((success: boolean) => void) | undefined;
    },
  ): Promise<void> {
    const plan = this.owner.promptPlans.shift() ?? this.owner.defaultPromptPlan;
    await plan({
      session: this,
      runtime: this.owner,
      text,
      options,
    });
  }

  async abort(): Promise<void> {
    this.owner.abortCalls += 1;
  }

  async setModel(model: Model<any>): Promise<void> {
    this.model = model;
  }

  setThinkingLevel(level: FakePiSession["thinkingLevel"]): void {
    this.thinkingLevel = level;
  }
}

class FakePiRuntimeInstance {
  readonly promptPlans: Array<PromptPlan> = [];
  readonly extensionHarness = new FakePiExtensionHarness();
  readonly threadId: ThreadId;
  readonly agentDir: string;
  readonly sessionDir: string;
  readonly modelRegistry: {
    readonly find: (provider: string, modelId: string) => Model<any> | undefined;
    readonly getAvailable: () => ReadonlyArray<Model<any>>;
  };
  readonly runtime: {
    readonly session: FakePiSession;
    readonly dispose: () => Promise<void>;
    readonly fork: (leafEntryId: string, options: { readonly position: "at" }) => Promise<void>;
    readonly newSession: () => Promise<void>;
  };

  abortCalls = 0;
  disposeCalls = 0;
  forkCalls: Array<{ readonly leafEntryId: string; readonly position: "at" }> = [];
  newSessionCalls = 0;

  private currentSession: FakePiSession;
  private nextSessionIndex = 1;
  private readonly models: Map<string, Model<any>>;

  constructor(
    threadId: ThreadId,
    agentDir: string,
    sessionDir: string,
    modelSlug: string | undefined,
    thinkingLevel: "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | undefined,
  ) {
    this.threadId = threadId;
    this.agentDir = agentDir;
    this.sessionDir = sessionDir;
    this.models = new Map(
      [makeModel("openai", "gpt-5", "GPT-5"), makeModel("openai", "gpt-5-mini", "GPT-5 Mini")].map(
        (model) => [`${model.provider}/${model.id}`, model],
      ),
    );
    this.modelRegistry = {
      find: (provider, modelId) => this.models.get(`${provider}/${modelId}`),
      getAvailable: () => [...this.models.values()],
    };
    const initialModel = modelSlug ? this.models.get(modelSlug) : undefined;
    this.currentSession = this.createSession({
      ...(initialModel ? { model: initialModel } : {}),
      thinkingLevel: thinkingLevel ?? "medium",
    });
    const runtime = {
      dispose: async () => {
        this.disposeCalls += 1;
      },
      fork: async (
        leafEntryId: string,
        options: {
          readonly position: "at";
        },
      ) => {
        this.forkCalls.push({ leafEntryId, position: options.position });
        this.currentSession = this.createSession({
          entries: this.currentSession.sessionManager.cloneThrough(leafEntryId),
          ...(this.currentSession.model ? { model: this.currentSession.model } : {}),
          thinkingLevel: this.currentSession.thinkingLevel,
        });
      },
      newSession: async () => {
        this.newSessionCalls += 1;
        this.currentSession = this.createSession({
          ...(this.currentSession.model ? { model: this.currentSession.model } : {}),
          thinkingLevel: this.currentSession.thinkingLevel,
        });
      },
    };
    Object.defineProperty(runtime, "session", {
      enumerable: true,
      get: () => this.currentSession,
    });
    this.runtime = runtime as FakePiRuntimeInstance["runtime"];
  }

  readonly defaultPromptPlan: PromptPlan = async ({ options, session, text }) => {
    options?.preflightResult?.(true);
    emitAssistantTurn(session, `Echo: ${text}`);
  };

  queuePromptPlan(plan: PromptPlan): void {
    this.promptPlans.push(plan);
  }

  async initialize(extensionFactories: ReadonlyArray<ExtensionFactory> | undefined): Promise<void> {
    for (const extensionFactory of extensionFactories ?? []) {
      await extensionFactory(this.extensionHarness.api);
    }
  }

  async dispatchToolCall(event: ToolCallEvent): Promise<ToolCallEventResult | undefined> {
    let result: ToolCallEventResult | undefined;
    for (const handler of this.extensionHarness.toolCallHandlers) {
      const nextResult = await handler(event);
      if (nextResult !== undefined) {
        result = nextResult;
      }
    }
    return result;
  }

  async executeAskUserTool(params: {
    readonly question: string;
    readonly options?: ReadonlyArray<string>;
    readonly placeholder?: string;
  }): Promise<string | undefined> {
    const tool = this.extensionHarness.registeredTools.find(
      (candidate) => candidate.name === PI_USER_INPUT_TOOL_NAME,
    );
    assert.ok(tool, "expected the Pi adapter to register the ask-user tool");
    assert.ok(
      this.currentSession.uiContext,
      "expected the Pi adapter to bind an ExtensionUIContext",
    );

    const result = await tool.execute("tool-ask-user-1", params as never, undefined, undefined, {
      hasUI: true,
      ui: this.currentSession.uiContext,
      cwd: "/tmp/project",
      sessionManager: this.currentSession.sessionManager as never,
      modelRegistry: this.modelRegistry as never,
      model: this.currentSession.model,
      isIdle: () => false,
      signal: undefined,
      abort() {},
      hasPendingMessages: () => false,
      shutdown() {},
    } as never);

    const answer = result.content.find(
      (part): part is { readonly type: "text"; readonly text: string } =>
        typeof part === "object" &&
        part !== null &&
        "type" in part &&
        part.type === "text" &&
        "text" in part &&
        typeof part.text === "string",
    );
    return answer?.text;
  }

  private createSession(input: {
    readonly entries?: FakeSessionManager;
    readonly model?: Model<any>;
    readonly thinkingLevel: FakePiSession["thinkingLevel"];
  }): FakePiSession {
    const sessionIndex = this.nextSessionIndex++;
    return new FakePiSession(
      this,
      input.entries ?? new FakeSessionManager(),
      `pi-session-${this.threadId}-${sessionIndex}`,
      `${this.sessionDir}/session-${sessionIndex}.jsonl`,
      input.model,
      input.thinkingLevel,
    );
  }
}

const runtimeMock = {
  instances: new Map<ThreadId, FakePiRuntimeInstance>(),
  createRuntimeCalls: [] as Array<{
    readonly threadId: ThreadId;
    readonly cwd: string;
    readonly agentDir: string;
    readonly sessionDir: string;
    readonly sessionFile?: string;
    readonly modelSlug?: string;
    readonly thinkingLevel?: string;
  }>,
  reset() {
    this.instances.clear();
    this.createRuntimeCalls.length = 0;
  },
  get(threadId: ThreadId): FakePiRuntimeInstance {
    const instance = this.instances.get(threadId);
    assert.ok(instance, `expected a runtime instance for ${threadId}`);
    return instance;
  },
};

function emitAssistantTurn(
  session: FakePiSession,
  text: string,
  options?: {
    readonly reasoningDelta?: string;
    readonly stopReason?: "stop" | "length" | "toolUse";
  },
): void {
  const message = assistantMessage(text);
  session.emit({
    type: "message_start",
    message,
  });
  session.emit({
    type: "message_update",
    message,
    assistantMessageEvent: {
      type: "text_delta",
      contentIndex: 0,
      delta: text,
      partial: message as never,
    },
  });
  if (options?.reasoningDelta) {
    session.emit({
      type: "message_update",
      message,
      assistantMessageEvent: {
        type: "thinking_delta",
        contentIndex: 1,
        delta: options.reasoningDelta,
        partial: message as never,
      },
    });
  }
  session.emit({
    type: "message_update",
    message,
    assistantMessageEvent: {
      type: "done",
      reason: options?.stopReason ?? "stop",
      message: message as never,
    },
  });
  session.emit({
    type: "message_end",
    message,
  });
}

const PiRuntimeTestDouble: PiRuntimeShape = {
  runPiCommand: () =>
    Effect.die(new Error("PiRuntimeTestDouble.runPiCommand is not used in PiAdapter tests")),
  loadInventory: () =>
    Effect.die(new Error("PiRuntimeTestDouble.loadInventory is not used in PiAdapter tests")),
  createRuntime: (input) =>
    Effect.promise(async () => {
      runtimeMock.createRuntimeCalls.push({
        threadId: input.threadId,
        cwd: input.cwd,
        agentDir: input.agentDir,
        sessionDir: input.sessionDir,
        ...(input.sessionFile ? { sessionFile: input.sessionFile } : {}),
        ...(input.modelSlug ? { modelSlug: input.modelSlug } : {}),
        ...(input.thinkingLevel ? { thinkingLevel: input.thinkingLevel } : {}),
      });
      const instance = new FakePiRuntimeInstance(
        input.threadId,
        input.agentDir,
        input.sessionDir,
        input.modelSlug,
        input.thinkingLevel,
      );
      await instance.initialize(input.extensionFactories);
      runtimeMock.instances.set(input.threadId, instance);
      return {
        runtime: instance.runtime as never,
        agentDir: input.agentDir,
        sessionDir: input.sessionDir,
        authStorage: {} as never,
        modelRegistry: instance.modelRegistry as never,
        settingsManager: {} as never,
      };
    }),
};

const PiAdapterTestLayer = makePiAdapterLive().pipe(
  Layer.provideMerge(Layer.succeed(PiRuntime, PiRuntimeTestDouble)),
  Layer.provideMerge(ServerConfig.layerTest(process.cwd(), process.cwd())),
  Layer.provideMerge(
    ServerSettingsService.layerTest({
      providers: {
        pi: {
          binaryPath: "pi",
          agentDir: "",
          useGlobalAgentDir: false,
        },
      },
    }),
  ),
  Layer.provideMerge(NodeServices.layer),
);

beforeEach(() => {
  runtimeMock.reset();
});

function takeEvents(
  adapter: {
    readonly streamEvents: Stream.Stream<ProviderRuntimeEvent>;
  },
  count: number,
) {
  return Stream.take(adapter.streamEvents, count).pipe(
    Stream.runCollect,
    Effect.map((events) => Array.from(events)),
    Effect.orDie,
  );
}

it.layer(PiAdapterTestLayer)("PiAdapterLive", (it) => {
  it.effect("starts and stops Pi sessions with resumable cursors", () =>
    Effect.gen(function* () {
      const adapter = yield* PiAdapter;
      const threadId = asThreadId("thread-pi-start-stop");

      const session = yield* adapter.startSession({
        provider: "pi",
        threadId,
        runtimeMode: "full-access",
        cwd: "/tmp/project",
      });

      assert.equal(session.provider, "pi");
      assert.equal(session.threadId, threadId);
      assert.equal(session.cwd, "/tmp/project");
      assert.ok(session.resumeCursor);
      yield* takeEvents(adapter, 2);

      yield* adapter.stopSession(threadId);
      const stoppedEvents = yield* takeEvents(adapter, 1);

      assert.deepEqual(
        stoppedEvents.map((event) => event.type),
        ["session.exited"],
      );
      const sessions = yield* adapter.listSessions();
      assert.deepEqual(sessions, []);
      assert.equal(runtimeMock.get(threadId).disposeCalls, 1);
    }),
  );

  it.effect("rejects plan mode turns at the adapter boundary", () =>
    Effect.gen(function* () {
      const adapter = yield* PiAdapter;
      const threadId = asThreadId("thread-pi-plan");

      yield* adapter.startSession({
        provider: "pi",
        threadId,
        runtimeMode: "full-access",
      });
      yield* takeEvents(adapter, 2);

      const failure = yield* Effect.flip(
        adapter.sendTurn({
          threadId,
          input: "plan this",
          attachments: [],
          interactionMode: "plan",
        }),
      );

      assert.equal(failure._tag, "ProviderAdapterValidationError");
      assert.equal(failure.issue, "Pi does not support plan mode in T3 Code.");
    }),
  );

  it.effect("opens approval requests for Pi tool calls after session startup", () =>
    Effect.gen(function* () {
      const adapter = yield* PiAdapter;
      const threadId = asThreadId("thread-pi-approval");

      yield* adapter.startSession({
        provider: "pi",
        threadId,
        runtimeMode: "approval-required",
      });
      yield* takeEvents(adapter, 2);

      const runtime = runtimeMock.get(threadId);
      const toolCallResult = runtime.dispatchToolCall({
        type: "tool_call",
        toolName: "read",
        toolCallId: "tool-call-read-1",
        input: { filePath: "README.md" },
      } as ToolCallEvent);

      const [openedEvent] = yield* takeEvents(adapter, 1);
      assert.equal(openedEvent?.type, "request.opened");
      assert.equal(openedEvent?.payload.requestType, "file_read_approval");
      assert.ok(openedEvent?.requestId);

      yield* adapter.respondToRequest(
        threadId,
        ApprovalRequestId.make(openedEvent.requestId),
        "accept",
      );

      const [resolvedEvent] = yield* takeEvents(adapter, 1);
      assert.equal(resolvedEvent?.type, "request.resolved");

      const result = yield* Effect.promise(() => toolCallResult);
      assert.equal(result, undefined);
    }),
  );

  it.effect("interrupting a Pi turn settles pending approval waits", () =>
    Effect.gen(function* () {
      const adapter = yield* PiAdapter;
      const threadId = asThreadId("thread-pi-interrupt-pending-approval");

      yield* adapter.startSession({
        provider: "pi",
        threadId,
        runtimeMode: "approval-required",
      });
      yield* takeEvents(adapter, 2);

      const runtime = runtimeMock.get(threadId);
      runtime.queuePromptPlan(async ({ options, runtime }) => {
        options?.preflightResult?.(true);
        await runtime.dispatchToolCall({
          type: "tool_call",
          toolName: "read",
          toolCallId: "tool-call-read-interrupt",
          input: { path: "README.md" },
        } as ToolCallEvent);
      });

      yield* adapter.sendTurn({
        threadId,
        input: "read something and wait",
        attachments: [],
      });

      const pendingEvents = yield* takeEvents(adapter, 2);
      assert.deepEqual(
        pendingEvents.map((event) => event.type),
        ["turn.started", "request.opened"],
      );

      yield* adapter.interruptTurn(threadId);
      const interruptedEvents = yield* takeEvents(adapter, 3);

      assert.deepEqual(
        interruptedEvents.map((event) => event.type),
        ["request.resolved", "turn.aborted", "turn.completed"],
      );
      const completedEvent = interruptedEvents[2];
      assert.equal(completedEvent?.type, "turn.completed");
      if (completedEvent?.type === "turn.completed") {
        assert.equal(completedEvent.payload.state, "interrupted");
      }

      yield* adapter.sendTurn({
        threadId,
        input: "next turn should start",
        attachments: [],
      });
    }),
  );

  it.effect("stopping a Pi session resolves pending user-input waits", () =>
    Effect.gen(function* () {
      const adapter = yield* PiAdapter;
      const threadId = asThreadId("thread-pi-stop-pending-user-input");

      yield* adapter.startSession({
        provider: "pi",
        threadId,
        runtimeMode: "full-access",
      });
      yield* takeEvents(adapter, 2);

      const runtime = runtimeMock.get(threadId);
      runtime.queuePromptPlan(async ({ options, runtime }) => {
        options?.preflightResult?.(true);
        await runtime.executeAskUserTool({
          question: "Which branch should I use?",
          placeholder: "branch name",
        });
      });

      yield* adapter.sendTurn({
        threadId,
        input: "ask me a question",
        attachments: [],
      });

      const pendingEvents = yield* takeEvents(adapter, 2);
      assert.deepEqual(
        pendingEvents.map((event) => event.type),
        ["turn.started", "user-input.requested"],
      );

      yield* adapter.stopSession(threadId);
      const stoppedEvents = yield* takeEvents(adapter, 2);

      assert.deepEqual(
        stoppedEvents.map((event) => event.type),
        ["user-input.resolved", "session.exited"],
      );
      const resolvedEvent = stoppedEvents[0];
      assert.equal(resolvedEvent?.type, "user-input.resolved");
      if (resolvedEvent?.type === "user-input.resolved") {
        assert.deepEqual(resolvedEvent.payload.answers, {});
      }
    }),
  );

  it.effect("auto-accepts Pi tool calls in full-access mode", () =>
    Effect.gen(function* () {
      const adapter = yield* PiAdapter;
      const threadId = asThreadId("thread-pi-full-access-approval");

      yield* adapter.startSession({
        provider: "pi",
        threadId,
        runtimeMode: "full-access",
      });
      yield* takeEvents(adapter, 2);

      const runtime = runtimeMock.get(threadId);
      const result = yield* Effect.promise(() =>
        Promise.race([
          runtime
            .dispatchToolCall({
              type: "tool_call",
              toolName: "read",
              toolCallId: "tool-call-read-full-access",
              input: { filePath: "README.md" },
            } as ToolCallEvent)
            .then((value) => ({ status: "resolved" as const, value })),
          new Promise<{ status: "timed_out" }>((resolve) =>
            setTimeout(() => resolve({ status: "timed_out" }), 50),
          ),
        ]),
      );

      assert.deepEqual(result, { status: "resolved", value: undefined });
    }),
  );

  it.effect("auto-accepts Pi file reads in auto-accept-edits mode", () =>
    Effect.gen(function* () {
      const adapter = yield* PiAdapter;
      const threadId = asThreadId("thread-pi-auto-accept-approval");

      yield* adapter.startSession({
        provider: "pi",
        threadId,
        runtimeMode: "auto-accept-edits",
      });
      yield* takeEvents(adapter, 2);

      const runtime = runtimeMock.get(threadId);
      const result = yield* Effect.promise(() =>
        Promise.race([
          runtime
            .dispatchToolCall({
              type: "tool_call",
              toolName: "read",
              toolCallId: "tool-call-read-auto-accept",
              input: { filePath: "README.md" },
            } as ToolCallEvent)
            .then((value) => ({ status: "resolved" as const, value })),
          new Promise<{ status: "timed_out" }>((resolve) =>
            setTimeout(() => resolve({ status: "timed_out" }), 50),
          ),
        ]),
      );

      assert.deepEqual(result, { status: "resolved", value: undefined });
    }),
  );

  it.effect("accepts built-in Pi custom model slugs during turns", () =>
    Effect.gen(function* () {
      const adapter = yield* PiAdapter;
      const threadId = asThreadId("thread-pi-custom-model");

      yield* adapter.startSession({
        provider: "pi",
        threadId,
        runtimeMode: "full-access",
      });
      yield* takeEvents(adapter, 2);

      const runtime = runtimeMock.get(threadId);
      runtime.queuePromptPlan(async ({ options }) => {
        options?.preflightResult?.(true);
      });

      yield* adapter.sendTurn({
        threadId,
        input: "use the custom model",
        attachments: [],
        interactionMode: "default",
        modelSelection: {
          provider: "pi",
          model: "openai/custom-model",
        },
      });

      assert.equal(runtime.runtime.session.model?.provider, "openai");
      assert.equal(runtime.runtime.session.model?.id, "custom-model");
    }),
  );
});
