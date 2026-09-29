import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TestWebSocketServer, type TestWebSocket } from "../helpers/ws-server.js";
import { RuntimeConnectionManager } from "../../src/runtime/cdp-client.js";
import { registerRuntimeTools, type RuntimeToolController } from "../../src/tools/runtime-tools.js";
import { MockServer } from "../mocks/mock-server.js";

interface FakeCdpOptions {
  bridgeReadyAfter?: number;
  resultAfter?: number;
  bridgeResult?: { ok: boolean; value?: unknown; error?: string };
  commandValues?: Record<string, unknown[]>;
  expressionValues?: unknown[];
  includePageTarget?: boolean;
  canvasGeometry?: Record<string, number> | null;
  resultResponseDelayMs?: number;
  /** Answer Page.captureScreenshot with this many image bytes instead of the echoed parameters. */
  screenshotBytes?: number;
  /** What bridge.cancel(id) answers; "absent" plays a bridge without cancel. */
  cancelAnswer?: "queued" | "result" | false | "absent";
  /**
   * The page targets /json/list shows, in order (default: one page with the
   * bridge on the page). A page's bridge can live on the page, in a
   * dedicated worker the client reaches through Target.setAutoAttach, or
   * nowhere; a page can be hidden, and Page.bringToFront can make it visible.
   */
  pages?: FakePage[];
}

interface FakePage {
  id: string;
  url?: string;
  bridge?: "page" | "worker" | "none";
  hidden?: boolean;
  frontMakesVisible?: boolean;
}

interface FakeCdp {
  endpoint: string;
  port: number;
  connectionCount: () => number;
  activeConnectionCount: () => number;
  commandCount: (command: string) => number;
  cdpCommands: () => Array<{ method: string; params: Record<string, unknown> }>;
  /** How many page expressions (wait_for_condition type "expression") were evaluated. */
  expressionCount: () => number;
  /** The command IDs bridge.cancel was called with. */
  cancelled: () => number[];
  /** Connection housekeeping calls (Target.setAutoAttach, Page.bringToFront), kept apart from cdpCommands. */
  housekeeping: () => Array<{ page: string; method: string }>;
  /** The CDP session each bridge.submit was evaluated in ("page" for the page itself). */
  submitSessions: () => string[];
  close(): Promise<void>;
}

async function startFakeCdp(options: FakeCdpOptions = {}): Promise<FakeCdp> {
  let port = 0;
  let stateChecks = 0;
  let expressionChecks = 0;
  const cancelledIds: number[] = [];
  const housekeeping: Array<{ page: string; method: string }> = [];
  const submitSessions: string[] = [];
  const pages: FakePage[] = options.pages ?? [{ id: "page-1", url: "http://localhost/game", bridge: "page" }];
  let nextCommandId = 17;
  const resultChecks = new Map<number, number>();
  const submittedResults = new Map<number, { ok: boolean; value?: unknown; error?: string }>();
  const commandCounts = new Map<string, number>();
  const cdpCommands: Array<{ method: string; params: Record<string, unknown> }> = [];
  let connectionCount = 0;
  const sockets = new Set<TestWebSocket>();
  const webSockets = new TestWebSocketServer();
  const httpServer = createServer((request, response) => {
    if (request.url !== "/json/list") {
      response.writeHead(404).end();
      return;
    }
    const targets = options.includePageTarget === false
      ? [{ id: "worker-1", type: "worker", title: "Worker" }]
      : pages.map((page) => ({
        id: page.id,
        type: "page",
        title: page.id === "page-1" ? "Construct Preview" : page.id,
        url: page.url ?? "http://localhost/game",
        webSocketDebuggerUrl: `ws://127.0.0.1:${port}/devtools/page/${page.id}`,
      }));
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify(targets));
  });

  httpServer.on("upgrade", (request, socket, head) => {
    if (!pages.some((page) => request.url === `/devtools/page/${page.id}`)) {
      socket.destroy();
      return;
    }
    webSockets.handleUpgrade(request, socket, head, (webSocket) => {
      webSockets.emit("connection", webSocket, request);
    });
  });

  webSockets.on("connection", (socket: TestWebSocket, upgrade: { url?: string }) => {
    connectionCount++;
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    const page = pages.find((candidate) => upgrade.url === `/devtools/page/${candidate.id}`)!;
    let visible = page.hidden !== true;
    socket.on("message", (raw: Buffer) => {
      const request = JSON.parse(raw.toString()) as {
        id: number;
        method: string;
        sessionId?: string;
        params?: Record<string, unknown> & { expression?: string };
      };
      const answer = (result: unknown) => socket.send(JSON.stringify({ id: request.id, result, ...(request.sessionId ? { sessionId: request.sessionId } : {}) }));
      if (request.method === "Target.setAutoAttach" || request.method === "Page.bringToFront") {
        housekeeping.push({ page: page.id, method: request.method });
        answer({});
        if (request.method === "Page.bringToFront" && page.frontMakesVisible) visible = true;
        if (request.method === "Target.setAutoAttach" && page.bridge === "worker") {
          socket.send(JSON.stringify({
            method: "Target.attachedToTarget",
            params: {
              sessionId: "worker-session-1",
              targetInfo: { targetId: "worker-target-1", type: "worker", url: "http://localhost/game/worker.js" },
              waitingForDebugger: false,
            },
          }));
        }
        return;
      }
      if (request.method !== "Runtime.evaluate") {
        cdpCommands.push({ method: request.method, params: request.params ?? {} });
        // A screenshot answers with the parameters it was given, so a test can
        // read the format and clip back out of the "image" file.
        const result = request.method !== "Page.captureScreenshot"
          ? {}
          : options.screenshotBytes !== undefined
            ? { data: Buffer.alloc(options.screenshotBytes, 0x5a).toString("base64") }
            : { data: Buffer.from(`image:${JSON.stringify(request.params ?? {})}`).toString("base64") };
        socket.send(JSON.stringify({ id: request.id, result }));
        return;
      }

      const expression = request.params?.expression ?? "";
      const context = request.sessionId === "worker-session-1" ? "worker" : "page";
      const bridgeHere = (page.bridge ?? "page") === context;
      let value: string;
      if (expression.includes("document.visibilityState")) {
        value = JSON.stringify(visible ? "visible" : "hidden");
      } else if (!bridgeHere && expression.includes("__c3bridge")) {
        value = JSON.stringify(null);
      } else if (expression.includes("(0, eval)")) {
        const values = options.expressionValues ?? [null];
        const expressionValue = values[Math.min(expressionChecks, values.length - 1)];
        expressionChecks++;
        value = JSON.stringify({ value: expressionValue });
      } else if (expression.includes("getBoundingClientRect")) {
        value = JSON.stringify(options.canvasGeometry === undefined ? null : options.canvasGeometry);
      } else if (expression.includes("bridge.getState")) {
        stateChecks++;
        const ready = stateChecks > (options.bridgeReadyAfter ?? 0);
        value = JSON.stringify(ready ? {
          ready: true,
          layoutName: "Game",
          tickCount: 42,
          gameTime: 1.5,
          dt: 1 / 60,
          objectCount: 7,
        } : null);
      } else if (expression.includes("bridge.submit")) {
        submitSessions.push(request.sessionId ?? "page");
        const commandLiteral = expression.match(/bridge\.submit\(("(?:\\.|[^"\\])*")/u)?.[1];
        const command = commandLiteral ? JSON.parse(commandLiteral) as string : "unknown";
        const commandIndex = commandCounts.get(command) ?? 0;
        commandCounts.set(command, commandIndex + 1);
        const values = options.commandValues?.[command];
        const commandValue = values && values.length > 0
          ? values[Math.min(commandIndex, values.length - 1)]
          : { pong: true };
        const commandId = nextCommandId++;
        submittedResults.set(
          commandId,
          options.bridgeResult ?? { ok: true, value: commandValue },
        );
        value = JSON.stringify({ id: commandId });
      } else if (expression.includes("bridge.cancel")) {
        cancelledIds.push(Number(expression.match(/bridge\.cancel\((\d+)\)/u)?.[1]));
        value = JSON.stringify(options.cancelAnswer === "absent" ? { cancelled: "unsupported" } : { cancelled: options.cancelAnswer ?? "queued" });
      } else if (expression.includes("bridge.getResult")) {
        const commandId = Number(expression.match(/bridge\.getResult\((\d+)\)/u)?.[1]);
        const checks = (resultChecks.get(commandId) ?? 0) + 1;
        resultChecks.set(commandId, checks);
        const ready = checks > (options.resultAfter ?? 0);
        value = JSON.stringify({
          bridgeResult: ready
            ? submittedResults.get(commandId)
            : null,
        });
      } else {
        value = JSON.stringify(null);
      }

      const response = JSON.stringify({
        id: request.id,
        result: {
          result: {
            type: "string",
            value,
          },
        },
        ...(request.sessionId ? { sessionId: request.sessionId } : {}),
      });
      if (expression.includes("bridge.getResult") && options.resultResponseDelayMs) {
        setTimeout(() => {
          if (socket.readyState === socket.OPEN) socket.send(response);
        }, options.resultResponseDelayMs);
      } else {
        socket.send(response);
      }
    });
  });

  await new Promise<void>((resolve, reject) => {
    httpServer.once("error", reject);
    httpServer.listen(0, "127.0.0.1", () => {
      httpServer.off("error", reject);
      resolve();
    });
  });
  port = (httpServer.address() as AddressInfo).port;

  return {
    endpoint: `ws://127.0.0.1:${port}/devtools/page/page-1`,
    port,
    connectionCount: () => connectionCount,
    activeConnectionCount: () => sockets.size,
    commandCount: (command) => commandCounts.get(command) ?? 0,
    expressionCount: () => expressionChecks,
    cancelled: () => [...cancelledIds],
    housekeeping: () => [...housekeeping],
    submitSessions: () => [...submitSessions],
    cdpCommands: () => cdpCommands.map((command) => ({
      method: command.method,
      params: { ...command.params },
    })),
    async close() {
      for (const socket of sockets) socket.terminate();
      await new Promise<void>((resolve) => webSockets.close(() => resolve()));
      await new Promise<void>((resolve, reject) => {
        httpServer.close((error) => error ? reject(error) : resolve());
      });
    },
  };
}

