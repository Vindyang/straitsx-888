/** Legacy HTTP+SSE MCP transport with bounded, correlated calls. */

import { AppError, ErrorCode, MCP_SSE_SANDBOX } from "@straitsx/contracts";

type JsonRpcId = number;
type Fetch = typeof fetch;
type PendingCall = { resolve: (result: unknown) => void; reject: (err: Error) => void; timer: ReturnType<typeof setTimeout> };
type JsonRpcMessage = { id?: JsonRpcId; result?: unknown; error?: { message?: string } };

export type McpSseClientOptions = {
  fetch?: Fetch;
  endpointTimeoutMs?: number;
  callTimeoutMs?: number;
};

function transportError(message: string): AppError {
  return new AppError(502, ErrorCode.MCP_UNREACHABLE, message, true);
}

function parseMessagesEndpoint(value: string, sseUrl: string): URL {
  const source = new URL(sseUrl);
  const endpoint = new URL(value, source);
  const expectedPath = source.pathname.replace(/\/sse$/, "/messages");
  const sessionIds = endpoint.searchParams.getAll("sessionId");
  const keys = [...endpoint.searchParams.keys()];
  if (
    source.protocol !== "https:" || endpoint.protocol !== "https:" || endpoint.origin !== source.origin ||
    endpoint.username || endpoint.password || endpoint.hash || endpoint.pathname !== expectedPath ||
    keys.length !== 1 || keys[0] !== "sessionId" || sessionIds.length !== 1 ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(sessionIds[0] ?? "")
  ) {
    throw transportError("mcp endpoint event was outside the expected HTTPS messages route");
  }
  return endpoint;
}

export class McpSseClient {
  readonly #sseUrl: string;
  readonly #fetch: Fetch;
  readonly #endpointTimeoutMs: number;
  readonly #callTimeoutMs: number;
  #messagesUrl: URL | null = null;
  #nextId = 1;
  readonly #pending = new Map<JsonRpcId, PendingCall>();
  readonly #ready: Promise<void>;
  readonly #abort = new AbortController();
  #closed = false;

  constructor(sseUrl: string = MCP_SSE_SANDBOX, options: McpSseClientOptions = {}) {
    this.#sseUrl = sseUrl;
    this.#fetch = options.fetch ?? fetch;
    this.#endpointTimeoutMs = options.endpointTimeoutMs ?? 10_000;
    this.#callTimeoutMs = options.callTimeoutMs ?? 20_000;
    this.#ready = this.#connect();
  }

