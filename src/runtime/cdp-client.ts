/**
 * Minimal Chrome DevTools Protocol client for Construct runtime control.
 *
 * The client intentionally implements only the CDP methods the runtime tools
 * need. Keeping the protocol surface small avoids a heavyweight browser
 * automation dependency while still supporting persistent game connections.
 */

import { randomUUID } from "node:crypto";
import WebSocket, { type RawData } from "ws";

const BRIDGE_POLL_INTERVAL_MS = 100;
const CDP_CALL_TIMEOUT_MS = 5_000;
const LONG_PRESS_MS = 500;
const SWIPE_STEPS = 8;
const SWIPE_STEP_MS = 16;

export interface GameState {
  ready: boolean;
  layoutName: string | null;
  tickCount: number;
  gameTime: number;
  dt?: number;
  objectCount: number;
}

export interface ConnectToGameOptions {
  cdpEndpoint?: string;
  host?: string;
  port?: number;
  timeoutMs: number;
}

export interface ConnectedGame {
  connectionId: string;
  bridgeReady: true;
  gameState: GameState;
  target?: {
    id?: string;
    title?: string;
    url?: string;
  };
}

export interface BridgeCallOptions {
  connectionId: string;
  command: string;
  args: Record<string, unknown>;
  pollIntervalMs: number;
  timeoutMs: number;
}

export interface BridgeCallResult {
  commandId: number;
  result: unknown;
  elapsedMs: number;
}

export type ConditionOperator = "eq" | "neq" | "gt" | "lt" | "gte" | "lte" | "contains";

export type RuntimeCondition =
  | {
    type: "globalVar";
    name: string;
    operator: ConditionOperator;
    value: unknown;
  }
  | {
    type: "objectProperty";
    objectType: string;
    property: string;
    operator: ConditionOperator;
    value: unknown;
  }
  | {
    type: "layout";
    name: string;
  }
  | {
    type: "expression";
    expr: string;
    operator: ConditionOperator;
    value: unknown;
  };

export interface WaitForConditionOptions {
  connectionId: string;
  condition: RuntimeCondition;
  pollIntervalMs: number;
  timeoutMs: number;
}

export interface WaitForConditionResult {
  met: boolean;
  elapsedMs: number;
  finalValue: unknown;
}

export type InputModifier = "Alt" | "Control" | "Meta" | "Shift";

export type SimulatedInputAction =
  | {
    type: "click";
    x: number;
    y: number;
    button: "left" | "right" | "middle";
    clickCount: 1 | 2;
  }
  | {
    type: "touch";
    x: number;
    y: number;
    gesture: "tap" | "longPress" | "swipe";
    endX?: number;
    endY?: number;
  }
  | {
    type: "key";
    key: string;
    modifiers: InputModifier[];
  }
  | {
    type: "type";
    text: string;
  }
  | {
    type: "mouseMove";
    x: number;
    y: number;
  };

export type InputCoordinateSpace = "viewport" | "canvas" | "layout";

export interface SimulateInputOptions {
  connectionId: string;
  action: SimulatedInputAction;
  delayMs: number;
  coordinateSpace?: InputCoordinateSpace;
  /** The layer whose coordinates `layout` space uses: a name or index (default: layer 0). */
  layer?: string | number;
}

export interface ScreenshotOptions {
  connectionId: string;
  format: "png" | "jpeg";
  /** JPEG quality 0 to 100. */
  quality?: number;
  /** Capture only the game canvas rectangle. */
  canvasOnly: boolean;
}

export interface ScreenshotResult {
  data: Buffer;
  format: "png" | "jpeg";
  clip?: { x: number; y: number; width: number; height: number };
}

export interface CanvasGeometry {
  left: number;
  top: number;
  cssWidth: number;
  cssHeight: number;
  backingWidth: number;
  backingHeight: number;
  devicePixelRatio: number;
  viewportWidth: number;
  viewportHeight: number;
}

export interface SimulateInputResult {
  success: true;
  action: SimulatedInputAction["type"];
}

interface CdpTarget {
  id?: string;
  title?: string;
  type?: string;
  url?: string;
  webSocketDebuggerUrl?: string;
}

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (reason: Error) => void;
  timer: NodeJS.Timeout;
}