function parseToolResult(result: {
  content: Array<{ type: string; text: string }>;
  isError?: boolean;
}): Record<string, any> {
  expect(result.isError).toBeUndefined();
  return JSON.parse(result.content[0].text) as Record<string, any>;
}

/** Where the tests' open project is: a folder no test writes into, unless a test passes its own. */
const NO_PROJECT_DIR = join(tmpdir(), "c3mcp-cdp-test-project");

function registerConnectionTools(projectDir = NO_PROJECT_DIR): {
  server: MockServer;
  controller: RuntimeToolController;
} {
  const server = new MockServer();
  const controller = registerRuntimeTools({
    server: server as never,
    reader: { getProjectDir: () => projectDir } as any,
    writer: {} as any,
  });
  return { server, controller };
}

const openFakes: FakeCdp[] = [];
const openControllers: RuntimeToolController[] = [];

afterEach(async () => {
  vi.unstubAllEnvs();
  while (openControllers.length > 0) await openControllers.pop()!.close();
  while (openFakes.length > 0) await openFakes.pop()!.close();
});

describe("connect_to_game", () => {
  it("discovers a page target, waits for the bridge, and keeps the connection", async () => {
    const fake = await startFakeCdp({ bridgeReadyAfter: 1, resultAfter: 1 });
    openFakes.push(fake);
    const { server, controller } = registerConnectionTools();
    openControllers.push(controller);

    const connected = parseToolResult(await server.callTool("connect_to_game", {
      host: "127.0.0.1",
      port: fake.port,
      timeoutMs: 1_000,
    }));
    expect(connected.connectionId).toMatch(/^[0-9a-f-]{36}$/u);
    expect(connected.bridgeReady).toBe(true);
    expect(connected.gameState).toMatchObject({
      ready: true,
      layoutName: "Game",
      tickCount: 42,
      objectCount: 7,
    });
    expect(connected.target).toEqual({
      id: "page-1",
      title: "Construct Preview",
      url: "http://localhost/game",
    });

    const called = parseToolResult(await server.callTool("call_bridge", {
      connectionId: connected.connectionId,
      command: "ping",
      pollIntervalMs: 10,
      timeoutMs: 500,
    }));
    expect(called.commandId).toBe(17);
    expect(called.result).toEqual({ pong: true });
    expect(called.elapsedMs).toBeGreaterThanOrEqual(0);
    expect(fake.connectionCount()).toBe(1);

    const disconnected = parseToolResult(await server.callTool("disconnect_from_game", {
      connectionId: connected.connectionId,
    }));
    expect(disconnected).toEqual({
      connectionId: connected.connectionId,
      disconnected: true,
    });
  });

  it("refuses a host off this machine unless the server environment allows it", async () => {
    const { server, controller } = registerConnectionTools();
    openControllers.push(controller);
    vi.stubEnv("C3MCP_ALLOW_REMOTE_CDP", undefined);

    const byHost = await server.callTool("connect_to_game", { host: "10.1.2.3", port: 1, timeoutMs: 200 });
    expect(byHost.isError).toBe(true);
    expect(byHost.content[0].text).toContain("C3MCP_ALLOW_REMOTE_CDP=1");
    expect(byHost.content[0].text).toContain("10.1.2.3");

    const byEndpoint = await server.callTool("connect_to_game", { cdpEndpoint: "ws://example.com:9222/devtools/page/1", timeoutMs: 200 });
    expect(byEndpoint.isError).toBe(true);
    expect(byEndpoint.content[0].text).toContain("C3MCP_ALLOW_REMOTE_CDP=1");
    expect(byEndpoint.content[0].text).toContain("example.com");

    // The caller cannot lift the limit: a tool parameter for it does not exist.
    const asked = await server.callTool("connect_to_game", { host: "10.1.2.3", port: 1, timeoutMs: 200, allowRemoteHost: true });
    expect(asked.isError).toBe(true);
    expect(asked.content[0].text).toContain("C3MCP_ALLOW_REMOTE_CDP=1");

    // Loopback spellings pass the guard and fail only on the connection itself.
    for (const host of ["localhost", "127.0.0.1", "::1"]) {
      const attempt = await server.callTool("connect_to_game", { host, port: 1, timeoutMs: 200 });
      expect(attempt.isError).toBe(true);
      expect(attempt.content[0].text).not.toContain("C3MCP_ALLOW_REMOTE_CDP");
    }

    // Allowed by the environment, the remote host is attempted and fails on the connection, not the guard.
    vi.stubEnv("C3MCP_ALLOW_REMOTE_CDP", "1");
    const allowed = await server.callTool("connect_to_game", { host: "10.1.2.3", port: 1, timeoutMs: 200 });
    expect(allowed.isError).toBe(true);
    expect(allowed.content[0].text).not.toContain("C3MCP_ALLOW_REMOTE_CDP");
  });

  it("reaches a bridge that runs in a dedicated worker, and keeps input on the page", async () => {
    const fake = await startFakeCdp({ pages: [{ id: "page-1", bridge: "worker" }], canvasGeometry: { left: 0, top: 0, cssWidth: 100, cssHeight: 100, backingWidth: 100, backingHeight: 100, devicePixelRatio: 1, viewportWidth: 100, viewportHeight: 100 } });
    openFakes.push(fake);
    const { server, controller } = registerConnectionTools();
    openControllers.push(controller);

    const connected = parseToolResult(await server.callTool("connect_to_game", { cdpEndpoint: fake.endpoint, timeoutMs: 1_000 }));
    expect(connected).toMatchObject({ bridgeReady: true, bridgeContext: "worker", gameState: { ready: true } });
    const called = parseToolResult(await server.callTool("call_bridge", { connectionId: connected.connectionId, command: "ping", pollIntervalMs: 10, timeoutMs: 500 }));
    expect(called.result).toEqual({ pong: true });
    expect(fake.submitSessions()).toEqual(["worker-session-1"]);
    parseToolResult(await server.callTool("simulate_input", { connectionId: connected.connectionId, action: { type: "click", x: 5, y: 5 } }));
    expect(fake.cdpCommands().filter((c) => c.method === "Input.dispatchMouseEvent")).toHaveLength(2);
  });

  it("picks the page whose bridge is ready, or the one urlContains names, among several tabs", async () => {
    const fake = await startFakeCdp({
      pages: [
        { id: "editor", url: "https://editor.construct.net/", bridge: "none" },
        { id: "game", url: "http://localhost:8080/index.html", bridge: "page" },
        { id: "other-game", url: "http://localhost:9090/index.html", bridge: "page" },
      ],
    });
    openFakes.push(fake);
    const { server, controller } = registerConnectionTools();
    openControllers.push(controller);

    const first = parseToolResult(await server.callTool("connect_to_game", { host: "127.0.0.1", port: fake.port, timeoutMs: 1_000 }));
    expect(["game", "other-game"]).toContain(first.target.id);
    const named = parseToolResult(await server.callTool("connect_to_game", { host: "127.0.0.1", port: fake.port, urlContains: ":9090/", timeoutMs: 1_000 }));
    expect(named.target.id).toBe("other-game");

    const none = await server.callTool("connect_to_game", { host: "127.0.0.1", port: fake.port, urlContains: "no-such-page", timeoutMs: 300 });
    expect(none.isError).toBe(true);
    expect(none.content[0].text).toContain("no-such-page");
  });

  it("brings the game tab to the front and warns when it stays hidden", async () => {
    for (const [page, warned] of [
      [{ id: "page-1", hidden: true, frontMakesVisible: true }, false],
      [{ id: "page-1", hidden: true }, true],
    ] as const) {
      const fake = await startFakeCdp({ pages: [page] });
      openFakes.push(fake);
      const { server, controller } = registerConnectionTools();
      openControllers.push(controller);
      const connected = parseToolResult(await server.callTool("connect_to_game", { cdpEndpoint: fake.endpoint, timeoutMs: 1_000 }));
      expect(fake.housekeeping().map((h) => h.method)).toContain("Page.bringToFront");
      expect(connected.pageVisible).toBe(!warned);
      if (warned) expect(connected.warning).toMatch(/hidden/u);
      else expect(connected.warning).toBeUndefined();
    }
  });

  it("accepts a direct page WebSocket endpoint", async () => {
    const fake = await startFakeCdp();
    openFakes.push(fake);
    const { server, controller } = registerConnectionTools();
    openControllers.push(controller);

    const connected = parseToolResult(await server.callTool("connect_to_game", {
      cdpEndpoint: fake.endpoint,
      timeoutMs: 500,
    }));
    expect(connected.bridgeReady).toBe(true);
    expect(connected.target).toBeUndefined();
  });

  it("retains multiple game connections and closes all of them on shutdown", async () => {
    const fake = await startFakeCdp();
    openFakes.push(fake);
    const { server, controller } = registerConnectionTools();
    openControllers.push(controller);

    const [first, second] = await Promise.all([
      server.callTool("connect_to_game", { cdpEndpoint: fake.endpoint, timeoutMs: 500 }),
      server.callTool("connect_to_game", { cdpEndpoint: fake.endpoint, timeoutMs: 500 }),
    ]).then((results) => results.map(parseToolResult));
    expect(first.connectionId).not.toBe(second.connectionId);
    expect(fake.activeConnectionCount()).toBe(2);

    await controller.close();
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(fake.activeConnectionCount()).toBe(0);
  });

  it("names the Node.js version it needs when there is no built-in WebSocket client", async () => {
    const fake = await startFakeCdp();
    openFakes.push(fake);
    const { server, controller } = registerConnectionTools();
    openControllers.push(controller);
    vi.stubGlobal("WebSocket", undefined);
    try {
      const result = await server.callTool("connect_to_game", { cdpEndpoint: fake.endpoint, timeoutMs: 500 });
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain("Node.js 22");
    } finally {
      vi.unstubAllGlobals();
    }
    expect(fake.connectionCount()).toBe(0);
  });

  it("rejects mixed direct and discovery connection inputs", async () => {
    const fake = await startFakeCdp();
    openFakes.push(fake);
    const { server, controller } = registerConnectionTools();
    openControllers.push(controller);

    const result = await server.callTool("connect_to_game", {
      cdpEndpoint: fake.endpoint,
      host: "127.0.0.1",
      timeoutMs: 500,
    });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("either cdpEndpoint or host/port");
  });

  it("reports when discovery finds no page target", async () => {
    const fake = await startFakeCdp({ includePageTarget: false });
    openFakes.push(fake);
    const { server, controller } = registerConnectionTools();
    openControllers.push(controller);

    const result = await server.callTool("connect_to_game", {
      host: "127.0.0.1",
      port: fake.port,
      timeoutMs: 500,
    });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("no page target");
  });

  it("closes the provisional connection when the bridge never becomes ready", async () => {
    const fake = await startFakeCdp({ bridgeReadyAfter: Number.MAX_SAFE_INTEGER });
    openFakes.push(fake);
    const { server, controller } = registerConnectionTools();
    openControllers.push(controller);

    const result = await server.callTool("connect_to_game", {
      cdpEndpoint: fake.endpoint,
      timeoutMs: 120,
    });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("Runtime bridge was not ready");
  });
});

