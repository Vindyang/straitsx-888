import { describe, expect, it } from "vitest";
import { McpSseClient } from "../../src/card-gateway/mcp-client";

const encoder = new TextEncoder();

function transport(options: { crlf?: boolean; closeAfterEndpoint?: boolean; omitToolReply?: boolean } = {}) {
  let controller: ReadableStreamDefaultController<Uint8Array>;
  const stream = new ReadableStream<Uint8Array>({ start(value) { controller = value; } });
  const newline = options.crlf ? "\r\n" : "\n";
  const event = (name: string, data: unknown) => controller.enqueue(encoder.encode(`event: ${name}${newline}data: ${typeof data === "string" ? data : JSON.stringify(data)}${newline}${newline}`));
  const fetchMock: typeof fetch = async (_input, init) => {
    if (!init?.method) {
      queueMicrotask(() => {
        event("endpoint", "/messages?sessionId=123e4567-e89b-42d3-a456-426614174000");
        if (options.closeAfterEndpoint) controller.close();
      });
      return new Response(stream, { status: 200, headers: { "content-type": "text/event-stream" } });
    }
    const body = JSON.parse(String(init.body)) as { id?: number; method: string };
    if (body.id && !options.closeAfterEndpoint && !(options.omitToolReply && body.method === "tools/call")) {
      queueMicrotask(() => event("message", { jsonrpc: "2.0", id: body.id, result: { method: body.method } }));
    }
    return new Response(null, { status: 202 });
  };
  return { fetchMock };
}

describe("McpSseClient", () => {
  it("correlates asynchronous 202 replies and parses CRLF events", async () => {
    const { fetchMock } = transport({ crlf: true });
    const client = new McpSseClient("https://mcp.example/sse", { fetch: fetchMock, callTimeoutMs: 100 });
    await client.initialize();
    await expect(client.callTool("tool", {})).resolves.toEqual({ method: "tools/call" });
    client.close();
  });

  it("rejects a pending call when the stream closes", async () => {
    const { fetchMock } = transport({ closeAfterEndpoint: true });
    const client = new McpSseClient("https://mcp.example/sse", { fetch: fetchMock, callTimeoutMs: 100 });
    await expect(client.initialize()).rejects.toThrow(/closed|failed/);
  });

  it("times out a call whose stream response never arrives", async () => {
    const { fetchMock } = transport({ omitToolReply: true });
    const client = new McpSseClient("https://mcp.example/sse", { fetch: fetchMock, callTimeoutMs: 10 });
    await client.initialize();
    await expect(client.callTool("tool", {})).rejects.toThrow(/timed out/);
    client.close();
  });

  it("times out when the endpoint event never arrives", async () => {
    const stream = new ReadableStream<Uint8Array>({ start() {} });
    const fetchMock: typeof fetch = async () => new Response(stream, { status: 200 });
    const client = new McpSseClient("https://mcp.example/sse", { fetch: fetchMock, endpointTimeoutMs: 10 });
    await expect(client.initialize()).rejects.toThrow(/endpoint event timed out|connect failed/);
  });

  it("rejects cross-origin and malformed messages endpoints", async () => {
    for (const endpoint of [
      "https://attacker.example/messages?sessionId=123e4567-e89b-42d3-a456-426614174000",
      "/other?sessionId=123e4567-e89b-42d3-a456-426614174000",
      "/messages?sessionId=not-a-uuid",
      "/messages?sessionId=123e4567-e89b-42d3-a456-426614174000&next=evil",
    ]) {
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(encoder.encode(`event: endpoint\ndata: ${endpoint}\n\n`));
        },
      });
      const fetchMock: typeof fetch = async () => new Response(stream, { status: 200 });
      const client = new McpSseClient("https://mcp.example/sse", { fetch: fetchMock, endpointTimeoutMs: 100 });
      await expect(client.initialize()).rejects.toThrow(/expected HTTPS messages route/);
    }
  });
});
