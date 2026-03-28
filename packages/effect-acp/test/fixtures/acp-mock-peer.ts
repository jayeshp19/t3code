import { createInterface } from "node:readline";

const rl = createInterface({
  input: process.stdin,
  crlfDelay: Infinity,
});

if (process.env.ACP_MOCK_MALFORMED_OUTPUT === "1") {
  process.stdout.write("{not-json}\n");
  process.exit(Number(process.env.ACP_MOCK_MALFORMED_OUTPUT_EXIT_CODE ?? "0"));
}

if (process.env.ACP_MOCK_EXIT_IMMEDIATELY_CODE !== undefined) {
  process.exit(Number(process.env.ACP_MOCK_EXIT_IMMEDIATELY_CODE));
}

let nextRequestId = 1000;
const pending = new Map<
  number | string,
  { resolve: (value: unknown) => void; reject: (error: unknown) => void }
>();

function writeMessage(message: unknown) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  if (
    typeof error === "object" &&
    error !== null &&
    "message" in error &&
    typeof error.message === "string"
  ) {
    return error.message;
  }
  return String(error);
}

function respond(id: number | string | null | undefined, result: unknown) {
  writeMessage({
    jsonrpc: "2.0",
    id,
    result,
  });
}

function respondError(
  id: number | string | null | undefined,
  code: number,
  message: string,
  data?: unknown,
) {
  writeMessage({
    jsonrpc: "2.0",
    id,
    error: {
      code,
      message,
      ...(data !== undefined ? { data } : {}),
    },
  });
}

function notify(method: string, params?: unknown) {
  writeMessage({
    jsonrpc: "2.0",
    method,
    ...(params !== undefined ? { params } : {}),
  });
}

function requestClient(method: string, params?: unknown) {
  const id = nextRequestId++;
  writeMessage({
    jsonrpc: "2.0",
    id,
    method,
    ...(params !== undefined ? { params } : {}),
  });
  return new Promise<unknown>((resolve, reject) => {
    pending.set(id, { resolve, reject });
  });
}

async function handleRequest(message: {
  readonly id: number | string | null;
  readonly method: string;
  readonly params?: unknown;
}) {
  switch (message.method) {
    case "initialize":
      respond(message.id, {
        protocolVersion: 1,
        agentCapabilities: {
          sessionCapabilities: {
            list: {},
          },
        },
        agentInfo: {
          name: "mock-agent",
          version: "0.0.0",
        },
      });
      return;
    case "authenticate":
      respond(message.id, {});
      return;
    case "logout":
      respond(message.id, {});
      return;
    case "session/new":
      respond(message.id, {
        sessionId: "mock-session-1",
      });
      return;
    case "session/load":
      respond(message.id, {});
      return;
    case "session/list":
      respond(message.id, {
        sessions: [
          {
            sessionId: "mock-session-1",
            cwd: process.cwd(),
          },
        ],
      });
      return;
    case "session/prompt": {
      await requestClient("session/request_permission", {
        sessionId: "mock-session-1",
        options: [
          {
            optionId: "allow",
            name: "Allow",
            kind: "allow_once",
          },
        ],
        toolCall: {
          toolCallId: "tool-1",
          title: "Read project files",
        },
      });

      await requestClient("session/elicitation", {
        sessionId: "mock-session-1",
        message: "Need confirmation before continuing.",
        mode: "form",
        requestedSchema: {
          type: "object",
          title: "Need confirmation",
          properties: {
            approved: {
              type: "boolean",
              title: "Approved",
            },
          },
          required: ["approved"],
        },
      });

      notify("session/update", {
        sessionId: "mock-session-1",
        update: {
          sessionUpdate: "plan",
          entries: [
            {
              content: "Inspect the repository",
              priority: "high",
              status: "in_progress",
            },
          ],
        },
      });

      notify("session/elicitation/complete", {
        elicitationId: "elicitation-1",
      });

      await requestClient("x/typed_request", {
        message: process.env.ACP_MOCK_BAD_TYPED_REQUEST === "1" ? 123 : "hello from typed request",
      });

      notify("x/typed_notification", {
        count: 2,
      });

      respond(message.id, {
        stopReason: "end_turn",
      });
      return;
    }
    default:
      respond(message.id, {
        echoedMethod: message.method,
        echoedParams: message.params ?? null,
      });
      return;
  }
}

function handleResponse(message: {
  readonly id: number | string | null;
  readonly result?: unknown;
  readonly error?: { readonly code: number; readonly message: string; readonly data?: unknown };
}) {
  const pendingRequest = pending.get(message.id ?? "");
  if (!pendingRequest) {
    return;
  }
  pending.delete(message.id ?? "");
  if (message.error) {
    pendingRequest.reject(message.error);
  } else {
    pendingRequest.resolve(message.result);
  }
}

rl.on("line", (line) => {
  const trimmed = line.trim();
  if (trimmed.length === 0) {
    return;
  }

  const message = JSON.parse(trimmed) as
    | { readonly id: number | string | null; readonly method: string; readonly params?: unknown }
    | {
        readonly id: number | string | null;
        readonly result?: unknown;
        readonly error?: {
          readonly code: number;
          readonly message: string;
          readonly data?: unknown;
        };
      }
    | { readonly method: string; readonly params?: unknown };

  if ("method" in message && "id" in message) {
    void handleRequest(message).catch((error) => {
      respondError(message.id, -32603, errorMessage(error));
    });
    return;
  }

  if ("id" in message && ("result" in message || "error" in message)) {
    handleResponse(message);
    return;
  }

  if ("method" in message && !("id" in message)) {
    return;
  }
});