describe("call_bridge", () => {
  it("surfaces bridge command failures", async () => {
    const fake = await startFakeCdp({
      bridgeResult: { ok: false, error: "C3 function threw" },
    });
    openFakes.push(fake);
    const { server, controller } = registerConnectionTools();
    openControllers.push(controller);
    const connected = parseToolResult(await server.callTool("connect_to_game", {
      cdpEndpoint: fake.endpoint,
      timeoutMs: 500,
    }));

    const result = await server.callTool("call_bridge", {
      connectionId: connected.connectionId,
      command: "callFunction",
      args: { name: "Broken" },
      timeoutMs: 500,
    });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("C3 function threw");
  });

  it("supports every bridge command and keeps IDs unique under rapid calls", async () => {
    const fake = await startFakeCdp();
    openFakes.push(fake);
    const { server, controller } = registerConnectionTools();
    openControllers.push(controller);
    const connected = parseToolResult(await server.callTool("connect_to_game", {
      cdpEndpoint: fake.endpoint,
      timeoutMs: 500,
    }));
    const commands = [
      ["callFunction", { name: "StartGame", params: [] }],
      ["getGlobalVar", { name: "Score" }],
      ["setGlobalVar", { name: "Score", value: 1 }],
      ["getObjectState", { objectName: "Player" }],
      ["getAllInstances", { objectName: "Player" }],
      ["getLayout", {}],
      ["goToLayout", { name: "Game" }],
      ["evaluateExpression", { objectName: "Player", expression: "x" }],
      ["listObjects", {}],
      ["listGlobalVars", {}],
      ["ping", {}],
    ] as const;

    const results = await Promise.all(commands.map(async ([command, args]) => {
      const result = await server.callTool("call_bridge", {
        connectionId: connected.connectionId,
        command,
        args,
        timeoutMs: 500,
      });
      return parseToolResult(result);
    }));
    expect(new Set(results.map((result) => result.commandId)).size).toBe(commands.length);
    expect(results.every((result) => result.result.pong === true)).toBe(true);
    expect(fake.connectionCount()).toBe(1);
  });

  it("times out clearly when a command never produces a result", async () => {
    const fake = await startFakeCdp({ resultAfter: Number.MAX_SAFE_INTEGER });
    openFakes.push(fake);
    const { server, controller } = registerConnectionTools();
    openControllers.push(controller);
    const connected = parseToolResult(await server.callTool("connect_to_game", {
      cdpEndpoint: fake.endpoint,
      timeoutMs: 500,
    }));

    const result = await server.callTool("call_bridge", {
      connectionId: connected.connectionId,
      command: "ping",
      pollIntervalMs: 10,
      timeoutMs: 120,
    });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("timed out after 120ms");
    // The command is withdrawn, so it does not run later when the game ticks again.
    expect(fake.cancelled()).toEqual([17]);
    expect(result.content[0].text).toContain("withdrawn");
  });

  it("says when a timed-out command ran after all, or may still run on an older bridge", async () => {
    for (const [cancelAnswer, expected] of [
      ["result", "ran after all"],
      ["absent", "may still run"],
    ] as const) {
      const fake = await startFakeCdp({ resultAfter: Number.MAX_SAFE_INTEGER, cancelAnswer });
      openFakes.push(fake);
      const { server, controller } = registerConnectionTools();
      openControllers.push(controller);
      const connected = parseToolResult(await server.callTool("connect_to_game", { cdpEndpoint: fake.endpoint, timeoutMs: 500 }));
      const result = await server.callTool("call_bridge", { connectionId: connected.connectionId, command: "ping", pollIntervalMs: 10, timeoutMs: 120 });
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain(expected);
    }
  });

  it("reports the command timeout when a poll expires at the deadline", async () => {
    const fake = await startFakeCdp({ resultResponseDelayMs: 1_000 });
    openFakes.push(fake);
    const { server, controller } = registerConnectionTools();
    openControllers.push(controller);
    const connected = parseToolResult(await server.callTool("connect_to_game", {
      cdpEndpoint: fake.endpoint,
      timeoutMs: 500,
    }));

    const result = await server.callTool("call_bridge", {
      connectionId: connected.connectionId,
      command: "ping",
      pollIntervalMs: 10,
      timeoutMs: 120,
    });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(
      /^Failed to call runtime bridge: Runtime bridge command timed out after 120ms; it had not run yet and was withdrawn/u,
    );
  });

  it("rejects a closed connection ID", async () => {
    const fake = await startFakeCdp();
    openFakes.push(fake);
    const { server, controller } = registerConnectionTools();
    openControllers.push(controller);
    const connected = parseToolResult(await server.callTool("connect_to_game", {
      cdpEndpoint: fake.endpoint,
      timeoutMs: 500,
    }));
    await server.callTool("disconnect_from_game", { connectionId: connected.connectionId });

    const result = await server.callTool("call_bridge", {
      connectionId: connected.connectionId,
      command: "ping",
      timeoutMs: 500,
    });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("Unknown or closed connection");
  });
});

