"use client";

import { useCallback, useEffect, useState } from "react";
import { FUJI } from "@straitsx/contracts";
import type { Mandate } from "@straitsx/contracts";
import { formatXsgd, sgdToBaseUnits, shortHex } from "../../lib/format";
import { connectWallet, sendTransaction, waitForReceipt, type UnsignedTx } from "../../lib/wallet";

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
    merchantAllowlist: "shop.example",
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
    <main style={{ maxWidth: 960, margin: "0 auto", padding: "2rem" }}>
      <h1>Mandates</h1>
      <p style={{ color: "#666" }}>
        Creation builds an <em>unsigned</em> on-chain transaction — you sign it in your own
        wallet. Nothing here ever touches a private key.
      </p>

      {error && <p style={{ color: "crimson" }}>{error}</p>}
      {busy && <p style={{ color: "#666" }}>{busy}…</p>}

      <fieldset style={{ marginTop: "1.5rem" }}>
        <legend>Create mandate</legend>
        <Field label="owner (your wallet)">
          <input value={form.owner} onChange={(e) => setForm((p) => ({ ...p, owner: e.target.value }))} style={{ width: "70%" }} />
          <button type="button" onClick={connectOwner} style={{ marginLeft: 8 }}>
            Use connected wallet
          </button>
        </Field>
        <Field label="agentId">
          <input value={form.agentId} onChange={(e) => setForm((p) => ({ ...p, agentId: e.target.value }))} />
        </Field>
        <Field label="intentConstraint">
          <input
            value={form.intentConstraint}
            onChange={(e) => setForm((p) => ({ ...p, intentConstraint: e.target.value }))}
            style={{ width: "100%" }}
          />
        </Field>
        <Field label="merchantAllowlist (comma-separated)">
          <input
            value={form.merchantAllowlist}
            onChange={(e) => setForm((p) => ({ ...p, merchantAllowlist: e.target.value }))}
            style={{ width: "100%" }}
          />
        </Field>
        <Field label="maxPerCard (SGD)">
          <input
            value={form.maxPerCardSgd}
            onChange={(e) => setForm((p) => ({ ...p, maxPerCardSgd: e.target.value }))}
          />
        </Field>
        <Field label="maxPerWindow (SGD)">
          <input
            value={form.maxPerWindowSgd}
            onChange={(e) => setForm((p) => ({ ...p, maxPerWindowSgd: e.target.value }))}
          />
        </Field>
        <Field label="maxCardsPerWindow">
          <input
            type="number"
            value={form.maxCardsPerWindow}
            onChange={(e) => setForm((p) => ({ ...p, maxCardsPerWindow: Number(e.target.value) }))}
          />
        </Field>
        <Field label="windowSeconds">
          <input
            type="number"
            value={form.windowSeconds}
            onChange={(e) => setForm((p) => ({ ...p, windowSeconds: Number(e.target.value) }))}
          />
        </Field>
        <button type="button" onClick={createMandate} disabled={busy !== null || !form.owner}>
          Build + sign createMandate
        </button>
      </fieldset>

      <h2 style={{ marginTop: "2rem" }}>All mandates</h2>
      {rows.length === 0 && <p style={{ color: "#666" }}>None created from this dashboard yet.</p>}
      {rows.map((row) => {
        const usage = windows[row.mandate.mandateId];
        const revoked = row.onChain?.revoked ?? false;
        return (
          <div
            key={row.mandate.mandateId}
            style={{ border: "1px solid #ddd", borderRadius: 8, padding: "1rem", marginBottom: "1rem" }}
          >
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline" }}>
              <code>{shortHex(row.mandate.mandateId)}</code>
              <span style={{ color: revoked ? "crimson" : row.confirmed ? "green" : "#a60" }}>
                {revoked ? "REVOKED" : row.confirmed ? "live" : "pending confirmation"}
              </span>
            </div>
            <p style={{ margin: "0.5rem 0" }}>{row.mandate.intentConstraint}</p>
            <p style={{ margin: 0, color: "#666", fontSize: "0.9em" }}>
              allowlist: {row.mandate.merchantAllowlist.join(", ") || "(none)"} · chain{" "}
              {row.mandate.chainId} · inSync: {row.inSync === null ? "n/a" : String(row.inSync)}
            </p>
            {usage && (
              <p style={{ margin: "0.5rem 0", fontSize: "0.9em" }}>
                spend: {formatXsgd(usage.spent)} / {formatXsgd(usage.maxPerWindow)} XSGD · cards:{" "}
                {usage.cardCount} / {usage.maxCardsPerWindow}
              </p>
            )}
            {!revoked && row.confirmed && (
              <button type="button" onClick={() => revoke(row.mandate)} disabled={busy !== null}>
                Revoke
              </button>
            )}
          </div>
        );
      })}
    </main>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label style={{ display: "block", marginBottom: 8 }}>
      {label}
      <div>{children}</div>
    </label>
  );
}