interface CdpResponse {
  id?: number;
  result?: unknown;
  error?: {
    code?: number;
    message?: string;
  };
}

interface RemoteObject {
  type?: string;
  value?: unknown;
  unserializableValue?: string;
  description?: string;
}

interface EvaluationResult {
  result?: RemoteObject;
  exceptionDetails?: {
    text?: string;
    exception?: RemoteObject;
  };
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function rawDataToString(data: RawData): string {
  if (Buffer.isBuffer(data)) return data.toString("utf8");
  if (Array.isArray(data)) return Buffer.concat(data).toString("utf8");
  return Buffer.from(data).toString("utf8");
}

function scriptLiteral(value: unknown): string {
  return JSON.stringify(value)
    .replace(/\u2028/gu, "\\u2028")
    .replace(/\u2029/gu, "\\u2029");
}

function compareValues(actual: unknown, operator: ConditionOperator, expected: unknown): boolean {
  switch (operator) {
    case "eq":
      return Object.is(actual, expected);
    case "neq":
      return !Object.is(actual, expected);
    case "contains":
      if (typeof actual === "string" && typeof expected === "string") {
        return actual.includes(expected);
      }
      if (Array.isArray(actual)) {
        return actual.some((entry) => Object.is(entry, expected));
      }
      throw new Error('Operator "contains" requires a string/string or array/value comparison');
    case "gt":
    case "lt":
    case "gte":
    case "lte": {
      if (
        !(
          (typeof actual === "number" && typeof expected === "number")
          || (typeof actual === "string" && typeof expected === "string")
        )
      ) {
        throw new Error(`Operator "${operator}" requires two numbers or two strings`);
      }
      if (typeof actual === "number" && typeof expected === "number") {
        if (operator === "gt") return actual > expected;
        if (operator === "lt") return actual < expected;
        if (operator === "gte") return actual >= expected;
        return actual <= expected;
      }
      const actualString = actual as string;
      const expectedString = expected as string;
      if (operator === "gt") return actualString > expectedString;
      if (operator === "lt") return actualString < expectedString;
      if (operator === "gte") return actualString >= expectedString;
      return actualString <= expectedString;
    }
  }
}

function mouseButtonMask(button: "left" | "right" | "middle"): number {
  if (button === "left") return 1;
  if (button === "right") return 2;
  return 4;
}

function modifierMask(modifiers: InputModifier[]): number {
  return modifiers.reduce((mask, modifier) => {
    if (modifier === "Alt") return mask | 1;
    if (modifier === "Control") return mask | 2;
    if (modifier === "Meta") return mask | 4;
    return mask | 8;
  }, 0);
}

function toViewportAction(action: SimulatedInputAction, canvas: CanvasGeometry): SimulatedInputAction {
  const toViewport = (x: number, y: number, label: string) => {
    if (x > canvas.cssWidth || y > canvas.cssHeight) {
      throw new Error(
        `${label} (${x}, ${y}) is outside the ${canvas.cssWidth}x${canvas.cssHeight} CSS-pixel canvas`,
      );
    }
    return { x: canvas.left + x, y: canvas.top + y };
  };
  switch (action.type) {
    case "click":
    case "mouseMove":
      return { ...action, ...toViewport(action.x, action.y, "Canvas point") };
    case "touch": {
      const start = toViewport(action.x, action.y, "Canvas point");
      if (action.endX === undefined || action.endY === undefined) return { ...action, ...start };
      const end = toViewport(action.endX, action.endY, "Canvas end point");
      return { ...action, ...start, endX: end.x, endY: end.y };
    }
    case "key":
    case "type":
      return action;
  }
}

interface KeyDescriptor {
  key: string;
  code: string;
  windowsVirtualKeyCode: number;
  nativeVirtualKeyCode: number;
  text?: string;
}

function keyDescriptor(input: string): KeyDescriptor {
  const named: Record<string, Omit<KeyDescriptor, "nativeVirtualKeyCode">> = {
    Backspace: { key: "Backspace", code: "Backspace", windowsVirtualKeyCode: 8 },
    Tab: { key: "Tab", code: "Tab", windowsVirtualKeyCode: 9 },
    Enter: { key: "Enter", code: "Enter", windowsVirtualKeyCode: 13 },
    Shift: { key: "Shift", code: "ShiftLeft", windowsVirtualKeyCode: 16 },
    Control: { key: "Control", code: "ControlLeft", windowsVirtualKeyCode: 17 },
    Alt: { key: "Alt", code: "AltLeft", windowsVirtualKeyCode: 18 },
    Escape: { key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 },
    Space: { key: " ", code: "Space", windowsVirtualKeyCode: 32, text: " " },
    PageUp: { key: "PageUp", code: "PageUp", windowsVirtualKeyCode: 33 },
    PageDown: { key: "PageDown", code: "PageDown", windowsVirtualKeyCode: 34 },
    End: { key: "End", code: "End", windowsVirtualKeyCode: 35 },
    Home: { key: "Home", code: "Home", windowsVirtualKeyCode: 36 },
    ArrowLeft: { key: "ArrowLeft", code: "ArrowLeft", windowsVirtualKeyCode: 37 },
    ArrowUp: { key: "ArrowUp", code: "ArrowUp", windowsVirtualKeyCode: 38 },
    ArrowRight: { key: "ArrowRight", code: "ArrowRight", windowsVirtualKeyCode: 39 },
    ArrowDown: { key: "ArrowDown", code: "ArrowDown", windowsVirtualKeyCode: 40 },
    Delete: { key: "Delete", code: "Delete", windowsVirtualKeyCode: 46 },
    Meta: { key: "Meta", code: "MetaLeft", windowsVirtualKeyCode: 91 },
  };
  const known = named[input];
  if (known) return { ...known, nativeVirtualKeyCode: known.windowsVirtualKeyCode };

  if (/^F(?:[1-9]|1[0-2])$/u.test(input)) {
    const functionNumber = Number(input.slice(1));
    const virtualKeyCode = 111 + functionNumber;
    return {
      key: input,
      code: input,
      windowsVirtualKeyCode: virtualKeyCode,
      nativeVirtualKeyCode: virtualKeyCode,
    };
  }

  if ([...input].length === 1) {
    const upper = input.toUpperCase();
    const isLetter = /^[A-Z]$/u.test(upper);
    const isDigit = /^[0-9]$/u.test(input);
    const virtualKeyCode = upper.charCodeAt(0);
    return {
      key: input,
      code: isLetter ? `Key${upper}` : isDigit ? `Digit${input}` : input,
      windowsVirtualKeyCode: virtualKeyCode,
      nativeVirtualKeyCode: virtualKeyCode,
      text: input,
    };
  }

  return {
    key: input,
    code: input,
    windowsVirtualKeyCode: 0,
    nativeVirtualKeyCode: 0,
  };
}

function formatDiscoveryHost(host: string): string {
  if (!host || /[\s\/@?#]/u.test(host)) {
    throw new Error("CDP host must be a hostname or IP address without a URL scheme or path");
  }
  if (host.startsWith("[") && host.endsWith("]")) return host;
  return host.includes(":") ? `[${host}]` : host;
}

async function discoverPageTarget(
  host: string,
  port: number,
  timeoutMs: number,
): Promise<{ endpoint: string; target: ConnectedGame["target"] }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const url = `http://${formatDiscoveryHost(host)}:${port}/json/list`;

  try {
    const response = await fetch(url, { signal: controller.signal });
    if (!response.ok) {
      throw new Error(`CDP discovery returned HTTP ${response.status}`);
    }

    const body = await response.json();
    if (!Array.isArray(body)) {
      throw new Error("CDP discovery returned an invalid target list");
    }

    const target = (body as CdpTarget[]).find(
      (candidate) => candidate.type === "page" && typeof candidate.webSocketDebuggerUrl === "string",
    );
    if (!target?.webSocketDebuggerUrl) {
      throw new Error("CDP discovery found no page target with a WebSocket endpoint");
    }

    return {
      endpoint: target.webSocketDebuggerUrl,
      target: {
        id: target.id,
        title: target.title,
        url: target.url,
      },
    };
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") {
      throw new Error(`CDP discovery timed out after ${timeoutMs}ms`);
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

class CdpConnection {
  private readonly socket: WebSocket;
  private readonly pending = new Map<number, PendingRequest>();
  private nextRequestId = 1;
  private opened = false;
  private disconnected = false;
  private onDisconnect?: () => void;

  constructor(endpoint: string) {
    this.socket = new WebSocket(endpoint, {
      maxPayload: 4 * 1024 * 1024,
      perMessageDeflate: false,
    });
  }

  setDisconnectHandler(handler: () => void): void {
    this.onDisconnect = handler;
  }

  async open(timeoutMs: number): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        cleanup();
        this.socket.terminate();
        reject(new Error(`CDP WebSocket connection timed out after ${timeoutMs}ms`));
      }, timeoutMs);

      const cleanup = () => {
        clearTimeout(timer);
        this.socket.off("open", handleOpen);
        this.socket.off("error", handleError);
        this.socket.off("close", handleEarlyClose);
      };
      const handleOpen = () => {
        cleanup();
        this.opened = true;
        this.socket.on("message", this.handleMessage);
        this.socket.on("close", this.handleClose);
        this.socket.on("error", this.handleSocketError);
        resolve();
      };
      const handleError = (error: Error) => {
        cleanup();
        reject(new Error(`CDP WebSocket connection failed: ${error.message}`));
      };
      const handleEarlyClose = () => {
        cleanup();
        reject(new Error("CDP WebSocket closed before the connection was established"));
      };

      this.socket.once("open", handleOpen);
      this.socket.once("error", handleError);
      this.socket.once("close", handleEarlyClose);
    });
  }

  isOpen(): boolean {
    return this.opened && !this.disconnected && this.socket.readyState === WebSocket.OPEN;
  }

  async evaluateJson<T>(expression: string, timeoutMs = CDP_CALL_TIMEOUT_MS): Promise<T> {
    const response = await this.request<EvaluationResult>(
      "Runtime.evaluate",
      {
        expression,
        awaitPromise: true,
        returnByValue: true,
      },
      timeoutMs,
    );

    if (response.exceptionDetails) {
      const detail = response.exceptionDetails.exception?.description
        ?? response.exceptionDetails.text
        ?? "unknown evaluation error";
      throw new Error(`CDP evaluation failed: ${detail}`);
    }

    const remote = response.result;
    if (!remote) throw new Error("CDP evaluation returned no result");
    if (remote.type !== "string" || typeof remote.value !== "string") {
      const detail = remote.description ?? remote.unserializableValue ?? remote.type ?? "unknown";
      throw new Error(`CDP evaluation did not return serialized JSON (${detail})`);
    }

    try {
      return JSON.parse(remote.value) as T;
    } catch {
      throw new Error("CDP evaluation returned invalid serialized JSON");
    }
  }

  async command(
    method: string,
    params: Record<string, unknown>,
    timeoutMs = CDP_CALL_TIMEOUT_MS,
  ): Promise<unknown> {
    return this.request(method, params, timeoutMs);
  }

  async close(): Promise<void> {
    if (this.disconnected || this.socket.readyState === WebSocket.CLOSED) return;

    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        this.socket.terminate();
        resolve();
      }, 250);
      this.socket.once("close", () => {
        clearTimeout(timer);
        resolve();
      });
      this.socket.close(1000, "disconnect_from_game");
    });
  }

  terminate(): void {
    if (this.socket.readyState !== WebSocket.CLOSED) this.socket.terminate();
  }

  private async request<T>(
    method: string,
    params: Record<string, unknown>,
    timeoutMs: number,
  ): Promise<T> {
    if (!this.isOpen()) throw new Error("CDP connection is closed");

    const id = this.nextRequestId++;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`CDP ${method} timed out after ${timeoutMs}ms`));
      }, timeoutMs);

      this.pending.set(id, {
        resolve: (value) => resolve(value as T),
        reject,
        timer,
      });

      this.socket.send(JSON.stringify({ id, method, params }), (error) => {
        if (!error) return;
        const pending = this.pending.get(id);
        if (!pending) return;
        clearTimeout(pending.timer);
        this.pending.delete(id);
        pending.reject(new Error(`Failed to send CDP ${method}: ${error.message}`));
      });
    });
  }

  private readonly handleMessage = (data: RawData): void => {
    let message: CdpResponse;
    try {
      message = JSON.parse(rawDataToString(data)) as CdpResponse;
    } catch {
      return;
    }

    if (typeof message.id !== "number") return;
    const pending = this.pending.get(message.id);
    if (!pending) return;

    clearTimeout(pending.timer);
    this.pending.delete(message.id);
    if (message.error) {
      const code = message.error.code === undefined ? "" : ` ${message.error.code}`;
      pending.reject(new Error(`CDP error${code}: ${message.error.message ?? "unknown error"}`));
      return;
    }
    pending.resolve(message.result);
  };

  private readonly handleClose = (): void => {
    this.disconnect(new Error("CDP WebSocket connection closed"));
  };

  private readonly handleSocketError = (error: Error): void => {
    this.disconnect(new Error(`CDP WebSocket error: ${error.message}`));
    if (this.socket.readyState !== WebSocket.CLOSED) this.socket.terminate();
  };

  private disconnect(reason: Error): void {
    if (this.disconnected) return;
    this.disconnected = true;
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(reason);
    }
    this.pending.clear();
    this.onDisconnect?.();
  }
}

