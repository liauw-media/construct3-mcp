/**
 * Minimal Chrome DevTools Protocol client for Construct runtime control.
 *
 * The client intentionally implements only the CDP methods the runtime tools
 * need. Keeping the protocol surface small avoids a heavyweight browser
 * automation dependency while still supporting persistent game connections.
 * It talks to the browser through the WebSocket client Node.js has built in
 * from version 22, which puts no limit on the size of a message (a
 * screenshot arrives as one base64 message of several MiB).
 */

import { randomUUID } from "node:crypto";
import { isLoopbackHost } from "./preview-server.js";

const BRIDGE_POLL_INTERVAL_MS = 100;
const CDP_CALL_TIMEOUT_MS = 5_000;
const LONG_PRESS_MS = 500;
const SWIPE_STEPS = 8;
const SWIPE_STEP_MS = 16;
/**
 * Once one page's bridge answered ready, how long the other pages still get
 * to finish their first check: a second ready bridge makes the choice
 * ambiguous, and connect_to_game refuses to guess.
 */
const SECOND_BRIDGE_GRACE_MS = 1_500;

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
  /** Discovery only: consider only pages whose origin and path (not query or fragment) contain this text. */
  urlContains?: string;
  /** Discovery only: consider only pages of this URL's origin whose path starts with its path. */
  pageUrl?: string;
  /** Follow page endpoints the browser lists on other hosts (C3MCP_ALLOW_REMOTE_CDP=1). */
  allowRemoteHosts?: boolean;
  /** For connecting as a whole: discovery, opening and waiting for the bridge. */
  timeoutMs: number;
}

export interface ConnectedGame {
  connectionId: string;
  bridgeReady: true;
  /** Where the bridge answered: on the page itself, or in a dedicated worker of it (Construct's "Use worker"). */
  bridgeContext: "page" | "worker";
  /** False when the page stayed hidden after it was brought to the front (a background tab or a minimized window). */
  pageVisible?: boolean;
  warning?: string;
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
    /** "keys" (default): a key press per character; "insertText": the text inserted at once, as an IME would. */
    mode?: "keys" | "insertText";
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
  /** Events carry a method and params instead of an id. */
  method?: string;
  params?: Record<string, unknown>;
  sessionId?: string;
}

type CdpEventHandler = (method: string, params: Record<string, unknown>, sessionId: string | undefined) => void;

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

/**
 * True when the server was started with C3MCP_ALLOW_EVAL=1, which allows
 * wait_for_condition to run caller-supplied JavaScript in the game page.
 * An environment setting, not a tool parameter: the caller who writes the
 * expression must not be the one who allows it.
 */
