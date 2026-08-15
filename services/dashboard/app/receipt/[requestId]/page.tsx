import Link from "next/link";
import { CHAINS, type ChainId } from "@straitsx/contracts";
import { formatXsgd, shortHex } from "../../../lib/format";
import { getReceipt } from "../../../lib/ledger";

/** C13 — the receipt view. Links settlementTx to a real explorer; labels the
 *  spend leg honestly (observed, proof: none) rather than overclaiming it. */
export default async function ReceiptPage({ params }: { params: Promise<{ requestId: string }> }) {
  const { requestId } = await params;
  const receipt = await getReceipt(requestId);

  if (!receipt) {
    return (
      <main style={{ maxWidth: 800, margin: "0 auto", padding: "2rem" }}>
        <p>
          <Link href="/runs">&larr; all runs</Link>
        </p>
        <p>No receipt for {requestId}.</p>
      </main>
    );
  }

  const chainId = receipt.challenge?.chainId;
  const explorerBase = chainId !== undefined && chainId in CHAINS ? CHAINS[chainId as ChainId].explorerTxBase : null;

  return (
    <main style={{ maxWidth: 800, margin: "0 auto", padding: "2rem" }}>
      <p>
        <Link href="/runs">&larr; all runs</Link>
      </p>
      <h1>Receipt</h1>
      <p style={{ color: "#666" }}>{receipt.intent}</p>

      <h2>Unbroken chain</h2>
      <ol>
        <li>intent — {shortHex(receipt.requestId)}</li>
        <li>challenge — payTo {receipt.challenge ? shortHex(receipt.challenge.payTo) : "—"}</li>
        <li>authorization — nonce {receipt.authorization ? shortHex(receipt.authorization.nonce) : "—"}</li>
        <li>
          settlement —{" "}
          {receipt.settlementTx && explorerBase ? (
            <a href={`${explorerBase}${receipt.settlementTx}`} target="_blank" rel="noreferrer">
              {shortHex(receipt.settlementTx)} (view on explorer)
            </a>
          ) : (
            "—"
          )}
        </li>
        <li>card — {receipt.cardOpaqueId ?? "—"}</li>
      </ol>

      <h2>Amount</h2>
      <p>{receipt.challenge ? `${formatXsgd(receipt.challenge.amount)} XSGD` : "—"}</p>

      <h2>Decision</h2>
      <p>
        {receipt.decision ?? "—"} at {receipt.decidedAt ?? "—"}
      </p>

      <h2>Spend leg</h2>
      {receipt.spendLeg.status === "observed" ? (
        <p>
          observed at <strong>{receipt.spendLeg.merchantDomain}</strong>, total{" "}
          {receipt.spendLeg.orderTotal} — status: <strong>observed</strong>, proof:{" "}
          <strong>none</strong>. Not yet cryptographically bound to a merchant-signed
          attestation (docs/execution_plan.md §12).
        </p>
      ) : (
        <p>absent — proof: none</p>
      )}
    </main>
  );
}