interface StoredConnection {
  cdp: CdpConnection;
}

export class RuntimeConnectionManager {
  private readonly connections = new Map<string, StoredConnection>();

  async connect(options: ConnectToGameOptions): Promise<ConnectedGame> {
    if (options.cdpEndpoint && (options.host !== undefined || options.port !== undefined)) {
      throw new Error("Provide either cdpEndpoint or host/port, not both");
    }

    let endpoint = options.cdpEndpoint;
    let target: ConnectedGame["target"];
    if (!endpoint) {
      const discovered = await discoverPageTarget(
        options.host ?? "localhost",
        options.port ?? 9222,
        options.timeoutMs,
      );
      endpoint = discovered.endpoint;
      target = discovered.target;
    }

    const connection = new CdpConnection(endpoint);
    try {
      await connection.open(options.timeoutMs);
      const gameState = await this.waitForBridge(connection, options.timeoutMs);
      const connectionId = randomUUID();
      connection.setDisconnectHandler(() => this.connections.delete(connectionId));
      this.connections.set(connectionId, { cdp: connection });
      return {
        connectionId,
        bridgeReady: true,
        gameState,
        target,
      };
    } catch (error) {
      connection.terminate();
      throw error;
    }
  }

  async disconnect(connectionId: string): Promise<boolean> {
    const stored = this.connections.get(connectionId);
    if (!stored) return false;
    this.connections.delete(connectionId);
    await stored.cdp.close();
    return true;
  }

