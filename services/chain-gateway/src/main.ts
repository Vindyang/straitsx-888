import { SERVICE_PORTS } from "@straitsx/contracts";
import { buildApp } from "./app";
import { assertTokenDecimalsAtBoot } from "./chain";

const port = Number(process.env["PORT"] ?? SERVICE_PORTS.chainGateway);
const host = process.env["HOST"] ?? "0.0.0.0";

const app = buildApp({
  internalToken: process.env["INTERNAL_TOKEN"],
  logger: true,
});

/**
 * A6: assert `decimals === 6` on every configured chain BEFORE serving. An
 * 18-decimal assumption mis-encodes every amount by 10^12 and the signature
 * then verifies against the wrong value — silently. Refuse to serve instead.
 */
await assertTokenDecimalsAtBoot(app.log);

await app.listen({ port, host });
app.log.info(`chain-gateway listening on ${host}:${port}`);
