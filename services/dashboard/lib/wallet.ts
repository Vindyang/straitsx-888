/**
 * Thin wrapper over the injected EIP-1193 provider (MetaMask etc). No wallet
 * library dependency — the dashboard never holds a key either way, it only
 * asks whatever wallet the human already has to sign what a server route
 * built. Client-side only; never imported by anything under app/api/.
 */

export type UnsignedTx = {
  to: string;
  data: string;
  value: string;
  chainId: number;
  gasLimit: string;
};

type EthereumProvider = {
  request: (args: { method: string; params?: unknown[] }) => Promise<unknown>;
};

function getProvider(): EthereumProvider {
  const eth = (window as unknown as { ethereum?: EthereumProvider }).ethereum;
  if (!eth) throw new Error("No wallet found — install MetaMask or another injected wallet.");
  return eth;
}

export async function connectWallet(): Promise<string> {
  const eth = getProvider();
  const accounts = (await eth.request({ method: "eth_requestAccounts" })) as string[];
  const account = accounts[0];
  if (!account) throw new Error("wallet returned no accounts");
  return account;
}

export function escalationApprovalMessage(requestId: string, decision: "approve" | "deny", expiresAt: number): string {
  return ["StraitsX escalation decision", `requestId: ${requestId}`, `decision: ${decision}`, `expiresAt: ${expiresAt}`].join("\n");
}

/** EIP-191 approval proof. The signature is returned once and never rendered. */
export async function signEscalationDecision(
  requestId: string,
  decision: "approve" | "deny",
  expiresAt: number,
): Promise<{ approvedBy: string; signature: string }> {
  const eth = getProvider();
  const approvedBy = await connectWallet();
  const signature = (await eth.request({
    method: "personal_sign",
    params: [escalationApprovalMessage(requestId, decision, expiresAt), approvedBy],
  })) as string;
  return { approvedBy, signature };
}

/** Sends an unsigned tx built by a dashboard server route through the
 *  connected wallet and returns the tx hash. The caller decides how to wait. */
export async function sendTransaction(tx: UnsignedTx): Promise<string> {
  const eth = getProvider();
  try {
    await eth.request({ method: "wallet_switchEthereumChain", params: [{ chainId: `0x${tx.chainId.toString(16)}` }] });
  } catch {
    // Best-effort: a wallet already on the right chain may reject a no-op
    // switch. A real mismatch surfaces from eth_sendTransaction below instead.
  }
  const accounts = (await eth.request({ method: "eth_requestAccounts" })) as string[];
  const from = accounts[0];
  if (!from) throw new Error("wallet returned no accounts");
  return (await eth.request({
    method: "eth_sendTransaction",
    params: [
      {
        from,
        to: tx.to,
        data: tx.data,
        value: `0x${BigInt(tx.value).toString(16)}`,
        gas: `0x${BigInt(tx.gasLimit).toString(16)}`,
      },
    ],
  })) as string;
}

export async function waitForReceipt(txHash: string, timeoutMs = 90_000): Promise<void> {
  const eth = getProvider();
  const start = Date.now();
  for (;;) {
    const receipt = await eth.request({ method: "eth_getTransactionReceipt", params: [txHash] });
    if (receipt) return;
    if (Date.now() - start > timeoutMs) {
      throw new Error(`timed out waiting for ${txHash} to be mined`);
    }
    await new Promise((resolve) => setTimeout(resolve, 2000));
  }
}