  async callBridge(options: BridgeCallOptions): Promise<BridgeCallResult> {
    const connection = this.getConnection(options.connectionId);
    const startedAt = Date.now();
    const submitExpression = `(() => {
      const bridge = globalThis.__c3bridge;
      if (!bridge || typeof bridge.submit !== "function") {
        return JSON.stringify({ error: "Runtime bridge is not ready" });
      }
      const id = bridge.submit(${scriptLiteral(options.command)}, ${scriptLiteral(options.args)});
      return JSON.stringify({ id });
    })()`;
    const submitted = await connection.evaluateJson<{ id?: unknown; error?: string }>(
      submitExpression,
      Math.min(CDP_CALL_TIMEOUT_MS, options.timeoutMs),
    );
    if (submitted.error) throw new Error(submitted.error);
    if (typeof submitted.id !== "number" || !Number.isSafeInteger(submitted.id)) {
      throw new Error("Runtime bridge returned an invalid command ID");
    }

    const commandId = submitted.id;
    const pollExpression = `(() => {
      const bridge = globalThis.__c3bridge;
      if (!bridge || typeof bridge.getResult !== "function") {
        return JSON.stringify({ bridgeError: "Runtime bridge is not ready" });
      }
      return JSON.stringify({ bridgeResult: bridge.getResult(${commandId}) });
    })()`;

    while (Date.now() - startedAt < options.timeoutMs) {
      const remaining = options.timeoutMs - (Date.now() - startedAt);
      let polled: {
        bridgeError?: string;
        bridgeResult?: { ok?: boolean; value?: unknown; error?: unknown } | null;
      };
      try {
        polled = await connection.evaluateJson(
          pollExpression,
          Math.max(1, Math.min(CDP_CALL_TIMEOUT_MS, remaining)),
        );
      } catch (error) {
        // A poll clamped to the remaining budget can expire at the deadline;
        // report the command timeout rather than the internal CDP timeout.
        if (
          connection.isOpen()
          && Date.now() - startedAt >= options.timeoutMs
          && error instanceof Error
          && error.message.startsWith("CDP Runtime.evaluate timed out")
        ) {
          break;
        }
        throw error;
      }

      if (polled.bridgeError) throw new Error(polled.bridgeError);
      if (polled.bridgeResult !== null && polled.bridgeResult !== undefined) {
        if (polled.bridgeResult.ok !== true) {
          const detail = typeof polled.bridgeResult.error === "string"
            ? polled.bridgeResult.error
            : JSON.stringify(polled.bridgeResult.error ?? "unknown bridge error");
          throw new Error(`Runtime bridge command failed: ${detail}`);
        }
        return {
          commandId,
          result: polled.bridgeResult.value,
          elapsedMs: Date.now() - startedAt,
        };
      }

      const waitMs = Math.min(options.pollIntervalMs, options.timeoutMs - (Date.now() - startedAt));
      if (waitMs > 0) await delay(waitMs);
    }

    throw new Error(`Runtime bridge command timed out after ${options.timeoutMs}ms`);
  }

