import { describe, expect, it } from "vitest";

import {
  stateBootstrapResultSchema,
  stateCatchUpInputSchema,
  stateEventSchema,
  stateListMessagesInputSchema,
  stateListMessagesResultSchema,
  stateMessageSchema,
  stateThreadSchema,
  threadsCreateInputSchema,
  threadsUpdateTerminalStateInputSchema,
  threadsUpdateTitleInputSchema,
} from "./state";

describe("state schemas", () => {
  it("applies defaults for state thread records", () => {
    const parsed = stateThreadSchema.parse({
      id: "thread-1",
      projectId: "project-1",
      title: "Thread",
      model: "gpt-5-codex",
      createdAt: "2026-02-19T00:00:00.000Z",
      updatedAt: "2026-02-19T00:00:00.000Z",
    });

    expect(parsed.codexThreadId).toBeNull();
    expect(parsed.terminalIds).toEqual(["default"]);
    expect(parsed.activeTerminalId).toBe("default");
    expect(parsed.turnDiffSummaries).toEqual([]);
  });

  it("validates bootstrap payloads", () => {
    const parsed = stateBootstrapResultSchema.parse({
      projects: [
        {
          id: "project-1",
          cwd: "/repo",
          name: "repo",
          scripts: [],
          createdAt: "2026-02-19T00:00:00.000Z",
          updatedAt: "2026-02-19T00:00:00.000Z",
        },
      ],
      threads: [
        {
          id: "thread-1",
          projectId: "project-1",
          title: "Thread",
          model: "gpt-5-codex",
          createdAt: "2026-02-19T00:00:00.000Z",
          updatedAt: "2026-02-19T00:00:00.000Z",
          messages: [],
        },
      ],
      lastStateSeq: 12,
    });

    expect(parsed.lastStateSeq).toBe(12);
    expect(parsed.threads[0]?.messages).toEqual([]);
  });

  it("validates message pagination result payloads", () => {
    const message = stateMessageSchema.parse({
      id: "msg-1",
      threadId: "thread-1",
      role: "assistant",
      text: "Hello",
      createdAt: "2026-02-19T00:00:00.000Z",
      updatedAt: "2026-02-19T00:00:00.000Z",
      streaming: false,
    });

    const result = stateListMessagesResultSchema.parse({
      messages: [message],
      total: 1,
      nextOffset: null,
    });

    expect(result.total).toBe(1);
    expect(result.nextOffset).toBeNull();
  });

  it("enforces at least one terminal field on terminal updates", () => {
    expect(() =>
      threadsUpdateTerminalStateInputSchema.parse({
        threadId: "thread-1",
      }),
    ).toThrow();

    const parsed = threadsUpdateTerminalStateInputSchema.parse({
      threadId: "thread-1",
      terminalOpen: true,
    });
    expect(parsed.terminalOpen).toBe(true);
  });

  it("parses thread create/title inputs and state pagination defaults", () => {
    const created = threadsCreateInputSchema.parse({
      projectId: "project-1",
    });
    expect(created.projectId).toBe("project-1");

    const titled = threadsUpdateTitleInputSchema.parse({
      threadId: "thread-1",
      title: "New title",
    });
    expect(titled.title).toBe("New title");

    const listInput = stateListMessagesInputSchema.parse({
      threadId: "thread-1",
    });
    expect(listInput.offset).toBe(0);
    expect(listInput.limit).toBe(200);
  });

  it("parses state catch-up payloads", () => {
    const catchUp = stateCatchUpInputSchema.parse({});
    expect(catchUp.afterSeq).toBe(0);
  });

  it("validates typed state event payload variants", () => {
    const event = stateEventSchema.parse({
      seq: 1,
      eventType: "project.upsert",
      entityId: "project-1",
      payload: {
        project: {
          id: "project-1",
          cwd: "/repo",
          name: "repo",
          scripts: [],
          createdAt: "2026-02-19T00:00:00.000Z",
          updatedAt: "2026-02-19T00:00:00.000Z",
        },
      },
      createdAt: "2026-02-19T00:00:00.000Z",
    });

    expect(event.eventType).toBe("project.upsert");
    if (event.eventType === "project.upsert") {
      expect(event.payload.project.id).toBe("project-1");
    }
  });
});