  async #connect(): Promise<void> {
    let res: Response;
    const timer = setTimeout(() => this.#abort.abort(), this.#endpointTimeoutMs);
    try {
      res = await this.#fetch(this.#sseUrl, {
        headers: { accept: "text/event-stream" },
        signal: this.#abort.signal,
      });
    } catch (err) {
      throw transportError(`mcp sse connect failed: ${String(err)}`);
    } finally {
      clearTimeout(timer);
    }
    if (!res.ok || !res.body) throw transportError(`mcp sse handshake failed: ${res.status}`);

    await new Promise<void>((resolve, reject) => {
      let settled = false;
      const endpointTimer = setTimeout(() => {
        if (settled) return;
        settled = true;
        this.#abort.abort();
        reject(transportError("mcp endpoint event timed out"));
      }, this.#endpointTimeoutMs);
      const ready = () => {
        if (settled) return;
        settled = true;
        clearTimeout(endpointTimer);
        resolve();
      };
      void this.#readLoop(res.body!, ready).catch((err: unknown) => {
        if (settled) return;
        settled = true;
        clearTimeout(endpointTimer);
        reject(err);
      });
    });
  }

  #rejectAll(error: Error): void {
    for (const pending of this.#pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.#pending.clear();
  }

  async #readLoop(body: ReadableStream<Uint8Array>, onEndpoint: () => void): Promise<void> {
    const reader = body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) {
          if (this.#closed) return;
          const failure = transportError("mcp sse stream closed unexpectedly");
          this.#rejectAll(failure);
          throw failure;
        }
        // Normalise CRLF so both wire formats use the same event separator.
        buffer += decoder.decode(value, { stream: true }).replace(/\r\n/g, "\n");
        let separator: number;
        while ((separator = buffer.indexOf("\n\n")) !== -1) {
          const rawEvent = buffer.slice(0, separator);
          buffer = buffer.slice(separator + 2);
          this.#dispatchEvent(rawEvent, onEndpoint);
        }
      }
    } catch (err) {
      if (this.#closed) return;
      const failure = err instanceof AppError ? err : transportError(`mcp sse stream failed: ${String(err)}`);
      this.#rejectAll(failure);
      throw failure;
    }
  }

  #dispatchEvent(rawEvent: string, onEndpoint: () => void): void {
    let eventName = "message";
    const dataLines: string[] = [];
    for (const line of rawEvent.split("\n")) {
      if (line.startsWith("event:")) eventName = line.slice(6).trim();
      else if (line.startsWith("data:")) dataLines.push(line.slice(5).trimStart());
    }
    const data = dataLines.join("\n");
    if (eventName === "endpoint") {
      try {
        this.#messagesUrl = parseMessagesEndpoint(data, this.#sseUrl);
      } catch (error) {
        throw error instanceof AppError ? error : transportError("mcp endpoint event contained an invalid URL");
      }
      onEndpoint();
      return;
    }
    if (eventName !== "message" || data.length === 0) return;

    let message: JsonRpcMessage;
    try {
      message = JSON.parse(data) as JsonRpcMessage;
    } catch {
      return;
    }
    if (message.id === undefined) return;
    const pending = this.#pending.get(message.id);
    if (!pending) return;
    this.#pending.delete(message.id);
    clearTimeout(pending.timer);
    if (message.error) pending.reject(transportError(`mcp call failed: ${message.error.message ?? "unknown error"}`));
    else if (!("result" in message)) pending.reject(transportError("mcp response omitted result"));
    else pending.resolve(message.result);
  }

  async #post(body: unknown): Promise<void> {
    await this.#ready;
    if (this.#closed || !this.#messagesUrl) throw transportError("mcp client is not connected");
    const controller = new AbortController();
    const abort = () => controller.abort();
    this.#abort.signal.addEventListener("abort", abort, { once: true });
    const timer = setTimeout(abort, this.#callTimeoutMs);
    try {
      const res = await this.#fetch(this.#messagesUrl, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      if (res.status !== 202) throw transportError(`mcp POST expected 202, got ${res.status}`);
    } catch (err) {
      if (err instanceof AppError) throw err;
      throw transportError(`mcp post failed: ${String(err)}`);
    } finally {
      clearTimeout(timer);
      this.#abort.signal.removeEventListener("abort", abort);
    }
  }

  #call(method: string, params?: unknown): Promise<unknown> {
    const id = this.#nextId++;
    const reply = new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id);
        reject(transportError(`mcp ${method} response timed out`));
      }, this.#callTimeoutMs);
      this.#pending.set(id, { resolve, reject, timer });
    });
    void this.#post({ jsonrpc: "2.0", id, method, params }).catch((err: unknown) => {
      const pending = this.#pending.get(id);
      if (!pending) return;
      this.#pending.delete(id);
      clearTimeout(pending.timer);
      pending.reject(err instanceof Error ? err : transportError(String(err)));
    });
    return reply;
  }

  async #notify(method: string, params?: unknown): Promise<void> {
    await this.#post({ jsonrpc: "2.0", method, params });
  }

  async initialize(): Promise<void> {
    await this.#call("initialize", {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "straitsx-agent-orchestrator", version: "0.1.0" },
    });
    await this.#notify("notifications/initialized");
  }

  callTool(name: string, args: Record<string, unknown>): Promise<unknown> {
    return this.#call("tools/call", { name, arguments: args });
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#abort.abort();
    this.#rejectAll(transportError("mcp client closed"));
  }
}