  async waitForCondition(options: WaitForConditionOptions): Promise<WaitForConditionResult> {
    const startedAt = Date.now();
    let finalValue: unknown = null;

    while (true) {
      const elapsedMs = Date.now() - startedAt;
      const remainingMs = options.timeoutMs - elapsedMs;
      if (remainingMs <= 0) {
        return { met: false, elapsedMs, finalValue };
      }

      try {
        finalValue = await this.readConditionValue(
          options.connectionId,
          options.condition,
          remainingMs,
        );
      } catch (error) {
        const afterReadElapsedMs = Date.now() - startedAt;
        if (afterReadElapsedMs >= options.timeoutMs && error instanceof Error && /timed out/iu.test(error.message)) {
          return { met: false, elapsedMs: afterReadElapsedMs, finalValue };
        }
        throw error;
      }

      const met = options.condition.type === "layout"
        ? Object.is(finalValue, options.condition.name)
        : compareValues(finalValue, options.condition.operator, options.condition.value);
      if (met) {
        return {
          met: true,
          elapsedMs: Date.now() - startedAt,
          finalValue,
        };
      }

      const waitMs = Math.min(
        options.pollIntervalMs,
        options.timeoutMs - (Date.now() - startedAt),
      );
      if (waitMs <= 0) {
        return {
          met: false,
          elapsedMs: Date.now() - startedAt,
          finalValue,
        };
      }
      await delay(waitMs);
    }
  }

