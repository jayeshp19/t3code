import { z } from "zod";
import { projectScriptSchema } from "./project";

export const STATE_DEFAULT_TERMINAL_ID = "default";
export const STATE_DEFAULT_TERMINAL_HEIGHT = 280;

export const stateThreadTerminalGroupSchema = z.object({
  id: z.string().trim().min(1),
  terminalIds: z.array(z.string().trim().min(1)).min(1).max(4),
});

export const stateMessageImageAttachmentSchema = z.object({
  type: z.literal("image"),
  id: z.string().min(1),
  name: z.string().min(1),
  mimeType: z.string().min(1),
  sizeBytes: z.number().int().min(1),
});

export const stateMessageAttachmentSchema = z.discriminatedUnion("type", [
  stateMessageImageAttachmentSchema,
]);

export const stateMessageSchema = z.object({
  id: z.string().min(1),
  threadId: z.string().min(1),
  role: z.enum(["user", "assistant"]),
  text: z.string(),
  attachments: z.array(stateMessageAttachmentSchema).optional(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
  streaming: z.boolean().default(false),
});

export const stateTurnDiffFileChangeSchema = z.object({
  path: z.string().min(1),
  kind: z.string().min(1).optional(),
  additions: z.number().int().min(0).optional(),
  deletions: z.number().int().min(0).optional(),
});

export const stateTurnSummarySchema = z.object({
  turnId: z.string().min(1),
  completedAt: z.string().datetime(),
  status: z.string().min(1).optional(),
  files: z.array(stateTurnDiffFileChangeSchema).default([]),
  assistantMessageId: z.string().min(1).optional(),
  checkpointTurnCount: z.number().int().min(0).optional(),
});

export const stateProjectSchema = z.object({
  id: z.string().min(1),
  cwd: z.string().min(1),
  name: z.string().min(1),
  scripts: z.array(projectScriptSchema).default([]),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});

export const stateThreadSchema = z.object({
  id: z.string().min(1),
  codexThreadId: z.string().min(1).nullable().default(null),
  projectId: z.string().min(1),
  title: z.string().min(1),
  model: z.string().min(1),
  terminalOpen: z.boolean().default(false),
  terminalHeight: z.number().int().min(120).max(4_096).default(STATE_DEFAULT_TERMINAL_HEIGHT),
  terminalIds: z
    .array(z.string().trim().min(1))
    .max(4)
    .default([STATE_DEFAULT_TERMINAL_ID]),
  runningTerminalIds: z.array(z.string().trim().min(1)).max(4).default([]),
  activeTerminalId: z.string().trim().min(1).default(STATE_DEFAULT_TERMINAL_ID),
  terminalGroups: z.array(stateThreadTerminalGroupSchema).default([]),
  activeTerminalGroupId: z
    .string()
    .trim()
    .min(1)
    .default(`group-${STATE_DEFAULT_TERMINAL_ID}`),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
  lastVisitedAt: z.string().datetime().optional(),
  latestTurnId: z.string().min(1).optional(),
  latestTurnStartedAt: z.string().datetime().optional(),
  latestTurnCompletedAt: z.string().datetime().optional(),
  latestTurnDurationMs: z.number().int().min(0).optional(),
  branch: z.string().min(1).nullable().default(null),
  worktreePath: z.string().min(1).nullable().default(null),
  turnDiffSummaries: z.array(stateTurnSummarySchema).default([]),
});

export const stateBootstrapThreadSchema = stateThreadSchema.extend({
  messages: z.array(stateMessageSchema).default([]),
});

export const stateBootstrapResultSchema = z.object({
  projects: z.array(stateProjectSchema),
  threads: z.array(stateBootstrapThreadSchema),
  lastStateSeq: z.number().int().min(0),
});

export const stateCatchUpInputSchema = z.object({
  afterSeq: z.number().int().min(0).default(0),
});

const stateEventBaseSchema = z.object({
  seq: z.number().int().positive(),
  entityId: z.string().min(1),
  createdAt: z.string().datetime(),
});

export const stateProjectUpsertPayloadSchema = z.object({
  project: stateProjectSchema,
});

export const stateProjectDeletePayloadSchema = z.object({
  projectId: z.string().min(1),
});

export const stateThreadUpsertPayloadSchema = z.object({
  thread: stateThreadSchema,
});

export const stateThreadDeletePayloadSchema = z.object({
  threadId: z.string().min(1),
});

export const stateMessageUpsertPayloadSchema = z.object({
  threadId: z.string().min(1),
  message: stateMessageSchema,
});

export const stateMessageDeletePayloadSchema = z.object({
  threadId: z.string().min(1),
  messageId: z.string().min(1),
});

export const stateTurnSummaryUpsertPayloadSchema = z.object({
  threadId: z.string().min(1),
  turnSummary: stateTurnSummarySchema,
});

export const stateTurnSummaryDeletePayloadSchema = z.object({
  threadId: z.string().min(1),
  turnId: z.string().min(1),
});

export const stateEventSchema = z.discriminatedUnion("eventType", [
  stateEventBaseSchema.extend({
    eventType: z.literal("project.upsert"),
    payload: stateProjectUpsertPayloadSchema,
  }),
  stateEventBaseSchema.extend({
    eventType: z.literal("project.delete"),
    payload: stateProjectDeletePayloadSchema,
  }),
  stateEventBaseSchema.extend({
    eventType: z.literal("thread.upsert"),
    payload: stateThreadUpsertPayloadSchema,
  }),
  stateEventBaseSchema.extend({
    eventType: z.literal("thread.delete"),
    payload: stateThreadDeletePayloadSchema,
  }),
  stateEventBaseSchema.extend({
    eventType: z.literal("message.upsert"),
    payload: stateMessageUpsertPayloadSchema,
  }),
  stateEventBaseSchema.extend({
    eventType: z.literal("message.delete"),
    payload: stateMessageDeletePayloadSchema,
  }),
  stateEventBaseSchema.extend({
    eventType: z.literal("turn_summary.upsert"),
    payload: stateTurnSummaryUpsertPayloadSchema,
  }),
  stateEventBaseSchema.extend({
    eventType: z.literal("turn_summary.delete"),
    payload: stateTurnSummaryDeletePayloadSchema,
  }),
]);

export const stateCatchUpResultSchema = z.object({
  events: z.array(stateEventSchema),
  lastStateSeq: z.number().int().min(0),
});

export const stateListMessagesInputSchema = z.object({
  threadId: z.string().min(1),
  offset: z.number().int().min(0).default(0),
  limit: z.number().int().min(1).max(500).default(200),
});

export const stateListMessagesResultSchema = z.object({
  messages: z.array(stateMessageSchema),
  total: z.number().int().min(0),
  nextOffset: z.number().int().min(0).nullable(),
});

export const threadsCreateInputSchema = z.object({
  projectId: z.string().min(1),
  title: z.string().trim().min(1).optional(),
  model: z.string().trim().min(1).optional(),
  branch: z.string().trim().min(1).nullable().optional(),
  worktreePath: z.string().trim().min(1).nullable().optional(),
  terminalOpen: z.boolean().optional(),
  terminalHeight: z.number().int().min(120).max(4_096).optional(),
  terminalIds: z.array(z.string().trim().min(1)).max(4).optional(),
  activeTerminalId: z.string().trim().min(1).optional(),
  terminalGroups: z.array(stateThreadTerminalGroupSchema).optional(),
  activeTerminalGroupId: z.string().trim().min(1).optional(),
});

export const threadsUpdateTitleInputSchema = z.object({
  threadId: z.string().min(1),
  title: z.string().trim().min(1),
});

export const threadsUpdateModelInputSchema = z.object({
  threadId: z.string().min(1),
  model: z.string().trim().min(1),
});

export const threadsDeleteInputSchema = z.object({
  threadId: z.string().min(1),
});

export const threadsMarkVisitedInputSchema = z.object({
  threadId: z.string().min(1),
  visitedAt: z.string().datetime().optional(),
});

export const threadsUpdateBranchInputSchema = z.object({
  threadId: z.string().min(1),
  branch: z.string().trim().min(1).nullable(),
  worktreePath: z.string().trim().min(1).nullable(),
});

export const threadsUpdateTerminalStateInputSchema = z
  .object({
    threadId: z.string().min(1),
    terminalOpen: z.boolean().optional(),
    terminalHeight: z.number().int().min(120).max(4_096).optional(),
    terminalIds: z.array(z.string().trim().min(1)).max(4).optional(),
    runningTerminalIds: z.array(z.string().trim().min(1)).max(4).optional(),
    activeTerminalId: z.string().trim().min(1).optional(),
    terminalGroups: z.array(stateThreadTerminalGroupSchema).optional(),
    activeTerminalGroupId: z.string().trim().min(1).optional(),
  })
  .superRefine((value, ctx) => {
    const hasAnyUpdate = Object.keys(value).some((key) => key !== "threadId");
    if (!hasAnyUpdate) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "At least one terminal field must be provided",
        path: ["threadId"],
      });
    }
  });

