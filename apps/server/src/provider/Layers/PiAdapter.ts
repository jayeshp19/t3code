import { randomUUID } from "node:crypto";
import {
  type ChatImageAttachment,
  EventId,
  RuntimeItemId,
  RuntimeRequestId,
  type ProviderApprovalDecision,
  type ProviderRuntimeEvent,
  type ProviderSession,
  type ProviderTurnStartResult,
  type ProviderUserInputAnswers,
  type PiModelSelection,
  ThreadId,
  TurnId,
  type UserInputQuestion,
} from "@t3tools/contracts";
import type {
  AgentSessionEvent,
  ExtensionFactory,
  ExtensionUIContext,
  ToolCallEvent,
  ToolCallEventResult,
  ToolDefinition,
} from "@mariozechner/pi-coding-agent";
import { Effect, FileSystem, Layer, Queue, Stream } from "effect";
import { getProviderOptionStringSelectionValue } from "@t3tools/shared/model";

import { resolveAttachmentPath } from "../../attachmentStore.ts";
import { ServerConfig } from "../../config.ts";
import { ServerSettingsService } from "../../serverSettings.ts";
import {
  ProviderAdapterSessionClosedError,
  ProviderAdapterSessionNotFoundError,
} from "../Errors.ts";
import {
  ProviderAdapterProcessError,
  ProviderAdapterRequestError,
  ProviderAdapterValidationError,
} from "../Errors.ts";
import { PiAdapter, type PiAdapterShape } from "../Services/PiAdapter.ts";
import {
  createPiResumeCursor,
  isPiThinkingLevel,
  parsePiModelSlug,
  parsePiResumeCursor,
  PiRuntime,
  piRuntimeErrorDetail,
  resolvePiModel,
  resolvePiAgentDir,
  resolvePiSessionDir,
  type PiThinkingLevel,
  type PiRuntimeHandle,
} from "../piRuntime.ts";
import { loadPiSdkEffect, type PiImageContent, type PiSdk } from "../piSdk.ts";

const PROVIDER = "pi" as const;
const PI_RUNTIME_RAW_SOURCE = "pi.sdk.event" as const;
const PI_PERSISTED_TURN_CUSTOM_TYPE = "t3.pi.turn";
const PI_USER_INPUT_ANSWER_KEY = "value";
const PI_USER_INPUT_TOOL_NAME = "t3_ask_user";
const getPiThinkingLevel = (
  modelSelection: PiModelSelection | undefined,
): PiThinkingLevel | undefined => {
  const value = getProviderOptionStringSelectionValue(modelSelection?.options, "thinkingLevel");
  const trimmed = value?.trim();
  return trimmed && isPiThinkingLevel(trimmed) ? trimmed : undefined;
};
type PiSessionMessage = Extract<
  Extract<AgentSessionEvent, { type: "message_start" | "message_update" | "message_end" }>,
  { message: unknown }
>["message"];

interface PiTurnSnapshot {
  readonly id: TurnId;
  readonly items: Array<unknown>;
  readonly leafEntryId: string;
  readonly state: "completed" | "failed" | "interrupted" | "cancelled";
  readonly stopReason?: string;
  readonly errorMessage?: string;
}

interface PiPersistedTurnData {
  readonly schemaVersion: 1;
  readonly turnId: string;
  readonly items: ReadonlyArray<unknown>;
  readonly state: PiTurnSnapshot["state"];
  readonly stopReason?: string;
  readonly errorMessage?: string;
}

interface PendingApprovalRequest {
  readonly turnId: TurnId | undefined;
  readonly requestType:
    | "command_execution_approval"
    | "file_read_approval"
    | "file_change_approval"
    | "dynamic_tool_call";
  readonly detail?: string;
  readonly args?: unknown;
  readonly resolve: (decision: ProviderApprovalDecision) => void;
}

interface PendingUserInputRequest {
  readonly turnId: TurnId | undefined;
  readonly questions: ReadonlyArray<UserInputQuestion>;
  readonly resolve: (answers: ProviderUserInputAnswers) => void;
}

interface PiTurnInFlight {
  readonly id: TurnId;
  readonly items: Array<unknown>;
  readonly model?: string;
  readonly effort?: string;
  assistantItemOrdinal: number;
  assistantMessageItemId: string | undefined;
  latestAssistantMessage: PiSessionMessage | undefined;
  latestStopReason: string | undefined;
}

interface PiSessionContext {
  session: ProviderSession;
  readonly handle: PiRuntimeHandle;
  readonly pendingApprovals: Map<string, PendingApprovalRequest>;
  readonly pendingUserInputs: Map<string, PendingUserInputRequest>;
  readonly acceptedForSession: Set<PendingApprovalRequest["requestType"]>;
  readonly turns: Array<PiTurnSnapshot>;
  readonly directory: string;
  uiContext: ExtensionUIContext;
  stopped: boolean;
  eventQueue: Promise<void>;
  activeTurn: PiTurnInFlight | undefined;
  unsubscribe: (() => void) | undefined;
}

export interface PiAdapterLiveOptions {
  readonly nativeEventLogPath?: string;
}

function nowIso(): string {
  return new Date().toISOString();
}

function buildEventBase(input: {
  readonly threadId: ThreadId;
  readonly turnId?: TurnId | undefined;
  readonly itemId?: string | undefined;
  readonly requestId?: string | undefined;
  readonly createdAt?: string | undefined;
  readonly raw?: unknown;
}): Pick<
  ProviderRuntimeEvent,
  "eventId" | "provider" | "threadId" | "createdAt" | "turnId" | "itemId" | "requestId" | "raw"
> {
  return {
    eventId: EventId.make(randomUUID()),
    provider: PROVIDER,
    threadId: input.threadId,
    createdAt: input.createdAt ?? nowIso(),
    ...(input.turnId ? { turnId: input.turnId } : {}),
    ...(input.itemId ? { itemId: RuntimeItemId.make(input.itemId) } : {}),
    ...(input.requestId ? { requestId: RuntimeRequestId.make(input.requestId) } : {}),
    ...(input.raw !== undefined
      ? {
          raw: {
            source: PI_RUNTIME_RAW_SOURCE,
            payload: input.raw,
          },
        }
      : {}),
  };
}

function extractTextContent(content: unknown): string {
  if (!Array.isArray(content)) {
    return "";
  }
  return content
    .flatMap((part) => {
      if (!part || typeof part !== "object") {
        return [];
      }
      const candidate = part as { type?: unknown; text?: unknown };
      return candidate.type === "text" && typeof candidate.text === "string"
        ? [candidate.text]
        : [];
    })
    .join("");
}