  async getCanvasGeometry(connectionId: string): Promise<CanvasGeometry> {
    const connection = this.getConnection(connectionId);
    const expression = `(() => {
      const canvas = document.querySelector("canvas");
      if (!canvas) return JSON.stringify(null);
      const rect = canvas.getBoundingClientRect();
      return JSON.stringify({
        left: rect.left,
        top: rect.top,
        cssWidth: rect.width,
        cssHeight: rect.height,
        backingWidth: canvas.width,
        backingHeight: canvas.height,
        devicePixelRatio: globalThis.devicePixelRatio,
        viewportWidth: globalThis.innerWidth,
        viewportHeight: globalThis.innerHeight,
      });
    })()`;
    const geometry = await connection.evaluateJson<CanvasGeometry | null>(expression);
    if (!geometry) throw new Error("No canvas element was found in the connected page");
    return geometry;
  }

  async simulateInput(options: SimulateInputOptions): Promise<SimulateInputResult> {
    const connection = this.getConnection(options.connectionId);
    if (
      options.action.type === "touch"
      && options.action.gesture === "swipe"
      && (options.action.endX === undefined || options.action.endY === undefined)
    ) {
      throw new Error("Swipe gestures require endX and endY");
    }
    if (options.delayMs > 0) await delay(options.delayMs);

    let action: SimulatedInputAction;
    if (options.coordinateSpace === "canvas") {
      action = toViewportAction(options.action, await this.getCanvasGeometry(options.connectionId));
    } else if (options.coordinateSpace === "layout") {
      action = await this.layoutToViewportAction(options.connectionId, options.action, options.layer ?? 0);
    } else {
      action = options.action;
    }

    switch (action.type) {
      case "click": {
        const buttons = mouseButtonMask(action.button);
        const common = {
          x: action.x,
          y: action.y,
          button: action.button,
          clickCount: action.clickCount,
        };
        await connection.command("Input.dispatchMouseEvent", {
          type: "mousePressed",
          ...common,
          buttons,
        });
        await connection.command("Input.dispatchMouseEvent", {
          type: "mouseReleased",
          ...common,
          buttons: 0,
        });
        break;
      }
      case "mouseMove":
        await connection.command("Input.dispatchMouseEvent", {
          type: "mouseMoved",
          x: action.x,
          y: action.y,
          button: "none",
          buttons: 0,
        });
        break;
      case "touch":
        await connection.command("Emulation.setTouchEmulationEnabled", {
          enabled: true,
          maxTouchPoints: 5,
        });
        await this.dispatchTouch(connection, action);
        break;
      case "key": {
        const modifiers = modifierMask(action.modifiers);
        const descriptor = keyDescriptor(action.key);
        const { text, ...identity } = descriptor;
        await connection.command("Input.dispatchKeyEvent", {
          type: "keyDown",
          modifiers,
          ...identity,
          ...((modifiers & 7) === 0 && text !== undefined ? { text } : {}),
        });
        await connection.command("Input.dispatchKeyEvent", {
          type: "keyUp",
          modifiers,
          ...identity,
        });
        break;
      }
      case "type":
        for (const character of action.text) {
          await connection.command("Input.insertText", { text: character });
        }
        break;
    }

    return { success: true, action: action.type };
  }

