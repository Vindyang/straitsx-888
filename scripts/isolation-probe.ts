/** Run inside a one-off ECS task using the orchestrator security group. */
import { lookup } from "node:dns/promises";
import { connect } from "node:net";

const signerHost = process.env["SIGNER_HOST"];
const signerPort = Number(process.env["SIGNER_PORT"] ?? 4003);
const requiredUrls = [process.env["POLICY_URL"], process.env["LEDGER_URL"], process.env["CHAIN_GATEWAY_URL"]];

if (!signerHost || requiredUrls.some((url) => !url)) {
  throw new Error("SIGNER_HOST, POLICY_URL, LEDGER_URL and CHAIN_GATEWAY_URL are required");
}

const addresses = await lookup(signerHost, { all: true });
if (addresses.length === 0) throw new Error("signer DNS returned no addresses");
console.log(`PASS signer DNS resolved (${addresses.length} address record(s))`);

for (const base of requiredUrls as string[]) {
  const response = await fetch(new URL("/health", base), { signal: AbortSignal.timeout(5_000) });
  if (!response.ok) throw new Error(`${new URL(base).hostname} health returned ${response.status}`);
  console.log(`PASS reachable ${new URL(base).hostname}:${new URL(base).port}`);
}

const signerReachable = await new Promise<boolean>((resolve, reject) => {
  const socket = connect({ host: signerHost, port: signerPort });
  const timer = setTimeout(() => { socket.destroy(); resolve(false); }, 5_000);
  socket.once("connect", () => { clearTimeout(timer); socket.destroy(); resolve(true); });
  socket.once("error", (error: NodeJS.ErrnoException) => {
    clearTimeout(timer);
    if (["ECONNREFUSED", "EHOSTUNREACH", "ETIMEDOUT"].includes(error.code ?? "")) resolve(false);
    else reject(error);
  });
});
if (signerReachable) throw new Error(`FAIL orchestrator security group reached signer TCP ${signerPort}`);
console.log(`PASS signer DNS exists but TCP/HTTP ${signerPort} is unreachable from orchestrator security group`);