describe("wait_for_condition", () => {
  it("supports every comparison operator with check-first behavior", async () => {
    const values = [5, 5, 5, 5, "alphabet", true, true];
    const fake = await startFakeCdp({ commandValues: { getGlobalVar: values } });
    openFakes.push(fake);
    const { server, controller } = registerConnectionTools();
    openControllers.push(controller);
    const connected = parseToolResult(await server.callTool("connect_to_game", {
      cdpEndpoint: fake.endpoint,
      timeoutMs: 500,
    }));
    const comparisons = [
      { operator: "gt", value: 4 },
      { operator: "gte", value: 5 },
      { operator: "lt", value: 6 },
      { operator: "lte", value: 5 },
      { operator: "contains", value: "pha" },
      { operator: "eq", value: true },
      { operator: "neq", value: false },
    ] as const;

    for (const comparison of comparisons) {
      const result = parseToolResult(await server.callTool("wait_for_condition", {
        connectionId: connected.connectionId,
        condition: {
          type: "globalVar",
          name: "Value",
          ...comparison,
        },
        pollIntervalMs: 10,
        timeoutMs: 500,
      }));
      expect(result.met).toBe(true);
      expect(result.elapsedMs).toBeGreaterThanOrEqual(0);
    }
    expect(fake.commandCount("getGlobalVar")).toBe(comparisons.length);
  });

  it("polls until a changing numeric value matches", async () => {
    const fake = await startFakeCdp({ commandValues: { getGlobalVar: [0, 0, 5] } });
    openFakes.push(fake);
    const { server, controller } = registerConnectionTools();
    openControllers.push(controller);
    const connected = parseToolResult(await server.callTool("connect_to_game", {
      cdpEndpoint: fake.endpoint,
      timeoutMs: 500,
    }));

    const result = parseToolResult(await server.callTool("wait_for_condition", {
      connectionId: connected.connectionId,
      condition: { type: "globalVar", name: "Score", operator: "gt", value: 2 },
      pollIntervalMs: 10,
      timeoutMs: 500,
    }));
    expect(result).toMatchObject({ met: true, finalValue: 5 });
    expect(fake.commandCount("getGlobalVar")).toBe(3);
  });

  it("supports object properties, instance variables, layouts, and page expressions", async () => {
    const fake = await startFakeCdp({
      commandValues: {
        getObjectState: [
          { text: "0" },
          { text: "10" },
          { _instVars: { Health: 25 } },
        ],
        getLayout: [{ name: "Menu" }, { name: "Bonus" }],
      },
      expressionValues: [3, 11],
    });
    openFakes.push(fake);
    const { server, controller } = registerConnectionTools();
    openControllers.push(controller);
    const connected = parseToolResult(await server.callTool("connect_to_game", {
      cdpEndpoint: fake.endpoint,
      timeoutMs: 500,
    }));

    const objectProperty = parseToolResult(await server.callTool("wait_for_condition", {
      connectionId: connected.connectionId,
      condition: {
        type: "objectProperty",
        objectType: "PotDisplay",
        property: "text",
        operator: "neq",
        value: "0",
      },
      pollIntervalMs: 10,
      timeoutMs: 500,
    }));
    expect(objectProperty).toMatchObject({ met: true, finalValue: "10" });

    const instanceVariable = parseToolResult(await server.callTool("wait_for_condition", {
      connectionId: connected.connectionId,
      condition: {
        type: "objectProperty",
        objectType: "Player",
        property: "Health",
        operator: "eq",
        value: 25,
      },
      timeoutMs: 500,
    }));
    expect(instanceVariable).toMatchObject({ met: true, finalValue: 25 });

    const layout = parseToolResult(await server.callTool("wait_for_condition", {
      connectionId: connected.connectionId,
      condition: { type: "layout", name: "Bonus" },
      pollIntervalMs: 10,
      timeoutMs: 500,
    }));
    expect(layout).toMatchObject({ met: true, finalValue: "Bonus" });

    const expressionCall = {
      connectionId: connected.connectionId,
      condition: {
        type: "expression",
        expr: "globalThis.__c3bridge.getState().objectCount",
        operator: "gt",
        value: 10,
      },
      pollIntervalMs: 10,
      timeoutMs: 500,
    };
    // Page script runs only when whoever started the server allowed it.
    for (const setting of [undefined, "", "0", "true"]) {
      vi.stubEnv("C3MCP_ALLOW_EVAL", setting);
      const refused = await server.callTool("wait_for_condition", expressionCall);
      expect(refused.isError).toBe(true);
      expect(refused.content[0].text).toContain("C3MCP_ALLOW_EVAL=1");
    }
    expect(fake.expressionCount()).toBe(0);

    vi.stubEnv("C3MCP_ALLOW_EVAL", "1");
    const expression = parseToolResult(await server.callTool("wait_for_condition", expressionCall));
    expect(expression).toMatchObject({ met: true, finalValue: 11 });
  });

  it("returns met false with the last observed value on timeout", async () => {
    const fake = await startFakeCdp({ commandValues: { getGlobalVar: ["WAITING"] } });
    openFakes.push(fake);
    const { server, controller } = registerConnectionTools();
    openControllers.push(controller);
    const connected = parseToolResult(await server.callTool("connect_to_game", {
      cdpEndpoint: fake.endpoint,
      timeoutMs: 500,
    }));

    const result = parseToolResult(await server.callTool("wait_for_condition", {
      connectionId: connected.connectionId,
      condition: { type: "globalVar", name: "State", operator: "eq", value: "READY" },
      pollIntervalMs: 20,
      timeoutMs: 120,
    }));
    expect(result.met).toBe(false);
    expect(result.finalValue).toBe("WAITING");
    expect(result.elapsedMs).toBeGreaterThanOrEqual(100);
  });

  it("reports invalid comparisons and missing object properties", async () => {
    const fake = await startFakeCdp({
      commandValues: {
        getGlobalVar: ["5"],
        getObjectState: [{}],
      },
    });
    openFakes.push(fake);
    const { server, controller } = registerConnectionTools();
    openControllers.push(controller);
    const connected = parseToolResult(await server.callTool("connect_to_game", {
      cdpEndpoint: fake.endpoint,
      timeoutMs: 500,
    }));

    await expect(server.callTool("wait_for_condition", {
      connectionId: connected.connectionId,
      condition: { type: "globalVar", name: "Score", operator: "eq" },
      timeoutMs: 500,
    })).rejects.toThrow(/value is required/u);

    const mismatch = await server.callTool("wait_for_condition", {
      connectionId: connected.connectionId,
      condition: { type: "globalVar", name: "Score", operator: "gt", value: 5 },
      timeoutMs: 500,
    });
    expect(mismatch.isError).toBe(true);
    expect(mismatch.content[0].text).toContain("requires two numbers or two strings");

    const missing = await server.callTool("wait_for_condition", {
      connectionId: connected.connectionId,
      condition: {
        type: "objectProperty",
        objectType: "Player",
        property: "missing",
        operator: "eq",
        value: 1,
      },
      timeoutMs: 500,
    });
    expect(missing.isError).toBe(true);
    expect(missing.content[0].text).toContain('Player.missing');
  });
});

