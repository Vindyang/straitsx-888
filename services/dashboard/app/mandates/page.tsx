"use client";

import { useCallback, useEffect, useState } from "react";
import { FUJI } from "@straitsx/contracts";
import type { Mandate } from "@straitsx/contracts";
import { formatXsgd, sgdToBaseUnits, shortHex } from "../../lib/format";
import { connectWallet, sendTransaction, waitForReceipt, type UnsignedTx } from "../../lib/wallet";
import { Alert, AlertDescription, AlertTitle } from "../../components/ui/alert";
import { Button } from "../../components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "../../components/ui/card";
import {
  Field,
  FieldDescription,
  FieldGroup,
  FieldLabel,
} from "../../components/ui/field";
import { Input } from "../../components/ui/input";
import { PageHeading } from "../../components/page-heading";

type OnChainMandate = { owner: string; policyHash: string; expiresAt: number; revoked: boolean };
type MandateRow = {
  mandate: Mandate;
  confirmed: boolean;
  stagedAt: string;
  onChain: OnChainMandate | null;
  inSync: boolean | null;
};
type WindowUsage = {
  spent: string;
  cardCount: number;
  remaining?: string;
  maxPerWindow: string;
  maxCardsPerWindow: number;
};

const DAY_SECONDS = 86_400;

function defaultForm() {
  const now = Math.floor(Date.now() / 1000);
  return {
    owner: "",
    agentId: "shopper-1",
    chainId: FUJI.chainId,
    asset: FUJI.xsgd,
    settlementRecipient: FUJI.settlementRecipient ?? "",
    maxPerCardSgd: "30",
    maxPerWindowSgd: "100",
    maxCardsPerWindow: 5,
    windowSeconds: DAY_SECONDS,
    maxAuthValiditySeconds: 300,
    expiresAt: now + 30 * DAY_SECONDS,
    intentConstraint: "500ml stainless steel water bottle, under S$20",
    merchantAllowlist: "localhost",
  };
}