function extractTextResultContent(result: unknown): string {
  if (!result || typeof result !== "object" || !("content" in result)) {
    return "";
  }
  return extractTextContent((result as { content?: unknown }).content);
}

function ensureSessionContext(
  sessions: ReadonlyMap<ThreadId, PiSessionContext>,
  threadId: ThreadId,
): PiSessionContext {
  const context = sessions.get(threadId);
  if (!context) {
    throw new ProviderAdapterSessionNotFoundError({ provider: PROVIDER, threadId });
  }
  if (context.stopped) {
    throw new ProviderAdapterSessionClosedError({ provider: PROVIDER, threadId });
  }
  return context;
}

function toProcessError(threadId: ThreadId, cause: unknown): ProviderAdapterProcessError {
  return new ProviderAdapterProcessError({
    provider: PROVIDER,
    threadId,
    detail: piRuntimeErrorDetail(cause),
    cause,
  });
}

function toRequestError(
  threadId: ThreadId,
  method: string,
  cause: unknown,
): ProviderAdapterRequestError {
  return new ProviderAdapterRequestError({
    provider: PROVIDER,
    method,
    detail: piRuntimeErrorDetail(cause),
    cause,
  });
}

function createAssistantItemId(turnId: TurnId, ordinal: number): string {
  return `pi-assistant-${turnId}-${ordinal}`;
}

function assistantTextFromMessage(message: PiSessionMessage | undefined): string {
  if (!message || message.role !== "assistant") {
    return "";
  }
  return extractTextContent(message.content);
}

function stringifyUnknown(value: unknown): string | undefined {
  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : undefined;
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  return undefined;
}

function toolLifecycleItemType(
  toolName: string,
): "command_execution" | "file_change" | "dynamic_tool_call" {
  switch (toolName) {
    case "bash":
      return "command_execution";
    case "edit":
    case "write":
      return "file_change";
    default:
      return "dynamic_tool_call";
  }
}

function toolApprovalRequestType(toolName: string): PendingApprovalRequest["requestType"] | null {
  switch (toolName) {
    case "bash":
      return "command_execution_approval";
    case "read":
    case "ls":
    case "find":
    case "grep":
      return "file_read_approval";
    case "edit":
    case "write":
      return "file_change_approval";
    default:
      return "dynamic_tool_call";
  }
}

function toolApprovalDetail(event: ToolCallEvent): string | undefined {
  const input =
    event.input && typeof event.input === "object" ? (event.input as Record<string, unknown>) : {};
  if (event.toolName === "bash") {
    return stringifyUnknown(input.command);
  }
  if (
    event.toolName === "read" ||
    event.toolName === "ls" ||
    event.toolName === "find" ||
    event.toolName === "edit" ||
    event.toolName === "write"
  ) {
    return stringifyUnknown(input.path);
  }
  if (event.toolName === "grep") {
    return stringifyUnknown(input.pattern) ?? stringifyUnknown(input.path);
  }
  return event.toolName;
}

function requestDecisionLabel(decision: ProviderApprovalDecision): string {
  switch (decision) {
    case "accept":
      return "accept";
    case "acceptForSession":
      return "acceptForSession";
    case "decline":
      return "decline";
    case "cancel":
    default:
      return "cancel";
  }
}

function shouldAutoApprovePiRequest(
  runtimeMode: ProviderSession["runtimeMode"],
  requestType: PendingApprovalRequest["requestType"],
): boolean {
  switch (runtimeMode) {
    case "full-access":
      return true;
    case "auto-accept-edits":
      return requestType === "file_read_approval" || requestType === "file_change_approval";
    case "approval-required":
    default:
      return false;
  }
}

function buildUserInputQuestion(input: {
  readonly title: string;
  readonly options?: ReadonlyArray<string>;
  readonly placeholder?: string | undefined;
}): UserInputQuestion {
  const question =
    input.placeholder && input.placeholder.trim().length > 0
      ? `${input.title.trim()}\n${input.placeholder.trim()}`
      : input.title.trim();
  return {
    id: PI_USER_INPUT_ANSWER_KEY,
    header: input.options && input.options.length > 0 ? "Select" : "Input",
    question,
    options:
      input.options?.map((option) => ({
        label: option,
        description: option,
      })) ?? [],
    ...(input.options && input.options.length > 0 ? {} : { multiSelect: false }),
  };
}

function parsePersistedTurnEntry(entry: unknown): PiTurnSnapshot | undefined {
  if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
    return undefined;
  }
  const candidate = entry as {
    type?: unknown;
    id?: unknown;
    customType?: unknown;
    data?: unknown;
  };
  if (
    candidate.type !== "custom" ||
    candidate.customType !== PI_PERSISTED_TURN_CUSTOM_TYPE ||
    !candidate.data ||
    typeof candidate.data !== "object" ||
    Array.isArray(candidate.data) ||
    typeof candidate.id !== "string"
  ) {
    return undefined;
  }
  const data = candidate.data as Record<string, unknown>;
  if (
    data.schemaVersion !== 1 ||
    typeof data.turnId !== "string" ||
    !Array.isArray(data.items) ||
    (data.state !== "completed" &&
      data.state !== "failed" &&
      data.state !== "interrupted" &&
      data.state !== "cancelled")
  ) {
    return undefined;
  }
  return {
    id: TurnId.make(data.turnId),
    items: [...data.items],
    leafEntryId: candidate.id,
    state: data.state,
    ...(typeof data.stopReason === "string" ? { stopReason: data.stopReason } : {}),
    ...(typeof data.errorMessage === "string" ? { errorMessage: data.errorMessage } : {}),
  };
}

function rebuildPiTurnsFromSession(context: PiSessionContext): Array<PiTurnSnapshot> {
  return context.handle.runtime.session.sessionManager
    .getEntries()
    .map((entry) => parsePersistedTurnEntry(entry))
    .filter((entry): entry is PiTurnSnapshot => entry !== undefined);
}

