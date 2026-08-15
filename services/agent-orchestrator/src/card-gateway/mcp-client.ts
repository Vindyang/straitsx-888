/**
 * C2 — legacy HTTP+SSE MCP transport (execution_plan.md §5, owner-c-tasks.md C2).
 *
 * `GET /sandbox/sse` opens a stream and immediately emits an `endpoint` event
 * carrying the POST target. Every JSON-RPC call is a POST to that endpoint;
 * the POST returns `202 Accepted` — the body is NOT the answer. Responses
 * arrive asynchronously as `message` events on the still-open SSE stream,
 * correlated by JSON-RPC `id`. The stream never closes; a client that appears
 * to hang while reading it is behaving correctly.
 *
 * No auth header is needed on sandbox (verified: `initialize` + `tools/list`
 * succeed bare).
 */

import { MCP_SSE_SANDBOX } from "@straitsx/contracts";
import { AppError, ErrorCode } from "@straitsx/contracts";

type JsonRpcId = number;

type PendingCall = {
  resolve: (result: unknown) => void;
  reject: (err: Error) => void;
};

type JsonRpcMessage = {
  id?: JsonRpcId;
  result?: unknown;
  error?: { message: string };
};

export class McpSseClient {
  readonly #sseUrl: string;
  #messagesUrl: URL | null = null;
  #nextId = 1;
  readonly #pending = new Map<JsonRpcId, PendingCall>();
  readonly #ready: Promise<void>;
  readonly #abort = new AbortController();

  constructor(sseUrl: string = MCP_SSE_SANDBOX) {
    this.#sseUrl = sseUrl;
    this.#ready = this.#connect();
  }

  async #connect(): Promise<void> {
    let res: Response;
    try {
      res = await fetch(this.#sseUrl, {
        headers: { accept: "text/event-stream" },
        signal: this.#abort.signal,
      });
    } catch (err) {
      throw new AppError(502, ErrorCode.MCP_UNREACHABLE, `mcp sse connect failed: ${String(err)}`, true);
    }
    if (!res.ok || !res.body) {
      throw new AppError(502, ErrorCode.MCP_UNREACHABLE, `mcp sse handshake failed: ${res.status}`, true);
    }

    let resolveEndpoint: () => void;
    let rejectEndpoint: (err: Error) => void;
    const endpointReady = new Promise<void>((resolve, reject) => {
      resolveEndpoint = resolve;
      rejectEndpoint = reject;
    });

    // The stream never closes — the read loop runs for the client's lifetime, not just
    // until the endpoint event arrives. Started here, not awaited.
    void this.#readLoop(res.body, () => resolveEndpoint()).catch((err) => rejectEndpoint(err as Error));

    await endpointReady;
  }

  async #readLoop(body: ReadableStream<Uint8Array>, onEndpoint: () => void): Promise<void> {
    const reader = body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) return;
        buffer += decoder.decode(value, { stream: true });
        let sep: number;
        while ((sep = buffer.indexOf("\n\n")) !== -1) {
          const rawEvent = buffer.slice(0, sep);
          buffer = buffer.slice(sep + 2);
          this.#dispatchEvent(rawEvent, onEndpoint);
        }
      }
    } catch (err) {
      if (this.#abort.signal.aborted) return; // close() — not a failure
      const failure = new AppError(502, ErrorCode.MCP_UNREACHABLE, `mcp sse stream failed: ${String(err)}`, true);
      for (const { reject } of this.#pending.values()) reject(failure);
      this.#pending.clear();
      throw failure;
    }
  }

  #dispatchEvent(rawEvent: string, onEndpoint: () => void): void {
    let eventName = "message";
    const dataLines: string[] = [];
    for (const line of rawEvent.split("\n")) {
      if (line.startsWith("event:")) eventName = line.slice(6).trim();
      else if (line.startsWith("data:")) dataLines.push(line.slice(5).trim());
    }
    const data = dataLines.join("\n");

    if (eventName === "endpoint") {
      this.#messagesUrl = new URL(data, this.#sseUrl);
      onEndpoint();
      return;
    }
    if (eventName !== "message" || data.length === 0) return;

    let msg: JsonRpcMessage;
    try {
      msg = JSON.parse(data) as JsonRpcMessage;
    } catch {
      return; // not a JSON-RPC message we can correlate; ignore
    }
    if (msg.id === undefined) return; // notification, nothing pending on it
    const pending = this.#pending.get(msg.id);
    if (!pending) return;
    this.#pending.delete(msg.id);
    if (msg.error) pending.reject(new Error(msg.error.message));
    else pending.resolve(msg.result);
  }

  async #post(body: unknown): Promise<void> {
    await this.#ready;
    if (!this.#messagesUrl) {
      throw new AppError(502, ErrorCode.MCP_UNREACHABLE, "mcp endpoint event never arrived");
    }
    let res: Response;
    try {
      res = await fetch(this.#messagesUrl, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
        signal: this.#abort.signal,
      });
    } catch (err) {
      throw new AppError(502, ErrorCode.MCP_UNREACHABLE, `mcp post failed: ${String(err)}`, true);
    }
    // 202 Accepted — the body is not the answer (execution_plan.md §5.2). The reply arrives
    // on the SSE stream and is matched by #dispatchEvent.
    if (res.status !== 202) {
      throw new AppError(502, ErrorCode.MCP_UNREACHABLE, `mcp POST expected 202, got ${res.status}`, true);
    }
  }

  #call(method: string, params?: unknown): Promise<unknown> {
    const id = this.#nextId++;
    const reply = new Promise<unknown>((resolve, reject) => {
      this.#pending.set(id, { resolve, reject });
    });
    void this.#post({ jsonrpc: "2.0", id, method, params }).catch((err) => {
      const pending = this.#pending.get(id);
      if (pending) {
        this.#pending.delete(id);
        pending.reject(err as Error);
      }
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
    this.#abort.abort();
  }
}