export default function MandatesPage() {
  const [rows, setRows] = useState<MandateRow[]>([]);
  const [windows, setWindows] = useState<Record<string, WindowUsage>>({});
  const [form, setForm] = useState(defaultForm());
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    const res = await fetch("/api/mandates", { cache: "no-store" });
    const data = (await res.json()) as MandateRow[];
    setRows(data);
    await Promise.all(
      data
        .filter((row) => row.confirmed)
        .map(async (row) => {
          const winRes = await fetch(`/api/window/${row.mandate.mandateId}`, { cache: "no-store" });
          if (!winRes.ok) return;
          const usage = (await winRes.json()) as WindowUsage;
          setWindows((prev) => ({ ...prev, [row.mandate.mandateId]: usage }));
        }),
    );
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  async function connectOwner() {
    try {
      const account = await connectWallet();
      setForm((prev) => ({ ...prev, owner: account }));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  async function createMandate() {
    setError(null);
    setBusy("creating");
    try {
      const body = {
        owner: form.owner,
        agentId: form.agentId,
        chainId: form.chainId,
        asset: form.asset,
        settlementRecipient: form.settlementRecipient,
        maxPerCard: sgdToBaseUnits(form.maxPerCardSgd),
        maxPerWindow: sgdToBaseUnits(form.maxPerWindowSgd),
        maxCardsPerWindow: form.maxCardsPerWindow,
        windowSeconds: form.windowSeconds,
        maxAuthValiditySeconds: form.maxAuthValiditySeconds,
        expiresAt: form.expiresAt,
        intentConstraint: form.intentConstraint,
        merchantAllowlist: form.merchantAllowlist
          .split(",")
          .map((domain) => domain.trim())
          .filter(Boolean),
      };
      const buildRes = await fetch("/api/mandates", { method: "POST", body: JSON.stringify(body) });
      const built = (await buildRes.json()) as { mandateId?: string; unsignedTx?: UnsignedTx; error?: { message: string } };
      if (!buildRes.ok || !built.mandateId || !built.unsignedTx) {
        throw new Error(built.error?.message ?? "failed to build createMandate tx");
      }

      const txHash = await sendTransaction(built.unsignedTx);
      setBusy("waiting for confirmation on-chain…");
      await waitForReceipt(txHash);

      setBusy("saving policy body…");
      const confirmRes = await fetch(`/api/mandates/${built.mandateId}/confirm`, { method: "POST" });
      if (!confirmRes.ok) {
        const body2 = (await confirmRes.json().catch(() => ({}))) as { error?: { message?: string } };
        throw new Error(body2.error?.message ?? "createMandate mined, but PUT /policy failed");
      }

      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  }

  async function revoke(mandate: Mandate) {
    setError(null);
    setBusy(`revoking ${mandate.mandateId}`);
    try {
      const from = await connectWallet();
      const res = await fetch(`/api/revoke/${mandate.mandateId}`, {
        method: "POST",
        body: JSON.stringify({ chainId: mandate.chainId, from }),
      });
      const built = (await res.json()) as { unsignedTx?: UnsignedTx; error?: { message: string } };
      if (!res.ok || !built.unsignedTx) throw new Error(built.error?.message ?? "failed to build revoke tx");

      const txHash = await sendTransaction(built.unsignedTx);
      setBusy("waiting for the revoke to be mined…");
      await waitForReceipt(txHash);
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="flex flex-col gap-8">
      <PageHeading
        title="Mandates"
        description="Creation builds an unsigned on-chain transaction — you sign it in your own wallet. Nothing here ever touches a private key."
      />

      {error ? (
        <Alert variant="destructive">
          <AlertTitle>Mandate failed</AlertTitle>
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      ) : null}

      <Card>
        <CardHeader>
          <CardTitle>Create mandate</CardTitle>
          <CardDescription>
            {busy ? `${busy}…` : "Confirm the on-chain constraints stored in the policy registry."}
          </CardDescription>
        </CardHeader>
        <CardContent>
          <FieldGroup>
            <Field>
              <FieldLabel htmlFor="owner">owner (your wallet)</FieldLabel>
              <div className="flex gap-2">
                <Input id="owner" value={form.owner} onChange={(e) => setForm((p) => ({ ...p, owner: e.target.value }))} />
                <Button type="button" variant="outline" onClick={connectOwner} disabled={busy !== null}>
                  Use connected wallet
                </Button>
              </div>
            </Field>
            <Field>
              <FieldLabel htmlFor="agentId">agentId</FieldLabel>
              <Input id="agentId" value={form.agentId} onChange={(e) => setForm((p) => ({ ...p, agentId: e.target.value }))} />
            </Field>
            <Field>
              <FieldLabel htmlFor="intentConstraint">intentConstraint</FieldLabel>
              <Input id="intentConstraint" value={form.intentConstraint} onChange={(e) => setForm((p) => ({ ...p, intentConstraint: e.target.value }))} />
            </Field>
            <Field>
              <FieldLabel htmlFor="merchantAllowlist">merchantAllowlist (comma-separated)</FieldLabel>
              <Input id="merchantAllowlist" value={form.merchantAllowlist} onChange={(e) => setForm((p) => ({ ...p, merchantAllowlist: e.target.value }))} />
              <FieldDescription>Only these merchant domains may settle against this mandate.</FieldDescription>
            </Field>
            <div className="grid gap-4 sm:grid-cols-4">
              <Field>
                <FieldLabel htmlFor="maxPerCard">maxPerCard (SGD)</FieldLabel>
                <Input id="maxPerCard" value={form.maxPerCardSgd} onChange={(e) => setForm((p) => ({ ...p, maxPerCardSgd: e.target.value }))} />
              </Field>
              <Field>
                <FieldLabel htmlFor="maxPerWindow">maxPerWindow (SGD)</FieldLabel>
                <Input id="maxPerWindow" value={form.maxPerWindowSgd} onChange={(e) => setForm((p) => ({ ...p, maxPerWindowSgd: e.target.value }))} />
              </Field>
              <Field>
                <FieldLabel htmlFor="maxCardsPerWindow">maxCardsPerWindow</FieldLabel>
                <Input id="maxCardsPerWindow" type="number" value={form.maxCardsPerWindow} onChange={(e) => setForm((p) => ({ ...p, maxCardsPerWindow: Number(e.target.value) }))} />
              </Field>
              <Field>
                <FieldLabel htmlFor="windowSeconds">windowSeconds</FieldLabel>
                <Input id="windowSeconds" type="number" value={form.windowSeconds} onChange={(e) => setForm((p) => ({ ...p, windowSeconds: Number(e.target.value) }))} />
              </Field>
            </div>
            <Button type="button" onClick={createMandate} disabled={busy !== null || !form.owner}>
              {busy === "creating" ? "Creating…" : "Build + sign createMandate"}
            </Button>
          </FieldGroup>
        </CardContent>
      </Card>

      <section className="flex flex-col gap-4">
        <h2 className="text-xl font-semibold tracking-tight">All mandates</h2>
        {rows.length === 0 && (
          <p className="text-sm text-muted-foreground">None created from this dashboard yet.</p>
        )}
        {rows.map((row) => {
          const usage = windows[row.mandate.mandateId];
          const revoked = row.onChain?.revoked ?? false;
          return (
            <Card key={row.mandate.mandateId}>
              <CardHeader>
                <div className="flex items-baseline justify-between gap-2">
                  <CardTitle className="font-mono text-sm">{shortHex(row.mandate.mandateId)}</CardTitle>
                  <span className={`text-sm font-semibold ${revoked ? "text-red-600" : row.confirmed ? "text-green-600" : "text-amber-600"}`}>
                    {revoked ? "REVOKED" : row.confirmed ? "live" : "pending confirmation"}
                  </span>
                </div>
                <CardDescription>{row.mandate.intentConstraint}</CardDescription>
              </CardHeader>
              <CardContent className="flex flex-col gap-2 text-sm">
                <p className="text-muted-foreground">
                  allowlist: {row.mandate.merchantAllowlist.join(", ") || "(none)"} · chain{" "}
                  {row.mandate.chainId} · inSync: {row.inSync === null ? "n/a" : String(row.inSync)}
                </p>
                {usage && (
                  <p>
                    spend: {formatXsgd(usage.spent)} / {formatXsgd(usage.maxPerWindow)} XSGD · cards:{" "}
                    {usage.cardCount} / {usage.maxCardsPerWindow}
                  </p>
                )}
                {!revoked && row.confirmed && (
                  <div>
                    <Button type="button" variant="destructive" size="sm" onClick={() => revoke(row.mandate)} disabled={busy !== null}>
                      Revoke
                    </Button>
                  </div>
                )}
              </CardContent>
            </Card>
          );
        })}
      </section>
    </div>
  );
}