  /**
   * Convert an action's layout coordinates to viewport CSS pixels through the
   * game's own layer transform (the bridge's `layerToCssPx`), so scaling,
   * letterboxing and the canvas offset are Construct's arithmetic, not ours.
   */
  private async layoutToViewportAction(
    connectionId: string,
    action: SimulatedInputAction,
    layer: string | number,
  ): Promise<SimulatedInputAction> {
    const convert = async (x: number, y: number): Promise<{ x: number; y: number }> => {
      const { result } = await this.callBridge({
        connectionId,
        command: "layerToCssPx",
        args: { layer, x, y },
        pollIntervalMs: 20,
        timeoutMs: 5_000,
      });
      const point = result as { x?: unknown; y?: unknown; error?: unknown } | null;
      if (!point || typeof point.x !== "number" || typeof point.y !== "number") {
        const reason = point && typeof point.error === "string" ? point.error : "the bridge returned no point";
        throw new Error(`Could not convert layout coordinates on layer ${JSON.stringify(layer)}: ${reason}. Inject the current bridge (inject_runtime_bridge) if the game runs an older one.`);
      }
      return { x: point.x, y: point.y };
    };
    if (action.type === "key" || action.type === "type") return action;
    const start = await convert(action.x, action.y);
    if (action.type === "touch" && action.endX !== undefined && action.endY !== undefined) {
      const end = await convert(action.endX, action.endY);
      return { ...action, x: start.x, y: start.y, endX: end.x, endY: end.y };
    }
    return { ...action, x: start.x, y: start.y };
  }

  /** Capture the connected page, or only its game canvas, as PNG or JPEG bytes. */
  async captureScreenshot(options: ScreenshotOptions): Promise<ScreenshotResult> {
    const connection = this.getConnection(options.connectionId);
    const params: Record<string, unknown> = { format: options.format };
    if (options.format === "jpeg" && options.quality !== undefined) params.quality = options.quality;
    let clip: ScreenshotResult["clip"];
    if (options.canvasOnly) {
      const canvas = await this.getCanvasGeometry(options.connectionId);
      clip = { x: canvas.left, y: canvas.top, width: canvas.cssWidth, height: canvas.cssHeight };
      params.clip = { ...clip, scale: 1 };
    }
    const captured = await connection.command("Page.captureScreenshot", params) as { data?: unknown };
    if (!captured || typeof captured.data !== "string") throw new Error("Page.captureScreenshot returned no image data");
    return { data: Buffer.from(captured.data, "base64"), format: options.format, clip };
  }

  async closeAll(): Promise<void> {
    const connections = [...this.connections.values()];
    this.connections.clear();
    for (const { cdp } of connections) cdp.terminate();
  }

  private getConnection(connectionId: string): CdpConnection {
    const stored = this.connections.get(connectionId);
    if (!stored || !stored.cdp.isOpen()) {
      this.connections.delete(connectionId);
      throw new Error(`Unknown or closed connection: ${connectionId}`);
    }
    return stored.cdp;
  }