export function pageEvaluationAllowed(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.C3MCP_ALLOW_EVAL === "1";
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

type WebSocketClient = InstanceType<typeof globalThis.WebSocket>;

/** The WebSocket class Node.js provides from version 22, or an error naming the version needed. */
export function webSocketClass(): typeof globalThis.WebSocket {
  const constructor = (globalThis as { WebSocket?: typeof globalThis.WebSocket }).WebSocket;
  if (typeof constructor !== "function") {
    throw new Error(
      `The runtime connection needs the WebSocket client built into Node.js 22 and later; this server runs on Node.js ${process.version}. Start it with Node.js 22 or later.`,
    );
  }
  return constructor;
}

function messageText(data: unknown): string | undefined {
  if (typeof data === "string") return data;
  if (data instanceof ArrayBuffer) return Buffer.from(data).toString("utf8");
  if (ArrayBuffer.isView(data)) return Buffer.from(data.buffer, data.byteOffset, data.byteLength).toString("utf8");
  return undefined;
}

function eventMessage(event: unknown): string {
  const candidate = event as { message?: unknown; error?: { message?: unknown } } | null;
  if (candidate && typeof candidate.message === "string" && candidate.message) return candidate.message;
  if (candidate?.error && typeof candidate.error.message === "string") return candidate.error.message;
  return "unknown WebSocket error";
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
  /** The character needs Shift on a US keyboard (A-Z, !, ?, ...). */
  shift?: boolean;
}

/**
 * The keys of a US keyboard's main block that type a character, by the
 * character they type unshifted and shifted: DOM code and Windows virtual
 * key code (the keyCode a page sees).
 */
const CHARACTER_KEYS: Array<[unshifted: string, shifted: string, code: string, keyCode: number]> = [
  ["`", "~", "Backquote", 192],
  ["1", "!", "Digit1", 49], ["2", "@", "Digit2", 50], ["3", "#", "Digit3", 51], ["4", "$", "Digit4", 52],
  ["5", "%", "Digit5", 53], ["6", "^", "Digit6", 54], ["7", "&", "Digit7", 55], ["8", "*", "Digit8", 56],
  ["9", "(", "Digit9", 57], ["0", ")", "Digit0", 48],
  ["-", "_", "Minus", 189], ["=", "+", "Equal", 187],
  ["[", "{", "BracketLeft", 219], ["]", "}", "BracketRight", 221], ["\\", "|", "Backslash", 220],
  [";", ":", "Semicolon", 186], ["'", '"', "Quote", 222],
  [",", "<", "Comma", 188], [".", ">", "Period", 190], ["/", "?", "Slash", 191],
];

const CHARACTERS = new Map<string, { code: string; keyCode: number; shift: boolean }>();
for (const [unshifted, shifted, code, keyCode] of CHARACTER_KEYS) {
  CHARACTERS.set(unshifted, { code, keyCode, shift: false });
  CHARACTERS.set(shifted, { code, keyCode, shift: true });
}
for (let letter = 65; letter <= 90; letter++) {
  const upper = String.fromCharCode(letter);
  CHARACTERS.set(upper.toLowerCase(), { code: `Key${upper}`, keyCode: letter, shift: false });
  CHARACTERS.set(upper, { code: `Key${upper}`, keyCode: letter, shift: true });
}

const NAMED_KEYS: Record<string, Omit<KeyDescriptor, "nativeVirtualKeyCode">> = {
  Backspace: { key: "Backspace", code: "Backspace", windowsVirtualKeyCode: 8 },
  Tab: { key: "Tab", code: "Tab", windowsVirtualKeyCode: 9 },
  Enter: { key: "Enter", code: "Enter", windowsVirtualKeyCode: 13, text: "\r" },
  Shift: { key: "Shift", code: "ShiftLeft", windowsVirtualKeyCode: 16 },
  Control: { key: "Control", code: "ControlLeft", windowsVirtualKeyCode: 17 },
  Alt: { key: "Alt", code: "AltLeft", windowsVirtualKeyCode: 18 },
  Pause: { key: "Pause", code: "Pause", windowsVirtualKeyCode: 19 },
  CapsLock: { key: "CapsLock", code: "CapsLock", windowsVirtualKeyCode: 20 },
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
  Insert: { key: "Insert", code: "Insert", windowsVirtualKeyCode: 45 },
  Delete: { key: "Delete", code: "Delete", windowsVirtualKeyCode: 46 },
  Meta: { key: "Meta", code: "MetaLeft", windowsVirtualKeyCode: 91 },
  ContextMenu: { key: "ContextMenu", code: "ContextMenu", windowsVirtualKeyCode: 93 },
};

/**
 * What to dispatch for a key name (Enter, ArrowLeft, F5, Space...) or a
 * single character. Characters get the DOM code and keyCode of the US
 * keyboard key that types them ("." is Period, 190), and characters typed
 * with Shift say so; a character no key types gets its text alone.
 */
function keyDescriptor(input: string): KeyDescriptor {
  const known = NAMED_KEYS[input];
  if (known) return { ...known, nativeVirtualKeyCode: known.windowsVirtualKeyCode };

  if (/^F(?:[1-9]|1[0-9]|2[0-4])$/u.test(input)) {
    const virtualKeyCode = 111 + Number(input.slice(1));
    return { key: input, code: input, windowsVirtualKeyCode: virtualKeyCode, nativeVirtualKeyCode: virtualKeyCode };
  }

  if (input === "\n" || input === "\r") return keyDescriptor("Enter");
  if (input === "\t") return keyDescriptor("Tab");
  if (input === " ") return keyDescriptor("Space");

  const character = CHARACTERS.get(input);
  if (character) {
    return {
      key: input,
      code: character.code,
      windowsVirtualKeyCode: character.keyCode,
      nativeVirtualKeyCode: character.keyCode,
      text: input,
      shift: character.shift,
    };
  }

  if ([...input].length === 1) {
    return { key: input, code: "", windowsVirtualKeyCode: 0, nativeVirtualKeyCode: 0, text: input };
  }

  return { key: input, code: input, windowsVirtualKeyCode: 0, nativeVirtualKeyCode: 0 };
}

/** Press and release one key: keyDown (with its text unless Control, Alt or Meta is held) and keyUp. */
async function pressKey(connection: CdpConnection, descriptor: KeyDescriptor, modifierBits: number): Promise<void> {
  const { text, shift, ...identity } = descriptor;
  const modifiers = modifierBits | (shift ? 8 : 0);
  await connection.command("Input.dispatchKeyEvent", {
    type: "keyDown",
    modifiers,
    ...identity,
    ...((modifiers & 7) === 0 && text !== undefined ? { text, unmodifiedText: text } : {}),
  });
  await connection.command("Input.dispatchKeyEvent", {
    type: "keyUp",
    modifiers,
    ...identity,
  });
}

/** The host name of a ws:// endpoint, or the endpoint itself when it does not parse (and so is no loopback name). */
function endpointHost(endpoint: string): string {
  try {
    return new URL(endpoint).hostname;
  } catch {
    return endpoint;
  }
}

function formatDiscoveryHost(host: string): string {
  if (!host || /[\s\/@?#]/u.test(host)) {
    throw new Error("CDP host must be a hostname or IP address without a URL scheme or path");
  }
  if (host.startsWith("[") && host.endsWith("]")) return host;
  return host.includes(":") ? `[${host}]` : host;
}

interface PageCandidate {
  endpoint: string;
  target?: ConnectedGame["target"];
}

/** A page URL's origin and path, without query and fragment: what urlContains is matched against. */
function originAndPath(url: string | undefined): string {
  if (typeof url !== "string") return "";
  try {
    const parsed = new URL(url);
    return parsed.origin === "null" ? `${parsed.protocol}${parsed.pathname}` : `${parsed.origin}${parsed.pathname}`;
  } catch {
    return url.split(/[?#]/u)[0];
  }
}

/** True when `url` has `wanted`'s origin and a path that starts with `wanted`'s path. */
function isUnderPageUrl(url: string | undefined, wanted: URL): boolean {
  if (typeof url !== "string") return false;
  try {
    const parsed = new URL(url);
    return parsed.origin !== "null" && parsed.origin === wanted.origin && parsed.pathname.startsWith(wanted.pathname);
  } catch {
    return false;
  }
}

interface PageFilter {
  urlContains?: string;
  pageUrl?: URL;
}

/**
 * The page targets a browser's debugging port lists, in its order, narrowed
 * by `filter`. A page endpoint on another host than this machine is refused
 * unless `allowRemoteHosts`: a debugging port reached on 127.0.0.1 has no
 * reason to send the connection elsewhere.
 */
async function discoverPageTargets(
  host: string,
  port: number,
  timeoutMs: number,
  filter: PageFilter,
  allowRemoteHosts: boolean,
): Promise<PageCandidate[]> {
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

    const pages = (body as CdpTarget[]).filter(
      (candidate) => candidate.type === "page" && typeof candidate.webSocketDebuggerUrl === "string",
    );
    if (pages.length === 0) {
      throw new Error("CDP discovery found no page target with a WebSocket endpoint");
    }
    if (!allowRemoteHosts) {
      const elsewhere = [...new Set(pages
        .map((page) => endpointHost(page.webSocketDebuggerUrl!))
        .filter((endpoint) => !isLoopbackHost(endpoint)))];
      if (elsewhere.length > 0) {
        throw new Error(
          `The debugging port lists page endpoints on another host (${elsewhere.join(", ")}); refusing to follow them. Only this machine is reached unless the server was started with the environment variable C3MCP_ALLOW_REMOTE_CDP=1.`,
        );
      }
    }
    const matching = pages.filter((candidate) =>
      (filter.urlContains === undefined || originAndPath(candidate.url).includes(filter.urlContains))
      && (filter.pageUrl === undefined || isUnderPageUrl(candidate.url, filter.pageUrl)));
    if (matching.length === 0) {
      const wanted = [
        filter.urlContains !== undefined ? `whose origin and path contain ${JSON.stringify(filter.urlContains)}` : undefined,
        filter.pageUrl !== undefined ? `under ${filter.pageUrl.href}` : undefined,
      ].filter(Boolean).join(" and ");
      throw new Error(
        `No page ${wanted}; the open pages are ${pages.map((page) => page.url ?? "(no URL)").join(", ")}`,
      );
    }

    return matching.map((target) => ({
      endpoint: target.webSocketDebuggerUrl!,
      target: {
        id: target.id,
        title: target.title,
        url: target.url,
      },
    }));
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
  private readonly socket: WebSocketClient;
  private readonly pending = new Map<number, PendingRequest>();
  private nextRequestId = 1;
  private opened = false;
  private disconnected = false;
  private onDisconnect?: () => void;
  private readonly eventHandlers = new Set<CdpEventHandler>();

  constructor(endpoint: string) {
    const WebSocketImpl = webSocketClass();
    this.socket = new WebSocketImpl(endpoint);
    this.socket.binaryType = "arraybuffer";
  }

  setDisconnectHandler(handler: () => void): void {
    this.onDisconnect = handler;
  }

  /** Listen to CDP events (from the page, or from a session attached to it); returns the unsubscribe function. */
  onEvent(handler: CdpEventHandler): () => void {
    this.eventHandlers.add(handler);
    return () => this.eventHandlers.delete(handler);
  }

  async open(timeoutMs: number): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        cleanup();
        this.terminate();
        reject(new Error(`CDP WebSocket connection timed out after ${timeoutMs}ms`));
      }, timeoutMs);

      const cleanup = () => {
        clearTimeout(timer);
        this.socket.removeEventListener("open", handleOpen);
        this.socket.removeEventListener("error", handleError);
        this.socket.removeEventListener("close", handleEarlyClose);
      };
      const handleOpen = () => {
        cleanup();
        this.opened = true;
        this.socket.addEventListener("message", this.handleMessage);
        this.socket.addEventListener("close", this.handleClose);
        this.socket.addEventListener("error", this.handleSocketError);
        resolve();
      };
      const handleError = (event: unknown) => {
        cleanup();
        this.terminate();
        reject(new Error(`CDP WebSocket connection failed: ${eventMessage(event)}`));
      };
      const handleEarlyClose = () => {
        cleanup();
        reject(new Error("CDP WebSocket closed before the connection was established"));
      };

      this.socket.addEventListener("open", handleOpen);
      this.socket.addEventListener("error", handleError);
      this.socket.addEventListener("close", handleEarlyClose);
    });
  }

  isOpen(): boolean {
    return this.opened && !this.disconnected && this.socket.readyState === this.socket.OPEN;
  }

  /** Evaluate `expression`, which returns a JSON string, on the page or in the attached session `sessionId`. */
  async evaluateJson<T>(expression: string, timeoutMs = CDP_CALL_TIMEOUT_MS, sessionId?: string): Promise<T> {
    const response = await this.request<EvaluationResult>(
      "Runtime.evaluate",
      {
        expression,
        awaitPromise: true,
        returnByValue: true,
      },
      timeoutMs,
      sessionId,
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
    sessionId?: string,
  ): Promise<unknown> {
    return this.request(method, params, timeoutMs, sessionId);
  }

  async close(): Promise<void> {
    if (this.disconnected || this.socket.readyState === this.socket.CLOSED) return;

    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, 250);
      this.socket.addEventListener("close", () => {
        clearTimeout(timer);
        resolve();
      }, { once: true });
      this.terminate();
    });
  }

  /** Start closing the socket without waiting for the browser's answer. */
  terminate(): void {
    const state = this.socket.readyState;
    if (state === this.socket.CLOSED || state === this.socket.CLOSING) return;
    try {
      this.socket.close(1000, "disconnect_from_game");
    } catch {
      // closing an unopened socket can throw; it is going away either way
    }
  }

  private async request<T>(
    method: string,
    params: Record<string, unknown>,
    timeoutMs: number,
    sessionId?: string,
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

      try {
        this.socket.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
      } catch (error) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(new Error(`Failed to send CDP ${method}: ${error instanceof Error ? error.message : String(error)}`));
      }
    });
  }

  private readonly handleMessage = (event: { data: unknown }): void => {
    const text = messageText(event.data);
    if (text === undefined) return;
    let message: CdpResponse;
    try {
      message = JSON.parse(text) as CdpResponse;
    } catch {
      return;
    }

    if (typeof message.id !== "number") {
      if (typeof message.method === "string") {
        for (const handler of this.eventHandlers) {
          try {
            handler(message.method, message.params ?? {}, message.sessionId);
          } catch {
            // a listener's failure is not the connection's
          }
        }
      }
      return;
    }
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

  private readonly handleSocketError = (event: unknown): void => {
    this.disconnect(new Error(`CDP WebSocket error: ${eventMessage(event)}`));
    this.terminate();
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
  /** The attached worker session the bridge answers in; undefined when it runs on the page. */
  bridgeSessionId?: string;
}

interface FoundBridge {
  state: GameState;
  sessionId?: string;
}

const HIDDEN_PAGE_WARNING = "The game page is hidden (a background tab or a minimized window) and stayed hidden after it was brought to the front. A hidden page runs no animation frames, so the game does not tick: bridge calls time out and mouse moves can hang. Show the tab or window, or use a separate browser window for the game.";

export class RuntimeConnectionManager {
  private readonly connections = new Map<string, StoredConnection>();

  async connect(options: ConnectToGameOptions): Promise<ConnectedGame> {
    if (options.cdpEndpoint && (options.host !== undefined || options.port !== undefined || options.urlContains !== undefined || options.pageUrl !== undefined)) {
      throw new Error("Provide either cdpEndpoint or host/port (with urlContains or pageUrl), not both");
    }
    let pageUrl: URL | undefined;
    if (options.pageUrl !== undefined) {
      try {
        pageUrl = new URL(options.pageUrl);
      } catch {
        throw new Error(`pageUrl is not a URL: ${JSON.stringify(options.pageUrl)}`);
      }
      if (pageUrl.origin === "null") throw new Error(`pageUrl needs an http(s) origin: ${JSON.stringify(options.pageUrl)}`);
    }
    const deadline = Date.now() + options.timeoutMs;
    const remaining = () => Math.max(1, deadline - Date.now());

    const candidates: PageCandidate[] = options.cdpEndpoint
      ? [{ endpoint: options.cdpEndpoint }]
      : await discoverPageTargets(
        options.host ?? "127.0.0.1",
        options.port ?? 9222,
        remaining(),
        { urlContains: options.urlContains, pageUrl },
        options.allowRemoteHosts === true,
      );

    // Every candidate page is tried at once, so a browser with the editor or
    // other tabs open still reaches the game's tab. Once a bridge answers
    // ready, the other pages get a short grace to finish their first check:
    // a second ready bridge (another game, or another site that defines one)
    // makes the choice ambiguous, and it is refused instead of raced.
    const opened: CdpConnection[] = [];
    const failures: Error[] = [];
    const ready: Array<{ connection: CdpConnection; found: FoundBridge; candidate: PageCandidate }> = [];
    let firstReadyAt: number | undefined;
    await new Promise<void>((resolve) => {
      let pending = candidates.length;
      let grace: NodeJS.Timeout | undefined;
      const finish = () => { if (grace) clearTimeout(grace); resolve(); };
      const settle = () => { if (--pending === 0) finish(); };
      const pastGrace = () => firstReadyAt !== undefined && Date.now() >= firstReadyAt + SECOND_BRIDGE_GRACE_MS;
      for (const candidate of candidates) {
        void (async () => {
          try {
            const connection = new CdpConnection(candidate.endpoint);
            opened.push(connection);
            await connection.open(remaining());
            if (pastGrace()) return;
            const found = await this.findBridge(
              connection,
              deadline,
              (rounds) => firstReadyAt !== undefined && (rounds >= 1 || pastGrace()),
            );
            if (found && !pastGrace()) {
              ready.push({ connection, found, candidate });
              if (firstReadyAt === undefined) {
                firstReadyAt = Date.now();
                grace = setTimeout(finish, SECOND_BRIDGE_GRACE_MS);
              }
            }
          } catch (error) {
            failures.push(error instanceof Error ? error : new Error(String(error)));
          } finally {
            settle();
          }
        })();
      }
    });
    const winner = ready.length === 1 ? ready[0] : undefined;
    for (const connection of opened) if (connection !== winner?.connection) connection.terminate();

    if (ready.length > 1) {
      const pages = ready.map((page) => page.candidate.target?.url ?? page.candidate.endpoint).join(", ");
      throw new Error(
        `${ready.length} pages have a ready runtime bridge (${pages}); connect_to_game does not guess which is the game. Name it with pageUrl (the game's URL, such as the url serve_preview returns), urlContains, or cdpEndpoint (serve_preview's pageEndpoint).`,
      );
    }
    if (!winner) {
      if (failures.length === candidates.length) throw failures[0];
      const pages = candidates.map((candidate) => candidate.target?.url ?? candidate.endpoint).join(", ");
      throw new Error(
        `Runtime bridge was not ready after ${options.timeoutMs}ms in ${candidates.length === 1 ? "the page" : `any of ${candidates.length} pages`} (${pages}). Inject the bridge (inject_runtime_bridge) before exporting or previewing, check the game has started, and pick its tab with pageUrl, urlContains or cdpEndpoint if the browser shows several.`,
      );
    }

    const { connection, found, candidate } = winner;
    const connectionId = randomUUID();
    connection.setDisconnectHandler(() => this.connections.delete(connectionId));
    if (found.sessionId) {
      // A worker that ends (the page reloaded or closed) takes the bridge with it.
      connection.onEvent((method, params) => {
        if (method === "Target.detachedFromTarget" && params.sessionId === found.sessionId) {
          this.connections.delete(connectionId);
          connection.terminate();
        }
      });
    }
    this.connections.set(connectionId, { cdp: connection, bridgeSessionId: found.sessionId });
    const pageVisible = await this.bringToFront(connection);
    return {
      connectionId,
      bridgeReady: true,
      bridgeContext: found.sessionId ? "worker" : "page",
      pageVisible,
      ...(pageVisible === false ? { warning: HIDDEN_PAGE_WARNING } : {}),
      gameState: found.state,
      target: candidate.target,
    };
  }

  /**
   * Bring the game's tab to the front (Page.bringToFront), then report
   * whether the page is visible: a hidden page does not tick. Undefined
   * when the page could not tell.
   */
  private async bringToFront(connection: CdpConnection): Promise<boolean | undefined> {
    try {
      await connection.command("Page.bringToFront", {}, 2_000);
    } catch {
      // not every target can be activated; visibility still tells
    }
    try {
      const state = await connection.evaluateJson<unknown>("JSON.stringify(document.visibilityState)", 2_000);
      return state === "hidden" ? false : state === "visible" ? true : undefined;
    } catch {
      return undefined;
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
    const { cdp: connection, bridgeSessionId } = this.getStored(options.connectionId);
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
      bridgeSessionId,
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
          bridgeSessionId,
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

    const withdrawn = await this.withdrawCommand(connection, commandId, bridgeSessionId);
    throw new Error(`Runtime bridge command timed out after ${options.timeoutMs}ms; ${withdrawn}`);
  }

  /**
   * Withdraw a command the caller stopped waiting for, so it does not run
   * later (a game that does not tick, in a background tab for instance,
   * runs its queued commands once it ticks again). Returns what happened, as
   * the second half of the timeout message.
   */
  private async withdrawCommand(connection: CdpConnection, commandId: number, sessionId: string | undefined): Promise<string> {
    const stale = "it may still run later (the game's bridge cannot withdraw commands; inject the current bridge)";
    if (!connection.isOpen()) return stale;
    try {
      const answer = await connection.evaluateJson<{ cancelled?: unknown }>(`(() => {
        const bridge = globalThis.__c3bridge;
        if (!bridge || typeof bridge.cancel !== "function") return JSON.stringify({ cancelled: "unsupported" });
        return JSON.stringify({ cancelled: bridge.cancel(${commandId}) });
      })()`, 1_000, sessionId);
      if (answer.cancelled === "queued") {
        return "it had not run yet and was withdrawn, so it will not run (a game that does not tick, such as one in a background tab, runs no commands)";
      }
      if (answer.cancelled === "result") return "it ran after all, too late; its result was discarded";
      if (answer.cancelled === false) return "the bridge no longer knew it (the page may have reloaded)";
      return stale;
    } catch {
      return stale;
    }
  }

  async waitForCondition(options: WaitForConditionOptions): Promise<WaitForConditionResult> {
    if (options.condition.type === "expression" && !pageEvaluationAllowed()) {
      throw new Error(
        'Condition type "expression" runs JavaScript in the game page and is off unless the server was started with the environment variable C3MCP_ALLOW_EVAL=1. Use a globalVar, objectProperty or layout condition, or ask whoever runs the server to set it.',
      );
    }
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
        // Touch emulation only for the gesture: left on, the page would keep
        // reporting a touch screen (navigator.maxTouchPoints) and a game
        // could switch its input mode.
        await connection.command("Emulation.setTouchEmulationEnabled", {
          enabled: true,
          maxTouchPoints: 5,
        });
        try {
          await this.dispatchTouch(connection, action);
        } finally {
          if (connection.isOpen()) {
            await connection.command("Emulation.setTouchEmulationEnabled", { enabled: false });
          }
        }
        break;
      case "key":
        await pressKey(connection, keyDescriptor(action.key), modifierMask(action.modifiers));
        break;
      case "type":
        if (action.mode === "insertText") {
          await connection.command("Input.insertText", { text: action.text });
        } else {
          for (const character of action.text) {
            await pressKey(connection, keyDescriptor(character), 0);
          }
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
    return this.getStored(connectionId).cdp;
  }

  private getStored(connectionId: string): StoredConnection {
    const stored = this.connections.get(connectionId);
    if (!stored || !stored.cdp.isOpen()) {
      this.connections.delete(connectionId);
      throw new Error(`Unknown or closed connection: ${connectionId}`);
    }
    return stored;
  }

  private async readConditionValue(
    connectionId: string,
    condition: RuntimeCondition,
    timeoutMs: number,
  ): Promise<unknown> {
    if (condition.type === "expression") {
      // Evaluated where the bridge runs (the page, or the worker hosting the game).
      const { cdp: connection, bridgeSessionId } = this.getStored(connectionId);
      const expression = `(async () => {
        const value = await (0, eval)(${scriptLiteral(condition.expr)});
        return JSON.stringify({ value: value === undefined ? null : value });
      })()`;
      const evaluated = await connection.evaluateJson<{ value: unknown }>(expression, timeoutMs, bridgeSessionId);
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

  /**
   * Poll until a bridge answers ready, on the page itself or in one of its
   * dedicated workers (Construct runs the runtime in a worker with "Use
   * worker" on). Workers are reached through Target.setAutoAttach with flat
   * sessions. Returns undefined at the deadline, or once `stop`, given the
   * number of complete check rounds so far, says to.
   */
  private async findBridge(connection: CdpConnection, deadline: number, stop: (rounds: number) => boolean): Promise<FoundBridge | undefined> {
    const expression = `(() => {
      const bridge = globalThis.__c3bridge;
      if (!bridge || typeof bridge.getState !== "function") return JSON.stringify(null);
      return JSON.stringify(bridge.getState());
    })()`;
    const workers = new Set<string>();
    const stopListening = connection.onEvent((method, params, sessionId) => {
      if (sessionId !== undefined) return;
      const attachedSession = typeof params.sessionId === "string" ? params.sessionId : undefined;
      if (!attachedSession) return;
      if (method === "Target.attachedToTarget" && (params.targetInfo as { type?: unknown } | undefined)?.type === "worker") {
        workers.add(attachedSession);
      } else if (method === "Target.detachedFromTarget") {
        workers.delete(attachedSession);
      }
    });
    try {
      try {
        await connection.command("Target.setAutoAttach", { autoAttach: true, waitForDebuggerOnStart: false, flatten: true }, Math.max(1, Math.min(CDP_CALL_TIMEOUT_MS, deadline - Date.now())));
      } catch (error) {
        if (!connection.isOpen()) throw error;
        // without auto-attach only the page itself is checked
      }
      let rounds = 0;
      while (!stop(rounds) && Date.now() < deadline) {
        for (const sessionId of [undefined, ...workers]) {
          const remaining = deadline - Date.now();
          if (remaining <= 0 || stop(rounds)) break;
          try {
            const state = await connection.evaluateJson<GameState | null>(
              expression,
              Math.max(1, Math.min(CDP_CALL_TIMEOUT_MS, remaining)),
              sessionId,
            );
            if (state?.ready === true) return { state, sessionId };
          } catch (error) {
            if (!connection.isOpen()) throw error;
          }
        }
        rounds++;
        if (stop(rounds)) break;
        const waitMs = Math.min(BRIDGE_POLL_INTERVAL_MS, deadline - Date.now());
        if (waitMs > 0) await delay(waitMs);
      }
      return undefined;
    } finally {
      stopListening();
    }
  }
}