export const threadsUpdateResultSchema = z.object({
  thread: stateThreadSchema,
});

export type StateThreadTerminalGroup = z.infer<typeof stateThreadTerminalGroupSchema>;
export type StateMessageImageAttachment = z.infer<typeof stateMessageImageAttachmentSchema>;
export type StateMessageAttachment = z.infer<typeof stateMessageAttachmentSchema>;
export type StateMessage = z.infer<typeof stateMessageSchema>;
export type StateTurnDiffFileChange = z.infer<typeof stateTurnDiffFileChangeSchema>;
export type StateTurnSummary = z.infer<typeof stateTurnSummarySchema>;
export type StateProject = z.infer<typeof stateProjectSchema>;
export type StateThread = z.infer<typeof stateThreadSchema>;
export type StateBootstrapThread = z.infer<typeof stateBootstrapThreadSchema>;
export type StateBootstrapResult = z.infer<typeof stateBootstrapResultSchema>;
export type StateCatchUpInput = z.input<typeof stateCatchUpInputSchema>;
export type StateProjectUpsertPayload = z.infer<typeof stateProjectUpsertPayloadSchema>;
export type StateProjectDeletePayload = z.infer<typeof stateProjectDeletePayloadSchema>;
export type StateThreadUpsertPayload = z.infer<typeof stateThreadUpsertPayloadSchema>;
export type StateThreadDeletePayload = z.infer<typeof stateThreadDeletePayloadSchema>;
export type StateMessageUpsertPayload = z.infer<typeof stateMessageUpsertPayloadSchema>;
export type StateMessageDeletePayload = z.infer<typeof stateMessageDeletePayloadSchema>;
export type StateTurnSummaryUpsertPayload = z.infer<typeof stateTurnSummaryUpsertPayloadSchema>;
export type StateTurnSummaryDeletePayload = z.infer<typeof stateTurnSummaryDeletePayloadSchema>;
export type StateEvent = z.infer<typeof stateEventSchema>;
export type StateCatchUpResult = z.infer<typeof stateCatchUpResultSchema>;
export type StateListMessagesInput = z.input<typeof stateListMessagesInputSchema>;
export type StateListMessagesResult = z.infer<typeof stateListMessagesResultSchema>;
export type ThreadsCreateInput = z.input<typeof threadsCreateInputSchema>;
export type ThreadsUpdateTitleInput = z.input<typeof threadsUpdateTitleInputSchema>;
export type ThreadsUpdateModelInput = z.input<typeof threadsUpdateModelInputSchema>;
export type ThreadsDeleteInput = z.input<typeof threadsDeleteInputSchema>;
export type ThreadsMarkVisitedInput = z.input<typeof threadsMarkVisitedInputSchema>;
export type ThreadsUpdateBranchInput = z.input<typeof threadsUpdateBranchInputSchema>;
export type ThreadsUpdateTerminalStateInput = z.input<typeof threadsUpdateTerminalStateInputSchema>;
export type ThreadsUpdateResult = z.infer<typeof threadsUpdateResultSchema>;
