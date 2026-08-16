import Link from "next/link";
import { CHAINS, type ChainId } from "@straitsx/contracts";
import { formatXsgd, shortHex } from "../../../lib/format";
import { getReceipt } from "../../../lib/ledger";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "../../../components/ui/card";
import { PageHeading } from "../../../components/page-heading";

export default async function ReceiptPage({ params }: { params: Promise<{ requestId: string }> }) {
  const { requestId } = await params;
  const receipt = await getReceipt(requestId);

  if (!receipt) {
    return (
      <div className="flex flex-col gap-8">
        <PageHeading backHref="/runs" title="Receipt" />
        <p className="text-sm text-muted-foreground">No receipt for {requestId}.</p>
      </div>
    );
  }

  const chainId = receipt.challenge?.chainId;
  const explorerBase = chainId !== undefined && chainId in CHAINS ? CHAINS[chainId as ChainId].explorerTxBase : null;

  return (
    <div className="flex flex-col gap-8">
      <PageHeading
        backHref="/runs"
        title="Receipt"
        description={receipt.intent}
      />

      <Card>
        <CardHeader>
          <CardTitle>Unbroken chain</CardTitle>
          <CardDescription>Every leg anchored to the request your wallet authorized.</CardDescription>
        </CardHeader>
        <CardContent>
          <ol className="space-y-1 text-sm">
            <li>intent — {shortHex(receipt.requestId)}</li>
            <li>challenge — payTo {receipt.challenge ? shortHex(receipt.challenge.payTo) : "—"}</li>
            <li>authorization — nonce {receipt.authorization ? shortHex(receipt.authorization.nonce) : "—"}</li>
            <li>
              settlement —{" "}
              {receipt.settlementTx && explorerBase ? (
                <a href={`${explorerBase}${receipt.settlementTx}`} target="_blank" rel="noreferrer" className="font-medium text-primary hover:underline">
                  {shortHex(receipt.settlementTx)} (view on explorer)
                </a>
              ) : (
                "—"
              )}
            </li>
            <li>card — {receipt.cardOpaqueId ?? "—"}</li>
          </ol>
        </CardContent>
      </Card>

      <div className="grid gap-4 sm:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>Amount</CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-2xl font-semibold">
              {receipt.challenge ? `${formatXsgd(receipt.challenge.amount)} XSGD` : "—"}
            </p>
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle>Decision</CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-2xl font-semibold">{receipt.decision ?? "—"}</p>
            <p className="mt-1 text-sm text-muted-foreground">{receipt.decidedAt ?? "—"}</p>
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Spend leg</CardTitle>
        </CardHeader>
        <CardContent>
          {receipt.spendLeg.status === "observed" ? (
            <p className="text-sm leading-6">
              observed at <strong>{receipt.spendLeg.merchantDomain}</strong>, total{" "}
              {receipt.spendLeg.orderTotal} — status: <strong>observed</strong>, proof:{" "}
              <strong>none</strong>. Not yet cryptographically bound to a merchant-signed
              attestation (docs/execution_plan.md §12).
            </p>
          ) : (
            <p className="text-sm text-muted-foreground">absent — proof: none</p>
          )}
        </CardContent>
      </Card>
    </div>
  );
}