function createAskUserInputTool(sdk: PiSdk): ToolDefinition {
  const { defineTool } = sdk.codingAgent;
  const { Type } = sdk.ai;
  return defineTool({
    name: PI_USER_INPUT_TOOL_NAME,
    label: "Ask User",
    description:
      "Ask the user a question and wait for their response when you need missing information.",
    parameters: Type.Object({
      question: Type.String({
        description: "The question to ask the user.",
      }),
      placeholder: Type.Optional(
        Type.String({
          description: "Optional placeholder text for free-form input.",
        }),
      ),
      options: Type.Optional(
        Type.Array(
          Type.String({
            description: "An answer option the user can choose.",
          }),
          {
            description: "Optional choices for the user. Omit for free-form input.",
          },
        ),
      ),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      if (!ctx.hasUI) {
        return {
          content: [{ type: "text", text: "User input is unavailable in this runtime." }],
          details: {
            cancelled: true,
          },
        };
      }

      const answer =
        Array.isArray(params.options) && params.options.length > 0
          ? await ctx.ui.select(params.question, params.options)
          : await ctx.ui.input(params.question, params.placeholder);

      if (!answer) {
        return {
          content: [{ type: "text", text: "The user did not provide an answer." }],
          details: {
            cancelled: true,
          },
        };
      }

      return {
        content: [{ type: "text", text: answer }],
        details: {
          cancelled: false,
          answer,
        },
      };
    },
  });
}

function buildTurnCompletionState(input: {
  readonly activeTurn: PiTurnInFlight;
  readonly interrupted: boolean;
  readonly promptError: unknown | null;
}): {
  readonly state: PiTurnSnapshot["state"];
  readonly stopReason?: string;
  readonly errorMessage?: string;
} {
  const stopReason = input.activeTurn.latestStopReason;
  if (input.interrupted || stopReason === "aborted") {
    return { state: "interrupted", stopReason: stopReason ?? "aborted" };
  }
  if (stopReason === "error" || input.promptError) {
    return {
      state: "failed",
      ...(stopReason ? { stopReason } : {}),
      errorMessage: piRuntimeErrorDetail(input.promptError ?? "Pi turn failed."),
    };
  }
  if (stopReason === "length") {
    return { state: "completed", stopReason };
  }
  if (stopReason === "toolUse" || stopReason === "stop") {
    return { state: "completed", stopReason };
  }
  return { state: "completed" };
}

function makePiAdapter(options?: PiAdapterLiveOptions) {
  return Layer.effect(
    PiAdapter,
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const serverConfig = yield* ServerConfig;
      const serverSettings = yield* ServerSettingsService;
      const piRuntime = yield* PiRuntime;
      const runtimeContext = yield* Effect.context<never>();
      const runPromise = Effect.runPromiseWith(runtimeContext);
      const sessions = new Map<ThreadId, PiSessionContext>();
      const runtimeEvents = yield* Queue.unbounded<ProviderRuntimeEvent>();
      void options;

      const offerEvent = (event: ProviderRuntimeEvent): Effect.Effect<void> =>
        Queue.offer(runtimeEvents, event).pipe(Effect.asVoid);

      const queueSessionEvent = (context: PiSessionContext, event: AgentSessionEvent): void => {
        if (context.stopped) {
          return;
        }
        context.eventQueue = context.eventQueue
          .then(() => runPromise(handleSessionEvent(context, event)))
          .catch((cause) =>
            runPromise(
              offerEvent({
                ...buildEventBase({
                  threadId: context.session.threadId,
                  turnId: context.activeTurn?.id,
                  raw: {
                    type: "pi.listener.error",
                    message: piRuntimeErrorDetail(cause),
                  },
                }),
                type: "runtime.error",
                payload: {
                  message: piRuntimeErrorDetail(cause),
                  class: "provider_error",
                },
              }),
            ).catch(() => undefined),
          );
      };

      const clearPendingInteractiveState = Effect.fn("clearPendingInteractiveState")(function* (
        context: PiSessionContext,
        options?: {
          readonly approvalDecision?: ProviderApprovalDecision;
          readonly userInputAnswers?: ProviderUserInputAnswers;
        },
      ) {
        const approvalDecision = options?.approvalDecision ?? "cancel";
        const userInputAnswers = options?.userInputAnswers ?? {};
        const pendingApprovals = [...context.pendingApprovals.entries()];
        const pendingUserInputs = [...context.pendingUserInputs.entries()];
        context.pendingApprovals.clear();
        context.pendingUserInputs.clear();

        for (const [requestId, pending] of pendingApprovals) {
          yield* offerEvent({
            ...buildEventBase({
              threadId: context.session.threadId,
              turnId: pending.turnId,
              requestId,
              raw: { type: "pi.approval.resolved", decision: approvalDecision },
            }),
            type: "request.resolved",
            payload: {
              requestType: pending.requestType,
              decision: requestDecisionLabel(approvalDecision),
            },
          });
          pending.resolve(approvalDecision);
        }

        for (const [requestId, pending] of pendingUserInputs) {
          yield* offerEvent({
            ...buildEventBase({
              threadId: context.session.threadId,
              turnId: pending.turnId,
              requestId,
              raw: { type: "pi.user-input.resolved", answers: userInputAnswers },
            }),
            type: "user-input.resolved",
            payload: {
              answers: userInputAnswers,
            },
          });
          pending.resolve(userInputAnswers);
        }
      });

      const requestApproval = async (
        context: PiSessionContext,
        input: {
          readonly requestType: PendingApprovalRequest["requestType"];
          readonly detail?: string;
          readonly args?: unknown;
        },
      ): Promise<ProviderApprovalDecision> => {
        if (context.acceptedForSession.has(input.requestType)) {
          return "accept";
        }
        if (shouldAutoApprovePiRequest(context.session.runtimeMode, input.requestType)) {
          return "accept";
        }

        const requestId = RuntimeRequestId.make(`pi-approval-${randomUUID()}`);
        const decision = await new Promise<ProviderApprovalDecision>((resolve) => {
          context.pendingApprovals.set(requestId, {
            turnId: context.activeTurn?.id,
            requestType: input.requestType,
            ...(input.detail ? { detail: input.detail } : {}),
            ...(input.args !== undefined ? { args: input.args } : {}),
            resolve,
          });
          void runPromise(
            offerEvent({
              ...buildEventBase({
                threadId: context.session.threadId,
                turnId: context.activeTurn?.id,
                requestId,
                raw: {
                  type: "pi.approval.requested",
                  requestType: input.requestType,
                  detail: input.detail,
                  args: input.args,
                },
              }),
              type: "request.opened",
              payload: {
                requestType: input.requestType,
                ...(input.detail ? { detail: input.detail } : {}),
                ...(input.args !== undefined ? { args: input.args } : {}),
              },
            }),
          );
        });

        if (decision === "acceptForSession") {
          context.acceptedForSession.add(input.requestType);
        }
        return decision;
      };

      const createPiExtension = (
        getContext: () => PiSessionContext | undefined,
        sdk: PiSdk,
      ): ExtensionFactory => {
        const askUserInputTool = createAskUserInputTool(sdk);
        return (pi) => {
          pi.registerTool(askUserInputTool);
          pi.on("tool_call", async (event): Promise<ToolCallEventResult | undefined> => {
            if (event.toolName === PI_USER_INPUT_TOOL_NAME) {
              return undefined;
            }
            const requestType = toolApprovalRequestType(event.toolName);
            if (!requestType) {
              return undefined;
            }

            const context = getContext();
            if (!context) {
              throw new Error("Pi session context is not ready.");
            }
            const detail = toolApprovalDetail(event);
            const decision = await requestApproval(context, {
              requestType,
              ...(detail ? { detail } : {}),
              args: event.input,
            });

            if (decision === "accept" || decision === "acceptForSession") {
              return undefined;
            }

            return {
              block: true,
              reason: decision === "cancel" ? "Cancelled by user." : "Blocked by user.",
            };
          });
        };
      };

      const createExtensionUiContext = (context: PiSessionContext): ExtensionUIContext => {
        const select = (title: string, selectOptions: string[]) =>
          new Promise<string | undefined>((resolve) => {
            const requestId = RuntimeRequestId.make(`pi-input-${randomUUID()}`);
            const questions = [buildUserInputQuestion({ title, options: selectOptions })];
            context.pendingUserInputs.set(requestId, {
              turnId: context.activeTurn?.id,
              questions,
              resolve: (answers) => {
                const raw = answers[PI_USER_INPUT_ANSWER_KEY];
                resolve(typeof raw === "string" ? raw : undefined);
              },
            });
            void runPromise(
              offerEvent({
                ...buildEventBase({
                  threadId: context.session.threadId,
                  turnId: context.activeTurn?.id,
                  requestId,
                  raw: {
                    type: "pi.user-input.requested",
                    title,
                    options: selectOptions,
                  },
                }),
                type: "user-input.requested",
                payload: {
                  questions,
                },
              }),
            );
          });

        const inputText = (title: string, placeholder?: string) =>
          new Promise<string | undefined>((resolve) => {
            const requestId = RuntimeRequestId.make(`pi-input-${randomUUID()}`);
            const questions = [buildUserInputQuestion({ title, placeholder })];
            context.pendingUserInputs.set(requestId, {
              turnId: context.activeTurn?.id,
              questions,
              resolve: (answers) => {
                const raw = answers[PI_USER_INPUT_ANSWER_KEY];
                resolve(typeof raw === "string" ? raw : undefined);
              },
            });
            void runPromise(
              offerEvent({
                ...buildEventBase({
                  threadId: context.session.threadId,
                  turnId: context.activeTurn?.id,
                  requestId,
                  raw: {
                    type: "pi.user-input.requested",
                    title,
                    placeholder,
                  },
                }),
                type: "user-input.requested",
                payload: {
                  questions,
                },
              }),
            );
          });

        return {
          select,
          confirm: async (title, message) => {
            const answer = await select(`${title}\n\n${message}`, ["Yes", "No"]);
            return answer === "Yes";
          },
          input: inputText,
          notify() {},
          onTerminalInput() {
            return () => {};
          },
          setStatus() {},
          setWorkingMessage() {},
          setWorkingIndicator() {},
          setHiddenThinkingLabel() {},
          setWidget() {},
          setFooter() {},
          setHeader() {},
          setTitle() {},
          async custom() {
            throw new Error("Custom extension UI is not supported in the Pi adapter.");
          },
          pasteToEditor() {},
          setEditorText() {},
          getEditorText() {
            return "";
          },
          async editor(title, prefill) {
            return inputText(title, prefill);
          },
          setEditorComponent() {},
          get theme() {
            return undefined as never;
          },
          getAllThemes() {
            return [];
          },
          getTheme() {
            return undefined;
          },
          setTheme() {
            return { success: false, error: "Theme switching is not supported in the Pi adapter." };
          },
          getToolsExpanded() {
            return false;
          },
          setToolsExpanded() {},
        };
      };

      const rebindContextSession = async (context: PiSessionContext): Promise<void> => {
        const session = context.handle.runtime.session;
        context.uiContext = createExtensionUiContext(context);
        await session.bindExtensions({
          uiContext: context.uiContext,
        });
        context.unsubscribe?.();
        context.unsubscribe = session.subscribe((event) => {
          queueSessionEvent(context, event);
        });
        const modelSlug = session.model
          ? `${session.model.provider}/${session.model.id}`
          : undefined;
        const resumeCursor = createPiResumeCursor({
          agentDir: context.handle.agentDir,
          sessionDir: context.handle.sessionDir,
          session,
        });
        context.session = {
          ...context.session,
          status: context.activeTurn ? "running" : "ready",
          ...(modelSlug ? { model: modelSlug } : {}),
          ...(resumeCursor ? { resumeCursor } : {}),
          updatedAt: nowIso(),
        };
      };

      const finalizeTurn = Effect.fn("finalizeTurn")(function* (
        context: PiSessionContext,
        activeTurn: PiTurnInFlight,
        input: {
          readonly promptError: unknown | null;
          readonly interrupted: boolean;
        },
      ) {
        const completion = buildTurnCompletionState({
          activeTurn,
          interrupted: input.interrupted,
          promptError: input.promptError,
        });
        if (context.stopped) {
          return;
        }
        const entryId = context.handle.runtime.session.sessionManager.appendCustomEntry(
          PI_PERSISTED_TURN_CUSTOM_TYPE,
          {
            schemaVersion: 1,
            turnId: activeTurn.id,
            items: activeTurn.items,
            state: completion.state,
            ...(completion.stopReason ? { stopReason: completion.stopReason } : {}),
            ...(completion.errorMessage ? { errorMessage: completion.errorMessage } : {}),
          } satisfies PiPersistedTurnData,
        );
        const snapshot: PiTurnSnapshot = {
          id: activeTurn.id,
          items: [...activeTurn.items],
          leafEntryId: entryId,
          state: completion.state,
          ...(completion.stopReason ? { stopReason: completion.stopReason } : {}),
          ...(completion.errorMessage ? { errorMessage: completion.errorMessage } : {}),
        };
        context.turns.push(snapshot);
        const { lastError: _discardedLastError, ...sessionWithoutLastError } = context.session;
        const resumeCursor = createPiResumeCursor({
          agentDir: context.handle.agentDir,
          sessionDir: context.handle.sessionDir,
          session: context.handle.runtime.session,
        });
        context.session = {
          ...sessionWithoutLastError,
          status: "ready",
          activeTurnId: undefined,
          ...(completion.errorMessage ? { lastError: completion.errorMessage } : {}),
          ...(resumeCursor ? { resumeCursor } : {}),
          updatedAt: nowIso(),
        };
        context.activeTurn = undefined;
        yield* clearPendingInteractiveState(context);

        yield* offerEvent({
          ...buildEventBase({
            threadId: context.session.threadId,
            turnId: activeTurn.id,
            raw: {
              type: "pi.turn.completed",
              state: completion.state,
              stopReason: completion.stopReason,
              errorMessage: completion.errorMessage,
            },
          }),
          type: "turn.completed",
          payload: {
            state: completion.state,
            ...(completion.stopReason ? { stopReason: completion.stopReason } : {}),
            ...(completion.errorMessage ? { errorMessage: completion.errorMessage } : {}),
          },
        });
      });

      const handleSessionEvent = Effect.fn("handleSessionEvent")(function* (
        context: PiSessionContext,
        event: AgentSessionEvent,
      ) {
        const turnId = context.activeTurn?.id;
        switch (event.type) {
          case "message_start": {
            if (event.message.role !== "assistant" || !turnId || !context.activeTurn) {
              return;
            }
            context.activeTurn.assistantItemOrdinal += 1;
            const itemId = createAssistantItemId(turnId, context.activeTurn.assistantItemOrdinal);
            context.activeTurn.assistantMessageItemId = itemId;
            yield* offerEvent({
              ...buildEventBase({
                threadId: context.session.threadId,
                turnId,
                itemId,
                raw: event,
              }),
              type: "item.started",
              payload: {
                itemType: "assistant_message",
                status: "inProgress",
                title: "Assistant message",
              },
            });
            return;
          }

          case "message_update": {
            if (event.message.role !== "assistant" || !turnId || !context.activeTurn) {
              return;
            }
            const itemId =
              context.activeTurn.assistantMessageItemId ??
              createAssistantItemId(turnId, context.activeTurn.assistantItemOrdinal || 1);
            context.activeTurn.assistantMessageItemId = itemId;
            const deltaEvent = event.assistantMessageEvent;
            if (deltaEvent.type === "text_delta" || deltaEvent.type === "thinking_delta") {
              yield* offerEvent({
                ...buildEventBase({
                  threadId: context.session.threadId,
                  turnId,
                  itemId,
                  raw: event,
                }),
                type: "content.delta",
                payload: {
                  streamKind:
                    deltaEvent.type === "thinking_delta" ? "reasoning_text" : "assistant_text",
                  delta: deltaEvent.delta,
                  contentIndex: deltaEvent.contentIndex,
                },
              });
            }
            if (deltaEvent.type === "done") {
              context.activeTurn.latestStopReason = deltaEvent.reason;
            }
            if (deltaEvent.type === "error") {
              context.activeTurn.latestStopReason = deltaEvent.reason;
            }
            return;
          }

          case "message_end": {
            if (event.message.role !== "assistant" || !turnId || !context.activeTurn) {
              return;
            }
            const itemId =
              context.activeTurn.assistantMessageItemId ??
              createAssistantItemId(turnId, context.activeTurn.assistantItemOrdinal || 1);
            const detail = assistantTextFromMessage(event.message);
            context.activeTurn.latestAssistantMessage = event.message;
            context.activeTurn.items.push({
              kind: "assistant_message",
              message: event.message,
            });
            yield* offerEvent({
              ...buildEventBase({
                threadId: context.session.threadId,
                turnId,
                itemId,
                raw: event,
              }),
              type: "item.completed",
              payload: {
                itemType: "assistant_message",
                status: "completed",
                title: "Assistant message",
                ...(detail ? { detail } : {}),
                data: event.message,
              },
            });
            return;
          }

          case "tool_execution_start": {
            if (!turnId || !context.activeTurn) {
              return;
            }
            yield* offerEvent({
              ...buildEventBase({
                threadId: context.session.threadId,
                turnId,
                itemId: event.toolCallId,
                raw: event,
              }),
              type: "item.started",
              payload: {
                itemType: toolLifecycleItemType(event.toolName),
                status: "inProgress",
                title: event.toolName,
                ...(toolApprovalDetail({
                  type: "tool_call",
                  toolName: event.toolName,
                  toolCallId: event.toolCallId,
                  input: event.args,
                } as ToolCallEvent)
                  ? {
                      detail: toolApprovalDetail({
                        type: "tool_call",
                        toolName: event.toolName,
                        toolCallId: event.toolCallId,
                        input: event.args,
                      } as ToolCallEvent),
                    }
                  : {}),
                data: {
                  args: event.args,
                  toolName: event.toolName,
                },
              },
            });
            return;
          }

          case "tool_execution_update": {
            if (!turnId || !context.activeTurn) {
              return;
            }
            const partialText = extractTextResultContent(event.partialResult);
            yield* offerEvent({
              ...buildEventBase({
                threadId: context.session.threadId,
                turnId,
                itemId: event.toolCallId,
                raw: event,
              }),
              type: "item.updated",
              payload: {
                itemType: toolLifecycleItemType(event.toolName),
                status: "inProgress",
                title: event.toolName,
                ...(partialText ? { detail: partialText } : {}),
                data: {
                  partialResult: event.partialResult,
                  args: event.args,
                },
              },
            });
            return;
          }

          case "tool_execution_end": {
            if (!turnId || !context.activeTurn) {
              return;
            }
            context.activeTurn.items.push({
              kind: "tool_execution",
              toolCallId: event.toolCallId,
              toolName: event.toolName,
              result: event.result,
              isError: event.isError,
            });
            const text = extractTextResultContent(event.result);
            yield* offerEvent({
              ...buildEventBase({
                threadId: context.session.threadId,
                turnId,
                itemId: event.toolCallId,
                raw: event,
              }),
              type: "item.completed",
              payload: {
                itemType: toolLifecycleItemType(event.toolName),
                status: event.isError ? "failed" : "completed",
                title: event.toolName,
                ...(text ? { detail: text } : {}),
                data: event.result,
              },
            });
            return;
          }

          case "compaction_end": {
            if (!event.result && event.errorMessage) {
              yield* offerEvent({
                ...buildEventBase({
                  threadId: context.session.threadId,
                  turnId,
                  raw: event,
                }),
                type: "runtime.warning",
                payload: {
                  message: event.errorMessage,
                  detail: event,
                },
              });
            }
            return;
          }

          case "auto_retry_start": {
            yield* offerEvent({
              ...buildEventBase({
                threadId: context.session.threadId,
                turnId,
                raw: event,
              }),
              type: "runtime.warning",
              payload: {
                message: event.errorMessage,
                detail: event,
              },
            });
            return;
          }

          default:
            return;
        }
      });

      const resolveModelSelection = Effect.fn("resolveModelSelection")(function* (
        context: PiSessionContext,
        modelSelection: PiModelSelection | undefined,
      ) {
        const session = context.handle.runtime.session;
        const nextModelSlug = modelSelection?.model ?? context.session.model;
        if (!nextModelSlug) {
          return {
            modelSlug: undefined,
            thinkingLevel: undefined,
          };
        }
        const parsed = parsePiModelSlug(nextModelSlug);
        if (!parsed) {
          return yield* new ProviderAdapterValidationError({
            provider: PROVIDER,
            operation: "sendTurn",
            issue: "Pi model selection must use the 'provider/modelId' format.",
          });
        }
        const model = resolvePiModel(context.handle.modelRegistry, nextModelSlug);
        if (!model) {
          return yield* new ProviderAdapterValidationError({
            provider: PROVIDER,
            operation: "sendTurn",
            issue: `Unknown Pi model '${nextModelSlug}'.`,
          });
        }
        const currentModel = session.model
          ? `${session.model.provider}/${session.model.id}`
          : undefined;
        if (currentModel !== nextModelSlug) {
          yield* Effect.tryPromise({
            try: () => session.setModel(model),
            catch: (cause) => toRequestError(context.session.threadId, "session.setModel", cause),
          });
        }
        const requestedThinkingLevel = getPiThinkingLevel(modelSelection);
        if (requestedThinkingLevel) {
          session.setThinkingLevel(
            requestedThinkingLevel as Parameters<typeof session.setThinkingLevel>[0],
          );
        }
        return {
          modelSlug: nextModelSlug,
          thinkingLevel: requestedThinkingLevel ?? session.thinkingLevel,
        };
      });

      const toPiImageAttachments = Effect.fn("toPiImageAttachments")(function* (
        threadId: ThreadId,
        attachments: ReadonlyArray<ChatImageAttachment>,
      ) {
        const images: PiImageContent[] = [];
        for (const attachment of attachments) {
          const attachmentPath = resolveAttachmentPath({
            attachmentsDir: serverConfig.attachmentsDir,
            attachment,
          });
          if (!attachmentPath) {
            return yield* new ProviderAdapterRequestError({
              provider: PROVIDER,
              method: "turn/start",
              detail: `Invalid attachment id '${attachment.id}'.`,
            });
          }
          const bytes = yield* fileSystem
            .readFile(attachmentPath)
            .pipe(Effect.mapError((cause) => toRequestError(threadId, "turn/start", cause)));
          images.push({
            type: "image",
            data: Buffer.from(bytes).toString("base64"),
            mimeType: attachment.mimeType,
          });
        }
        return images;
      });

      const stopPiContext = Effect.fn("stopPiContext")(function* (
        context: PiSessionContext,
        options?: {
          readonly emitExitEvent?: boolean;
        },
      ) {
        if (context.stopped) {
          return;
        }
        context.stopped = true;
        context.unsubscribe?.();
        context.unsubscribe = undefined;
        yield* clearPendingInteractiveState(context);
        yield* Effect.tryPromise({
          try: () => context.handle.runtime.dispose(),
          catch: (cause) => toProcessError(context.session.threadId, cause),
        }).pipe(
          Effect.catchTag("ProviderAdapterProcessError", (error) =>
            Effect.logWarning("pi.session.dispose.failed", {
              threadId: context.session.threadId,
              detail: error.detail,
            }),
          ),
        );
        context.session = {
          ...context.session,
          status: "closed",
          activeTurnId: undefined,
          updatedAt: nowIso(),
        };
        if (options?.emitExitEvent !== false) {
          yield* offerEvent({
            ...buildEventBase({
              threadId: context.session.threadId,
              raw: { type: "pi.session.exited" },
            }),
            type: "session.exited",
            payload: {
              reason: "Session stopped.",
              recoverable: false,
              exitKind: "graceful",
            },
          });
        }
      });

      const startSession: PiAdapterShape["startSession"] = Effect.fn("startSession")(
        function* (input) {
          const settings = yield* serverSettings.getSettings.pipe(
            Effect.map((allSettings) => allSettings.providers.pi),
            Effect.mapError((cause) => toProcessError(input.threadId, cause)),
          );
          const existing = sessions.get(input.threadId);
          if (existing) {
            yield* stopPiContext(existing, { emitExitEvent: false }).pipe(Effect.ignore);
            sessions.delete(input.threadId);
          }

          const agentDir = resolvePiAgentDir({ settings, serverConfig });
          const resumeCursor = parsePiResumeCursor(input.resumeCursor);
          const runtimeAgentDir = resumeCursor?.agentDir ?? agentDir;
          const sessionDir =
            resumeCursor?.sessionDir ??
            resolvePiSessionDir({ agentDir: runtimeAgentDir, threadId: input.threadId });
          const directory = input.cwd ?? serverConfig.cwd;
          const modelSelection =
            input.modelSelection?.provider === PROVIDER ? input.modelSelection : undefined;
          const thinkingLevel = getPiThinkingLevel(modelSelection);
          const piSdk = yield* loadPiSdkEffect({ sdkRoot: settings.sdkRoot }).pipe(
            Effect.mapError((cause) => toProcessError(input.threadId, cause)),
          );
          let context: PiSessionContext | undefined;
          const extensionFactories: ExtensionFactory[] = [createPiExtension(() => context, piSdk)];

          const created = yield* piRuntime
            .createRuntime({
              threadId: input.threadId,
              cwd: directory,
              agentDir: runtimeAgentDir,
              sessionDir,
              ...(settings.sdkRoot ? { sdkRoot: settings.sdkRoot } : {}),
              ...(resumeCursor?.sessionFile ? { sessionFile: resumeCursor.sessionFile } : {}),
              ...(modelSelection?.model ? { modelSlug: modelSelection.model } : {}),
              ...(thinkingLevel ? { thinkingLevel } : {}),
              extensionFactories,
            })
            .pipe(Effect.mapError((cause) => toProcessError(input.threadId, cause)));

          const createdAt = nowIso();
          const sessionModel = created.runtime.session.model
            ? `${created.runtime.session.model.provider}/${created.runtime.session.model.id}`
            : modelSelection?.model;

          const placeholderSession: ProviderSession = {
            provider: PROVIDER,
            status: "ready",
            runtimeMode: input.runtimeMode,
            cwd: directory,
            ...(sessionModel ? { model: sessionModel } : {}),
            threadId: input.threadId,
            ...(createPiResumeCursor({
              agentDir: created.agentDir,
              sessionDir: created.sessionDir,
              session: created.runtime.session,
            })
              ? {
                  resumeCursor: createPiResumeCursor({
                    agentDir: created.agentDir,
                    sessionDir: created.sessionDir,
                    session: created.runtime.session,
                  }),
                }
              : {}),
            createdAt,
            updatedAt: createdAt,
          };

          context = {
            session: placeholderSession,
            handle: created,
            pendingApprovals: new Map<string, PendingApprovalRequest>(),
            pendingUserInputs: new Map<string, PendingUserInputRequest>(),
            acceptedForSession: new Set<PendingApprovalRequest["requestType"]>(),
            turns: [],
            directory,
            uiContext: undefined as unknown as ExtensionUIContext,
            stopped: false,
            eventQueue: Promise.resolve(),
            activeTurn: undefined,
            unsubscribe: undefined,
          } satisfies PiSessionContext;

          yield* Effect.tryPromise({
            try: () => rebindContextSession(context),
            catch: (cause) => toProcessError(input.threadId, cause),
          });
          context.turns.push(...rebuildPiTurnsFromSession(context));
          sessions.set(input.threadId, context);

          yield* offerEvent({
            ...buildEventBase({
              threadId: input.threadId,
              raw: {
                type: "pi.session.started",
                sessionId: context.handle.runtime.session.sessionId,
              },
            }),
            type: "session.started",
            payload: {
              message: "Pi session started",
            },
          });
          yield* offerEvent({
            ...buildEventBase({
              threadId: input.threadId,
              raw: {
                type: "pi.thread.started",
                sessionId: context.handle.runtime.session.sessionId,
              },
            }),
            type: "thread.started",
            payload: {
              providerThreadId: context.handle.runtime.session.sessionId,
            },
          });

          return context.session;
        },
      );

      const sendTurn: PiAdapterShape["sendTurn"] = Effect.fn("sendTurn")(function* (input) {
        const context = ensureSessionContext(sessions, input.threadId);
        if (input.interactionMode === "plan") {
          return yield* new ProviderAdapterValidationError({
            provider: PROVIDER,
            operation: "sendTurn",
            issue: "Pi does not support plan mode in T3 Code.",
          });
        }
        if (input.modelSelection && input.modelSelection.provider !== PROVIDER) {
          return yield* new ProviderAdapterValidationError({
            provider: PROVIDER,
            operation: "sendTurn",
            issue: "Pi turns require a Pi model selection.",
          });
        }
        if (context.activeTurn) {
          return yield* new ProviderAdapterValidationError({
            provider: PROVIDER,
            operation: "sendTurn",
            issue: "Pi is already processing a turn for this thread.",
          });
        }
        const promptText = input.input?.trim() ?? "";
        const images = yield* toPiImageAttachments(input.threadId, input.attachments ?? []);
        if (promptText.length === 0 && images.length === 0) {
          return yield* new ProviderAdapterValidationError({
            provider: PROVIDER,
            operation: "sendTurn",
            issue: "Pi turns require text input or at least one attachment.",
          });
        }

        const { modelSlug, thinkingLevel } = yield* resolveModelSelection(
          context,
          input.modelSelection,
        );
        const turnId = TurnId.make(`pi-turn-${randomUUID()}`);
        const activeTurn: PiTurnInFlight = {
          id: turnId,
          items: [],
          ...(modelSlug ? { model: modelSlug } : {}),
          ...(thinkingLevel ? { effort: thinkingLevel } : {}),
          assistantItemOrdinal: 0,
          assistantMessageItemId: undefined,
          latestAssistantMessage: undefined,
          latestStopReason: undefined,
        };
        context.activeTurn = activeTurn;
        context.session = {
          ...context.session,
          status: "running",
          activeTurnId: turnId,
          ...(modelSlug ? { model: modelSlug } : {}),
          updatedAt: nowIso(),
        };

        let preflightResolve: (() => void) | undefined;
        let preflightReject: ((error: unknown) => void) | undefined;
        let preflightSettled = false;
        const accepted = new Promise<void>((resolve, reject) => {
          preflightResolve = resolve;
          preflightReject = reject;
        });

        void context.handle.runtime.session
          .prompt(promptText, {
            ...(images.length > 0 ? { images } : {}),
            source: "rpc",
            preflightResult: (success) => {
              if (preflightSettled) {
                return;
              }
              preflightSettled = true;
              if (success) {
                preflightResolve?.();
                void runPromise(
                  offerEvent({
                    ...buildEventBase({
                      threadId: context.session.threadId,
                      turnId,
                      raw: { type: "pi.turn.started", model: modelSlug, effort: thinkingLevel },
                    }),
                    type: "turn.started",
                    payload: {
                      ...(modelSlug ? { model: modelSlug } : {}),
                      ...(thinkingLevel ? { effort: thinkingLevel } : {}),
                    },
                  }),
                );
              } else {
                preflightReject?.(
                  new ProviderAdapterValidationError({
                    provider: PROVIDER,
                    operation: "sendTurn",
                    issue: "Pi rejected the turn before execution started.",
                  }),
                );
              }
            },
          })
          .then(() =>
            runPromise(
              finalizeTurn(context, activeTurn, {
                promptError: null,
                interrupted: activeTurn.latestStopReason === "aborted",
              }),
            ),
          )
          .catch((cause) => {
            if (!preflightSettled) {
              preflightSettled = true;
              preflightReject?.(toRequestError(input.threadId, "session.prompt", cause));
              context.activeTurn = undefined;
              context.session = {
                ...context.session,
                status: "ready",
                activeTurnId: undefined,
                lastError: piRuntimeErrorDetail(cause),
                updatedAt: nowIso(),
              };
              return;
            }
            return runPromise(
              finalizeTurn(context, activeTurn, {
                promptError: cause,
                interrupted: activeTurn.latestStopReason === "aborted",
              }),
            );
          });

        yield* Effect.tryPromise({
          try: () => accepted,
          catch: (cause) =>
            typeof cause === "object" &&
            cause !== null &&
            "_tag" in cause &&
            cause._tag === "ProviderAdapterValidationError"
              ? (cause as ProviderAdapterValidationError)
              : toRequestError(input.threadId, "session.prompt", cause),
        });

        const resumeCursor = createPiResumeCursor({
          agentDir: context.handle.agentDir,
          sessionDir: context.handle.sessionDir,
          session: context.handle.runtime.session,
        });
        return {
          threadId: input.threadId,
          turnId,
          ...(resumeCursor ? { resumeCursor } : {}),
        } satisfies ProviderTurnStartResult;
      });

      const interruptTurn: PiAdapterShape["interruptTurn"] = Effect.fn("interruptTurn")(
        function* (threadId, turnId) {
          const context = ensureSessionContext(sessions, threadId);
          const activeTurnId = turnId ?? context.activeTurn?.id;
          yield* Effect.tryPromise({
            try: () => context.handle.runtime.session.abort(),
            catch: (cause) => toRequestError(threadId, "session.abort", cause),
          });
          if (context.activeTurn) {
            context.activeTurn.latestStopReason = "aborted";
          }
          yield* clearPendingInteractiveState(context);
          if (activeTurnId) {
            yield* offerEvent({
              ...buildEventBase({
                threadId,
                turnId: activeTurnId,
                raw: { type: "pi.turn.aborted" },
              }),
              type: "turn.aborted",
              payload: {
                reason: "Interrupted by user.",
              },
            });
          }
        },
      );

      const respondToRequest: PiAdapterShape["respondToRequest"] = Effect.fn("respondToRequest")(
        function* (threadId, requestId, decision) {
          const context = ensureSessionContext(sessions, threadId);
          const pending = context.pendingApprovals.get(requestId);
          if (!pending) {
            return yield* new ProviderAdapterRequestError({
              provider: PROVIDER,
              method: "approval.reply",
              detail: `Unknown pending approval request: ${requestId}`,
            });
          }
          context.pendingApprovals.delete(requestId);
          if (decision === "acceptForSession") {
            context.acceptedForSession.add(pending.requestType);
          }
          pending.resolve(decision);
          yield* offerEvent({
            ...buildEventBase({
              threadId,
              turnId: pending.turnId,
              requestId,
              raw: { type: "pi.approval.resolved", decision },
            }),
            type: "request.resolved",
            payload: {
              requestType: pending.requestType,
              decision: requestDecisionLabel(decision),
            },
          });
        },
      );

      const respondToUserInput: PiAdapterShape["respondToUserInput"] = Effect.fn(
        "respondToUserInput",
      )(function* (threadId, requestId, answers) {
        const context = ensureSessionContext(sessions, threadId);
        const pending = context.pendingUserInputs.get(requestId);
        if (!pending) {
          return yield* new ProviderAdapterRequestError({
            provider: PROVIDER,
            method: "user-input.reply",
            detail: `Unknown pending user-input request: ${requestId}`,
          });
        }
        context.pendingUserInputs.delete(requestId);
        pending.resolve(answers);
        yield* offerEvent({
          ...buildEventBase({
            threadId,
            turnId: pending.turnId,
            requestId,
            raw: { type: "pi.user-input.resolved", answers },
          }),
          type: "user-input.resolved",
          payload: {
            answers,
          },
        });
      });

      const stopSession: PiAdapterShape["stopSession"] = Effect.fn("stopSession")(
        function* (threadId) {
          const context = ensureSessionContext(sessions, threadId);
          yield* stopPiContext(context);
          sessions.delete(threadId);
        },
      );

      const listSessions: PiAdapterShape["listSessions"] = () =>
        Effect.sync(() => [...sessions.values()].map((context) => context.session));

      const hasSession: PiAdapterShape["hasSession"] = (threadId) =>
        Effect.sync(() => sessions.has(threadId));

      const readThread: PiAdapterShape["readThread"] = (threadId) =>
        Effect.sync(() => {
          const context = ensureSessionContext(sessions, threadId);
          return {
            threadId,
            turns: [...context.turns].map((turn) => ({
              id: turn.id,
              items: [...turn.items],
            })),
          };
        });

      const rollbackThread: PiAdapterShape["rollbackThread"] = Effect.fn("rollbackThread")(
        function* (threadId, numTurns) {
          const context = ensureSessionContext(sessions, threadId);
          if (context.activeTurn) {
            return yield* new ProviderAdapterValidationError({
              provider: PROVIDER,
              operation: "rollbackThread",
              issue: "Cannot roll back a Pi thread while a turn is running.",
            });
          }
          if (numTurns <= 0) {
            return {
              threadId,
              turns: [...context.turns].map((turn) => ({
                id: turn.id,
                items: [...turn.items],
              })),
            };
          }

          const retainedCount = Math.max(0, context.turns.length - numTurns);
          const retainedTurn = retainedCount > 0 ? context.turns[retainedCount - 1] : undefined;
          yield* clearPendingInteractiveState(context);
          context.acceptedForSession.clear();

          yield* Effect.tryPromise({
            try: () =>
              retainedTurn
                ? context.handle.runtime.fork(retainedTurn.leafEntryId, { position: "at" })
                : context.handle.runtime.newSession(),
            catch: (cause) => toRequestError(threadId, "runtime.rollback", cause),
          });
          yield* Effect.tryPromise({
            try: () => rebindContextSession(context),
            catch: (cause) => toProcessError(threadId, cause),
          });

          context.turns.splice(0, context.turns.length, ...rebuildPiTurnsFromSession(context));
          context.activeTurn = undefined;
          const resumeCursor = createPiResumeCursor({
            agentDir: context.handle.agentDir,
            sessionDir: context.handle.sessionDir,
            session: context.handle.runtime.session,
          });
          context.session = {
            ...context.session,
            status: "ready",
            activeTurnId: undefined,
            ...(resumeCursor ? { resumeCursor } : {}),
            updatedAt: nowIso(),
          };

          return {
            threadId,
            turns: context.turns.map((turn) => ({
              id: turn.id,
              items: [...turn.items],
            })),
          };
        },
      );

      const stopAll: PiAdapterShape["stopAll"] = () =>
        Effect.gen(function* () {
          const contexts = [...sessions.values()];
          sessions.clear();
          yield* Effect.forEach(contexts, (context) => stopPiContext(context).pipe(Effect.ignore), {
            concurrency: "unbounded",
            discard: true,
          });
        });

      return {
        provider: PROVIDER,
        capabilities: {
          sessionModelSwitch: "in-session",
        },
        startSession,
        sendTurn,
        interruptTurn,
        respondToRequest,
        respondToUserInput,
        stopSession,
        listSessions,
        hasSession,
        readThread,
        rollbackThread,
        stopAll,
        get streamEvents() {
          return Stream.fromQueue(runtimeEvents);
        },
      } satisfies PiAdapterShape;
    }),
  );
}

export const PiAdapterLive = makePiAdapter();

export function makePiAdapterLive(options?: PiAdapterLiveOptions) {
  return makePiAdapter(options);
}
