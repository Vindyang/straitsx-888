"use client";

import { useEffect, useState } from "react";
import Link from "next/link";

type RunSummary = {
  requestId: string;
  meta: { instruction: string; mandateId: string; fixture?: string; source?: { kind: string; name?: string; profileId?: string } };
  createdAt: string;
  state: "RUNNING" | "AWAITING_CHECKOUT" | "DONE" | "REFUSED" | "ESCALATED" | "FAILED";
  outcome?: { status: string; check?: string };
};

const STATE_COLOR: Record<string, string> = {
  RUNNING: "#a60",
  AWAITING_CHECKOUT: "#075985",
  DONE: "green",
  REFUSED: "crimson",
  ESCALATED: "#a60",
  FAILED: "#888",
};

/** C12 — the run list. Each row links to the refusal panel (or escalation
 *  screen, or receipt) for that run. */
export default function RunsPage() {
  const [runs, setRuns] = useState<RunSummary[]>([]);

  useEffect(() => {
    const load = () =>
      fetch("/api/runs", { cache: "no-store" })
        .then((res) => res.json() as Promise<RunSummary[]>)
        .then(setRuns);
    void load();
    const interval = setInterval(load, 3000);
    return () => clearInterval(interval);
  }, []);

  return (
    <main style={{ maxWidth: 960, margin: "0 auto", padding: "2rem" }}>
      <h1>Runs</h1>
      {runs.length === 0 && <p style={{ color: "#666" }}>No runs yet — start one from the home page.</p>}
      {runs.map((run) => (
        <Link
          key={run.requestId}
          href={`/runs/${run.requestId}`}
          style={{
            display: "block",
            border: "1px solid #ddd",
            borderRadius: 8,
            padding: "1rem",
            marginBottom: "0.75rem",
            textDecoration: "none",
            color: "inherit",
          }}
        >
          <div style={{ display: "flex", justifyContent: "space-between" }}>
            <code>{run.requestId.slice(0, 8)}</code>
            <span style={{ color: STATE_COLOR[run.state] ?? "#333", fontWeight: 600 }}>{run.state}</span>
          </div>
          <p style={{ margin: "0.5rem 0" }}>{run.meta.instruction}</p>
          <p style={{ margin: 0, color: "#666", fontSize: "0.9em" }}>
            source: {run.meta.fixture ?? run.meta.source?.profileId ?? run.meta.source?.name ?? "unknown"}
            {run.outcome && "check" in run.outcome && run.outcome.check ? ` · ${run.outcome.check}` : ""}
          </p>
        </Link>
      ))}
    </main>
  );
}