describe("subscribe_events, read_events and unsubscribe_events", () => {
  it("travel through the retained connection with camelCase result names and the defaults", async () => {
    const fake = await startFakeCdp({
      commandValues: {
        subscribeEvents: [{ subscriptionId: "sub-1" }],
        readEvents: [
          { events: [{ type: "globalVarChange", name: "Score", value: 5, previousValue: 0, timestamp: 1, tick: 4 }], count: 1 },
          { events: [], count: 0 },
        ],
        unsubscribeEvents: [{ subscriptionId: "sub-1", unsubscribed: true }],
      },
    });
    openFakes.push(fake);
    const { server, controller } = registerConnectionTools();
    openControllers.push(controller);
    const connected = parseToolResult(await server.callTool("connect_to_game", { cdpEndpoint: fake.endpoint, timeoutMs: 500 }));

    const made = parseToolResult(await server.callTool("subscribe_events", {
      connectionId: connected.connectionId, eventType: "globalVarChange", filter: { variable: "Score" },
    }));
    expect(made).toEqual({ subscriptionId: "sub-1", eventType: "globalVarChange", filter: { variable: "Score" }, bufferSize: 100 });

    const read = parseToolResult(await server.callTool("read_events", { connectionId: connected.connectionId, subscriptionId: "sub-1", clear: false }));
    expect(read).toEqual({ events: [{ type: "globalVarChange", name: "Score", value: 5, previousValue: 0, timestamp: 1, tick: 4 }], count: 1 });
    const cleared = parseToolResult(await server.callTool("read_events", { connectionId: connected.connectionId, subscriptionId: "sub-1" }));
    expect(cleared).toEqual({ events: [], count: 0 });

    const gone = parseToolResult(await server.callTool("unsubscribe_events", { connectionId: connected.connectionId, subscriptionId: "sub-1" }));
    expect(gone).toEqual({ subscriptionId: "sub-1", unsubscribed: true });
    expect(fake.commandCount("subscribeEvents")).toBe(1);
    expect(fake.commandCount("readEvents")).toBe(2);
    expect(fake.commandCount("unsubscribeEvents")).toBe(1);
  });

  it("refuse a global subscription without its variable before any command, and surface bridge errors", async () => {
    const fake = await startFakeCdp({ bridgeResult: { ok: false, error: "Unknown subscription: sub-9" } });
    openFakes.push(fake);
    const { server, controller } = registerConnectionTools();
    openControllers.push(controller);
    const connected = parseToolResult(await server.callTool("connect_to_game", { cdpEndpoint: fake.endpoint, timeoutMs: 500 }));

    const missing = await server.callTool("subscribe_events", { connectionId: connected.connectionId, eventType: "globalVarChange" });
    expect(missing.isError).toBe(true);
    expect(missing.content[0].text).toContain("needs filter.variable");
    expect(fake.commandCount("subscribeEvents")).toBe(0);

    const unknown = await server.callTool("unsubscribe_events", { connectionId: connected.connectionId, subscriptionId: "sub-9" });
    expect(unknown.isError).toBe(true);
    expect(unknown.content[0].text).toContain("Unknown subscription: sub-9");

    const closed = await server.callTool("read_events", { connectionId: "00000000-0000-4000-8000-000000000000", subscriptionId: "sub-1" });
    expect(closed.isError).toBe(true);
    expect(closed.content[0].text).toContain("Unknown or closed connection");
  });
});