  private async readConditionValue(
    connectionId: string,
    condition: RuntimeCondition,
    timeoutMs: number,
  ): Promise<unknown> {
    if (condition.type === "expression") {
      const connection = this.getConnection(connectionId);
      const expression = `(async () => {
        const value = await (0, eval)(${scriptLiteral(condition.expr)});
        return JSON.stringify({ value: value === undefined ? null : value });
      })()`;
      const evaluated = await connection.evaluateJson<{ value: unknown }>(expression, timeoutMs);
      return evaluated.value;
    }

    const command = condition.type === "globalVar"
      ? "getGlobalVar"
      : condition.type === "objectProperty"
        ? "getObjectState"
        : "getLayout";
    const args = condition.type === "globalVar"
      ? { name: condition.name }
      : condition.type === "objectProperty"
        ? { objectName: condition.objectType, properties: [condition.property] }
        : {};
    const called = await this.callBridge({
      connectionId,
      command,
      args,
      pollIntervalMs: 10,
      timeoutMs,
    });

    if (condition.type === "globalVar") return called.result;
    if (!called.result || typeof called.result !== "object") {
      throw new Error(`Runtime bridge ${command} returned an invalid result`);
    }
    const result = called.result as Record<string, unknown>;
    if (typeof result.error === "string") throw new Error(result.error);
    if (condition.type === "layout") return result.name;
    if (Object.hasOwn(result, condition.property)) return result[condition.property];
    const instanceVariables = result._instVars;
    if (
      instanceVariables
      && typeof instanceVariables === "object"
      && Object.hasOwn(instanceVariables, condition.property)
    ) {
      return (instanceVariables as Record<string, unknown>)[condition.property];
    }
    throw new Error(
      `Object property "${condition.objectType}.${condition.property}" was not returned by the runtime bridge`,
    );
  }

  private async dispatchTouch(
    connection: CdpConnection,
    action: Extract<SimulatedInputAction, { type: "touch" }>,
  ): Promise<void> {
    const point = (x: number, y: number) => ({
      x,
      y,
      id: 1,
      radiusX: 1,
      radiusY: 1,
      force: 1,
    });
    await connection.command("Input.dispatchTouchEvent", {
      type: "touchStart",
      touchPoints: [point(action.x, action.y)],
    });

    if (action.gesture === "longPress") {
      await delay(LONG_PRESS_MS);
    } else if (action.gesture === "swipe") {
      if (action.endX === undefined || action.endY === undefined) {
        throw new Error("Swipe gestures require endX and endY");
      }
      for (let step = 1; step <= SWIPE_STEPS; step++) {
        const progress = step / SWIPE_STEPS;
        await delay(SWIPE_STEP_MS);
        await connection.command("Input.dispatchTouchEvent", {
          type: "touchMove",
          touchPoints: [point(
            action.x + ((action.endX - action.x) * progress),
            action.y + ((action.endY - action.y) * progress),
          )],
        });
      }
    }

    await connection.command("Input.dispatchTouchEvent", {
      type: "touchEnd",
      touchPoints: [],
    });
  }

  private async waitForBridge(connection: CdpConnection, timeoutMs: number): Promise<GameState> {
    const startedAt = Date.now();
    const expression = `(() => {
      const bridge = globalThis.__c3bridge;
      if (!bridge || typeof bridge.getState !== "function") return JSON.stringify(null);
      return JSON.stringify(bridge.getState());
    })()`;

    while (Date.now() - startedAt < timeoutMs) {
      const remaining = timeoutMs - (Date.now() - startedAt);
      try {
        const state = await connection.evaluateJson<GameState | null>(
          expression,
          Math.max(1, Math.min(CDP_CALL_TIMEOUT_MS, remaining)),
        );
        if (state?.ready === true) return state;
      } catch (error) {
        if (!connection.isOpen()) throw error;
      }

      const waitMs = Math.min(BRIDGE_POLL_INTERVAL_MS, timeoutMs - (Date.now() - startedAt));
      if (waitMs > 0) await delay(waitMs);
    }

    throw new Error(
      `Runtime bridge was not ready after ${timeoutMs}ms. Inject the bridge and launch the game in DOM mode.`,
    );
  }
}
