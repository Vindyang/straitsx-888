import { SERVICE_PORTS } from "@straitsx/contracts";
import { buildApp } from "./app";

const port = Number(process.env["PORT"] ?? SERVICE_PORTS.agentOrchestrator);
const host = process.env["HOST"] ?? "0.0.0.0";

const app = buildApp({
  internalToken: process.env["INTERNAL_TOKEN"],
  logger: true,
});

await app.listen({ port, host });
app.log.info(`agent-orchestrator listening on ${host}:${port}`);