describe("screenshot_game", () => {
  it("writes the page or only the canvas rectangle to a file", async () => {
    const geometry = {
      left: 40, top: 25.5, cssWidth: 320, cssHeight: 240, backingWidth: 640, backingHeight: 480,
      devicePixelRatio: 2, viewportWidth: 400, viewportHeight: 300,
    };
    const fake = await startFakeCdp({ canvasGeometry: geometry });
    openFakes.push(fake);
    const { server, controller } = registerConnectionTools();
    openControllers.push(controller);
    const connected = parseToolResult(await server.callTool("connect_to_game", { cdpEndpoint: fake.endpoint, timeoutMs: 500 }));
    const dir = await mkdtemp(join(tmpdir(), "c3-shot-"));
    try {
      const whole = parseToolResult(await server.callTool("screenshot_game", {
        connectionId: connected.connectionId, outputPath: join(dir, "nested", "page.png"),
      }));
      expect(whole).toMatchObject({ success: true, format: "png", path: join(dir, "nested", "page.png") });
      expect(whole.clip).toBeUndefined();
      expect((await readFile(whole.path, "utf8"))).toBe('image:{"format":"png"}');

      const canvas = parseToolResult(await server.callTool("screenshot_game", {
        connectionId: connected.connectionId, outputPath: join(dir, "canvas.jpg"), format: "jpeg", quality: 80, canvasOnly: true,
      }));
      expect(canvas.clip).toEqual({ x: 40, y: 25.5, width: 320, height: 240 });
      expect(await readFile(canvas.path, "utf8")).toBe('image:{"format":"jpeg","quality":80,"clip":{"x":40,"y":25.5,"width":320,"height":240,"scale":1}}');
      expect(canvas.bytes).toBeGreaterThan(0);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
  it("writes only a new image file outside the project, named for its format, at an absolute path", async () => {
    const project = await mkdtemp(join(tmpdir(), "c3-shot-project-"));
    const outside = await mkdtemp(join(tmpdir(), "c3-shot-"));
    try {
      await writeFile(join(project, "project.c3proj"), "{\"project\": true}", "utf8");
      await mkdir(join(project, "images"));
      await writeFile(join(project, "images", "sprite.png"), "sprite", "utf8");
      const fake = await startFakeCdp();
      openFakes.push(fake);
      const { server, controller } = registerConnectionTools(project);
      openControllers.push(controller);
      const connected = parseToolResult(await server.callTool("connect_to_game", { cdpEndpoint: fake.endpoint, timeoutMs: 500 }));
      const shoot = (args: Record<string, unknown>) => server.callTool("screenshot_game", { connectionId: connected.connectionId, ...args });
      const refused = async (args: Record<string, unknown>, reason: RegExp) => {
        const result = await shoot(args);
        expect(result.isError, JSON.stringify(args)).toBe(true);
        expect(result.content[0].text).toMatch(reason);
      };

      await refused({ outputPath: join(project, "project.c3proj") }, /\.png/u);
      await refused({ outputPath: join(project, "shots", "a.png") }, /inside the open project/u);
      await refused({ outputPath: join(project, "images", "sprite.png"), overwrite: true }, /inside the open project/u);
      await refused({ outputPath: "shots/a.png" }, /absolute/u);
      await refused({ outputPath: join(outside, "a.jpg") }, /\.png/u);
      await refused({ outputPath: join(outside, "a.png"), format: "jpeg" }, /\.jpg or \.jpeg/u);
      expect(await readFile(join(project, "project.c3proj"), "utf8")).toBe("{\"project\": true}");
      expect(await readFile(join(project, "images", "sprite.png"), "utf8")).toBe("sprite");
      expect(fake.cdpCommands().filter((c) => c.method === "Page.captureScreenshot")).toEqual([]);

      await writeFile(join(outside, "kept.png"), "earlier", "utf8");
      await refused({ outputPath: join(outside, "kept.png") }, /exists.*overwrite/u);
      expect(await readFile(join(outside, "kept.png"), "utf8")).toBe("earlier");
      expect(parseToolResult(await shoot({ outputPath: join(outside, "kept.png"), overwrite: true })).success).toBe(true);
      expect(await readFile(join(outside, "kept.png"), "utf8")).toBe('image:{"format":"png"}');
      expect(parseToolResult(await shoot({ outputPath: join(outside, "b.JPEG"), format: "jpeg" })).format).toBe("jpeg");
    } finally {
      await rm(project, { recursive: true, force: true });
      await rm(outside, { recursive: true, force: true });
    }
  });

  it("keeps the connection when a screenshot message is larger than 4 MiB", async () => {
    // 5 MiB of image data is about 6.7 MiB of base64 in one CDP message.
    const fake = await startFakeCdp({ screenshotBytes: 5 * 1024 * 1024 });
    openFakes.push(fake);
    const { server, controller } = registerConnectionTools();
    openControllers.push(controller);
    const connected = parseToolResult(await server.callTool("connect_to_game", { cdpEndpoint: fake.endpoint, timeoutMs: 500 }));
    const dir = await mkdtemp(join(tmpdir(), "c3-shot-"));
    try {
      const shot = await server.callTool("screenshot_game", {
        connectionId: connected.connectionId, outputPath: join(dir, "big.png"),
      });
      expect(shot.content[0].text).not.toMatch(/payload|closed/iu);
      expect(parseToolResult(shot).bytes).toBe(5 * 1024 * 1024);
      const called = parseToolResult(await server.callTool("call_bridge", {
        connectionId: connected.connectionId, command: "ping", pollIntervalMs: 10, timeoutMs: 500,
      }));
      expect(called.result).toEqual({ pong: true });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("simulate_input in layout coordinates", () => {
  it("converts every point through the bridge's layerToCssPx before dispatching", async () => {
    const fake = await startFakeCdp({
      commandValues: { layerToCssPx: [{ x: 300, y: 200, layer: "Layer 0" }, { x: 310, y: 210, layer: "Layer 0" }, { x: 330, y: 240, layer: "Layer 0" }] },
    });
    openFakes.push(fake);
    const { server, controller } = registerConnectionTools();
    openControllers.push(controller);
    const connected = parseToolResult(await server.callTool("connect_to_game", { cdpEndpoint: fake.endpoint, timeoutMs: 500 }));

    parseToolResult(await server.callTool("simulate_input", {
      connectionId: connected.connectionId, action: { type: "click", x: 10, y: 20 }, coordinateSpace: "layout", layer: "Layer 0",
    }));
    parseToolResult(await server.callTool("simulate_input", {
      connectionId: connected.connectionId, action: { type: "touch", x: 0, y: 0, gesture: "swipe", endX: 50, endY: 60 }, coordinateSpace: "layout",
    }));
    expect(fake.commandCount("layerToCssPx")).toBe(3);
    const commands = fake.cdpCommands();
    expect(commands[0].params).toMatchObject({ type: "mousePressed", x: 300, y: 200 });
    expect(commands[1].params).toMatchObject({ type: "mouseReleased", x: 300, y: 200 });
    const touchStart = commands.find(c => c.params.type === "touchStart");
    expect(touchStart?.params).toMatchObject({ touchPoints: [{ x: 310, y: 210 }] });
    // A swipe interpolates its moves; the last one lands on the converted end point.
    const touchMoves = commands.filter(c => c.params.type === "touchMove");
    expect(touchMoves.at(-1)?.params).toMatchObject({ touchPoints: [{ x: 330, y: 240 }] });
  });

  it("reports a layer the game does not have, or an old bridge, instead of clicking somewhere", async () => {
    const fake = await startFakeCdp({ commandValues: { layerToCssPx: [{ error: "Layer not found: Nope" }] } });
    openFakes.push(fake);
    const { server, controller } = registerConnectionTools();
    openControllers.push(controller);
    const connected = parseToolResult(await server.callTool("connect_to_game", { cdpEndpoint: fake.endpoint, timeoutMs: 500 }));
    const result = await server.callTool("simulate_input", {
      connectionId: connected.connectionId, action: { type: "click", x: 1, y: 2 }, coordinateSpace: "layout", layer: "Nope",
    });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("Could not convert layout coordinates");
    expect(result.content[0].text).toContain("Layer not found: Nope");
    expect(fake.cdpCommands().some(c => c.method === "Input.dispatchMouseEvent")).toBe(false);
  });
});

describe("serve_preview and stop_preview", () => {
  it("serves only on this machine at a 127.0.0.1 URL, refuses a source project, and stops", async () => {
    const { server, controller } = registerConnectionTools();
    openControllers.push(controller);
    const root = await mkdtemp(join(tmpdir(), "c3-serve-"));
    try {
      await mkdir(join(root, "game"));
      await writeFile(join(root, "game", "index.html"), "<title>Served</title>", "utf8");
      const folder = join(root, "game");

      const archive = await server.callTool("serve_preview", { folder: join(root, "game.c3p") });
      expect(archive.isError).toBe(true);
      expect(archive.content[0].text).toContain("source project, not an exported game");

      const served = parseToolResult(await server.callTool("serve_preview", { folder }));
      expect(served).toMatchObject({ success: true, host: "127.0.0.1", folder });
      // 127.0.0.1, not localhost: localhost can resolve to ::1 first, where nothing listens.
      expect(served.url).toBe(`http://127.0.0.1:${served.port}/`);
      expect(served.next).toContain("launchBrowser: true");
      expect(await (await fetch(served.url)).text()).toBe("<title>Served</title>");

      const stopped = parseToolResult(await server.callTool("stop_preview", { serverId: served.serverId }));
      expect(stopped.stopped.map((p: { serverId: string }) => p.serverId)).toEqual([served.serverId]);
      await expect(fetch(served.url)).rejects.toThrow();

      const again = parseToolResult(await server.callTool("serve_preview", { folder, crossOriginIsolated: true }));
      expect(again.crossOriginIsolated).toBe(true);
      expect((await fetch(again.url)).headers.get("cross-origin-embedder-policy")).toBe("require-corp");
      const all = parseToolResult(await server.callTool("stop_preview", {}));
      expect(all.stopped.map((p: { serverId: string }) => p.serverId)).toEqual([again.serverId]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("refuses a listening interface or a browser executable as parameters", async () => {
    const { server, controller } = registerConnectionTools();
    openControllers.push(controller);
    const root = await mkdtemp(join(tmpdir(), "c3-serve-"));
    try {
      await writeFile(join(root, "index.html"), "<title>Served</title>", "utf8");
      // Whoever calls the tool must not open the folder to the network or
      // start a program of their choice: those are the operator's settings.
      for (const extra of [
        { host: "0.0.0.0", allowRemoteHost: true },
        { allowRemoteHost: true },
        { launchBrowser: true, chromePath: process.execPath },
        { chromeDebuggingPort: 9222 },
      ]) {
        await expect(server.callTool("serve_preview", { folder: root, ...extra })).rejects.toThrow(/Unrecognized key/u);
      }
      expect(parseToolResult(await server.callTool("stop_preview", {})).stopped).toEqual([]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe("simulate_input", () => {
  it("dispatches delayed clicks and mouse movement with viewport coordinates", async () => {
    const fake = await startFakeCdp();
    openFakes.push(fake);
    const { server, controller } = registerConnectionTools();
    openControllers.push(controller);
    const connected = parseToolResult(await server.callTool("connect_to_game", {
      cdpEndpoint: fake.endpoint,
      timeoutMs: 500,
    }));

    const startedAt = Date.now();
    const click = parseToolResult(await server.callTool("simulate_input", {
      connectionId: connected.connectionId,
      action: { type: "click", x: 120, y: 240 },
      delayMs: 25,
    }));
    expect(click).toEqual({ success: true, action: "click" });
    expect(Date.now() - startedAt).toBeGreaterThanOrEqual(20);
    expect(fake.cdpCommands()).toEqual([
      {
        method: "Input.dispatchMouseEvent",
        params: {
          type: "mousePressed",
          x: 120,
          y: 240,
          button: "left",
          clickCount: 1,
          buttons: 1,
        },
      },
      {
        method: "Input.dispatchMouseEvent",
        params: {
          type: "mouseReleased",
          x: 120,
          y: 240,
          button: "left",
          clickCount: 1,
          buttons: 0,
        },
      },
    ]);

    parseToolResult(await server.callTool("simulate_input", {
      connectionId: connected.connectionId,
      action: { type: "click", x: 30, y: 40, button: "right", clickCount: 2 },
    }));
    parseToolResult(await server.callTool("simulate_input", {
      connectionId: connected.connectionId,
      action: { type: "click", x: 50, y: 60, button: "middle" },
    }));
    expect(fake.cdpCommands().slice(2, 6).map((command) => command.params)).toEqual([
      expect.objectContaining({ button: "right", buttons: 2, clickCount: 2 }),
      expect.objectContaining({ button: "right", buttons: 0, clickCount: 2 }),
      expect.objectContaining({ button: "middle", buttons: 4, clickCount: 1 }),
      expect.objectContaining({ button: "middle", buttons: 0, clickCount: 1 }),
    ]);

    parseToolResult(await server.callTool("simulate_input", {
      connectionId: connected.connectionId,
      action: { type: "mouseMove", x: 12.5, y: 18.25 },
    }));
    expect(fake.cdpCommands().at(-1)).toEqual({
      method: "Input.dispatchMouseEvent",
      params: {
        type: "mouseMoved",
        x: 12.5,
        y: 18.25,
        button: "none",
        buttons: 0,
      },
    });
  });

  it("dispatches key combinations, and types text as key presses unless insertText is asked for", async () => {
    const fake = await startFakeCdp();
    openFakes.push(fake);
    const { server, controller } = registerConnectionTools();
    openControllers.push(controller);
    const connected = parseToolResult(await server.callTool("connect_to_game", {
      cdpEndpoint: fake.endpoint,
      timeoutMs: 500,
    }));

    parseToolResult(await server.callTool("simulate_input", {
      connectionId: connected.connectionId,
      action: { type: "key", key: "k", modifiers: ["Control", "Shift"] },
    }));
    parseToolResult(await server.callTool("simulate_input", {
      connectionId: connected.connectionId,
      action: { type: "key", key: "Space" },
    }));
    parseToolResult(await server.callTool("simulate_input", {
      connectionId: connected.connectionId,
      action: { type: "type", text: "a.B🙂" },
    }));
    parseToolResult(await server.callTool("simulate_input", {
      connectionId: connected.connectionId,
      action: { type: "type", text: "A🙂", mode: "insertText" },
    }));

    const commands = fake.cdpCommands();
    expect(commands.slice(0, 2)).toEqual([
      {
        method: "Input.dispatchKeyEvent",
        params: {
          type: "keyDown",
          modifiers: 10,
          key: "k",
          code: "KeyK",
          windowsVirtualKeyCode: 75,
          nativeVirtualKeyCode: 75,
        },
      },
      {
        method: "Input.dispatchKeyEvent",
        params: {
          type: "keyUp",
          modifiers: 10,
          key: "k",
          code: "KeyK",
          windowsVirtualKeyCode: 75,
          nativeVirtualKeyCode: 75,
        },
      },
    ]);
    expect(commands[2].params).toMatchObject({
      type: "keyDown",
      key: " ",
      code: "Space",
      text: " ",
    });
    // "type" presses a key per character, so a game reading the keyboard sees it.
    const typed = commands.slice(4, -1).map((command) => command.params);
    expect(commands.slice(4, -1).every((command) => command.method === "Input.dispatchKeyEvent")).toBe(true);
    expect(typed.map((p) => [p.type, p.key, p.code, p.windowsVirtualKeyCode, p.modifiers, p.text])).toEqual([
      ["keyDown", "a", "KeyA", 65, 0, "a"],
      ["keyUp", "a", "KeyA", 65, 0, undefined],
      ["keyDown", ".", "Period", 190, 0, "."],
      ["keyUp", ".", "Period", 190, 0, undefined],
      ["keyDown", "B", "KeyB", 66, 8, "B"],
      ["keyUp", "B", "KeyB", 66, 8, undefined],
      ["keyDown", "🙂", "", 0, 0, "🙂"],
      ["keyUp", "🙂", "", 0, 0, undefined],
    ]);
    expect(commands.at(-1)).toEqual({ method: "Input.insertText", params: { text: "A🙂" } });
  });

  it("gives punctuation and shifted characters their US-layout key codes", async () => {
    const fake = await startFakeCdp();
    openFakes.push(fake);
    const { server, controller } = registerConnectionTools();
    openControllers.push(controller);
    const connected = parseToolResult(await server.callTool("connect_to_game", { cdpEndpoint: fake.endpoint, timeoutMs: 500 }));

    const cases: Array<[string, string, number, number]> = [
      [".", "Period", 190, 0], [",", "Comma", 188, 0], ["-", "Minus", 189, 0], ["/", "Slash", 191, 0],
      [";", "Semicolon", 186, 0], ["'", "Quote", 222, 0], ["[", "BracketLeft", 219, 0], ["]", "BracketRight", 221, 0],
      ["\\", "Backslash", 220, 0], ["`", "Backquote", 192, 0], ["=", "Equal", 187, 0],
      ["!", "Digit1", 49, 8], ["?", "Slash", 191, 8], [":", "Semicolon", 186, 8], ["_", "Minus", 189, 8],
      ["7", "Digit7", 55, 0], ["Z", "KeyZ", 90, 8], ["Insert", "Insert", 45, 0], ["F13", "F13", 124, 0],
    ];
    for (const [key] of cases) {
      parseToolResult(await server.callTool("simulate_input", { connectionId: connected.connectionId, action: { type: "key", key } }));
    }
    const downs = fake.cdpCommands().filter((command) => command.params.type === "keyDown").map((command) => command.params);
    expect(downs.map((p) => [p.key, p.code, p.windowsVirtualKeyCode, p.modifiers])).toEqual(cases);
  });

  it("dispatches tap, swipe, and long-press touch gestures", async () => {
    const fake = await startFakeCdp();
    openFakes.push(fake);
    const { server, controller } = registerConnectionTools();
    openControllers.push(controller);
    const connected = parseToolResult(await server.callTool("connect_to_game", {
      cdpEndpoint: fake.endpoint,
      timeoutMs: 500,
    }));

    await expect(server.callTool("simulate_input", {
      connectionId: connected.connectionId,
      action: { type: "touch", x: 10, y: 20, gesture: "swipe" },
    })).rejects.toThrow(/require endX and endY/u);

    parseToolResult(await server.callTool("simulate_input", {
      connectionId: connected.connectionId,
      action: { type: "touch", x: 10, y: 20, gesture: "tap" },
    }));
    const afterTap = fake.cdpCommands();
    expect(afterTap.map((command) => command.method)).toEqual([
      "Emulation.setTouchEmulationEnabled",
      "Input.dispatchTouchEvent",
      "Input.dispatchTouchEvent",
      "Emulation.setTouchEmulationEnabled",
    ]);
    expect(afterTap[0].params).toMatchObject({ enabled: true });
    expect(afterTap[1].params).toMatchObject({
      type: "touchStart",
      touchPoints: [{ x: 10, y: 20, id: 1 }],
    });
    expect(afterTap[2].params).toEqual({ type: "touchEnd", touchPoints: [] });
    // Touch emulation ends with the gesture, so the page does not stay a touch device.
    expect(afterTap[3].params).toEqual({ enabled: false });

    const swipeStartIndex = fake.cdpCommands().length;
    parseToolResult(await server.callTool("simulate_input", {
      connectionId: connected.connectionId,
      action: {
        type: "touch",
        x: 0,
        y: 10,
        gesture: "swipe",
        endX: 80,
        endY: 90,
      },
    }));
    const swipe = fake.cdpCommands().slice(swipeStartIndex);
    expect(swipe).toHaveLength(12);
    expect(swipe[2]).toMatchObject({
      method: "Input.dispatchTouchEvent",
      params: { type: "touchMove", touchPoints: [{ x: 10, y: 20 }] },
    });
    expect(swipe[9]).toMatchObject({
      method: "Input.dispatchTouchEvent",
      params: { type: "touchMove", touchPoints: [{ x: 80, y: 90 }] },
    });
    expect(swipe[10].params).toEqual({ type: "touchEnd", touchPoints: [] });
    expect(swipe[11].params).toEqual({ enabled: false });

    const longPressStartedAt = Date.now();
    parseToolResult(await server.callTool("simulate_input", {
      connectionId: connected.connectionId,
      action: { type: "touch", x: 30, y: 40, gesture: "longPress" },
    }));
    expect(Date.now() - longPressStartedAt).toBeGreaterThanOrEqual(450);
    expect(fake.cdpCommands().slice(-3, -1).map((command) => command.params.type)).toEqual([
      "touchStart",
      "touchEnd",
    ]);
  });

  it("maps canvas coordinates through the live canvas offset and reports canvas geometry", async () => {
    const geometry = {
      left: 40,
      top: 25.5,
      cssWidth: 320,
      cssHeight: 240,
      backingWidth: 640,
      backingHeight: 480,
      devicePixelRatio: 2,
      viewportWidth: 400,
      viewportHeight: 300,
    };
    const fake = await startFakeCdp({ canvasGeometry: geometry });
    openFakes.push(fake);
    const { server, controller } = registerConnectionTools();
    openControllers.push(controller);
    const connected = parseToolResult(await server.callTool("connect_to_game", {
      cdpEndpoint: fake.endpoint,
      timeoutMs: 500,
    }));

    expect(parseToolResult(await server.callTool("get_canvas_size", {
      connectionId: connected.connectionId,
    }))).toEqual(geometry);

    parseToolResult(await server.callTool("simulate_input", {
      connectionId: connected.connectionId,
      action: { type: "click", x: 10, y: 20 },
      coordinateSpace: "canvas",
    }));
    parseToolResult(await server.callTool("simulate_input", {
      connectionId: connected.connectionId,
      action: { type: "touch", x: 0, y: 0, gesture: "swipe", endX: 320, endY: 240 },
      coordinateSpace: "canvas",
    }));
    const commands = fake.cdpCommands();
    expect(commands[0].params).toMatchObject({ type: "mousePressed", x: 50, y: 45.5 });
    expect(commands[1].params).toMatchObject({ type: "mouseReleased", x: 50, y: 45.5 });
    expect(commands[3].params).toMatchObject({
      type: "touchStart",
      touchPoints: [{ x: 40, y: 25.5 }],
    });
    expect(commands[11].params).toMatchObject({
      type: "touchMove",
      touchPoints: [{ x: 360, y: 265.5 }],
    });

    const dispatched = fake.cdpCommands().length;
    const outside = await server.callTool("simulate_input", {
      connectionId: connected.connectionId,
      action: { type: "click", x: 321, y: 20 },
      coordinateSpace: "canvas",
    });
    expect(outside.isError).toBe(true);
    expect(outside.content[0].text).toContain("outside the 320x240 CSS-pixel canvas");
    expect(fake.cdpCommands()).toHaveLength(dispatched);

    parseToolResult(await server.callTool("simulate_input", {
      connectionId: connected.connectionId,
      action: { type: "click", x: 10, y: 20 },
    }));
    expect(fake.cdpCommands().at(-1)!.params).toMatchObject({ x: 10, y: 20 });
  });

  it("reports a missing canvas without dispatching input", async () => {
    const fake = await startFakeCdp();
    openFakes.push(fake);
    const { server, controller } = registerConnectionTools();
    openControllers.push(controller);
    const connected = parseToolResult(await server.callTool("connect_to_game", {
      cdpEndpoint: fake.endpoint,
      timeoutMs: 500,
    }));

    const size = await server.callTool("get_canvas_size", { connectionId: connected.connectionId });
    expect(size.isError).toBe(true);
    expect(size.content[0].text).toContain("No canvas element");
    const click = await server.callTool("simulate_input", {
      connectionId: connected.connectionId,
      action: { type: "click", x: 1, y: 1 },
      coordinateSpace: "canvas",
    });
    expect(click.isError).toBe(true);
    expect(fake.cdpCommands()).toEqual([]);
  });

  it("rejects an incomplete swipe before dispatching a touch", async () => {
    const fake = await startFakeCdp();
    openFakes.push(fake);
    const manager = new RuntimeConnectionManager();
    try {
      const connected = await manager.connect({ cdpEndpoint: fake.endpoint, timeoutMs: 500 });
      await expect(manager.simulateInput({
        connectionId: connected.connectionId,
        action: { type: "touch", x: 10, y: 20, gesture: "swipe", endX: 30 },
        delayMs: 0,
      })).rejects.toThrow(/require endX and endY/u);
      expect(fake.cdpCommands()).toEqual([]);
    } finally {
      await manager.closeAll();
    }
  });
});

describe("get_bridge_commands", () => {
  it("names call_bridge and lists exactly the commands call_bridge accepts", async () => {
    const { server, controller } = registerConnectionTools();
    openControllers.push(controller);
    const tool = server.getTool("get_bridge_commands")!;
    expect(tool.description).toContain("call_bridge");
    expect(tool.description).not.toContain("call_bridge_command");
    const listed = Object.keys(parseToolResult(await server.callTool("get_bridge_commands", {}))).sort();
    const accepted = [...(server.getTool("call_bridge")!.schema.command as unknown as { options: string[] }).options].sort();
    expect(listed).toEqual(accepted);
  });
});
