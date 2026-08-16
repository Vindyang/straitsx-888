"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { RiArrowRightLine } from "@remixicon/react";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "../../components/ui/card";
import { PageHeading } from "../../components/page-heading";

type RunSummary = {
  requestId: string;
  meta: { instruction: string; mandateId: string; fixture?: string; source?: { kind: string; name?: string; profileId?: string } };
  createdAt: string;
  state: "RUNNING" | "AWAITING_CHECKOUT" | "DONE" | "REFUSED" | "ESCALATED" | "FAILED";
  outcome?: { status: string; check?: string };
};

const STATE_BADGE: Record<string, string> = {
  RUNNING: "bg-amber-600/15 text-amber-700",
  AWAITING_CHECKOUT: "bg-sky-600/15 text-sky-700",
  DONE: "bg-green-600/15 text-green-700",
  REFUSED: "bg-red-600/15 text-red-700",
  ESCALATED: "bg-amber-600/15 text-amber-700",
  FAILED: "bg-muted text-muted-foreground",
};

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
    <div className="flex flex-col gap-8">
      <PageHeading
        title="Runs"
        description="Every run and its outcome. Refused runs never sign anything."
      />
      {runs.length === 0 && (
        <p className="text-sm text-muted-foreground">No runs yet — start one from the home page.</p>
      )}
      <section className="flex flex-col gap-4">
        {runs.map((run) => (
          <Link key={run.requestId} href={`/runs/${run.requestId}`} className="group">
            <Card className="transition-colors group-hover:bg-muted/40">
              <CardHeader>
                <div className="flex items-center justify-between gap-4">
                  <CardTitle className="font-mono text-sm">{run.requestId.slice(0, 8)}</CardTitle>
                  <span className={`rounded-full px-3 py-1 text-xs font-semibold ${STATE_BADGE[run.state] ?? "bg-muted"}`}>
                    {run.state}
                  </span>
                </div>
                <CardDescription className="text-foreground">{run.meta.instruction}</CardDescription>
              </CardHeader>
              <CardContent className="flex items-center justify-between text-sm text-muted-foreground">
                <span>
                  source: {run.meta.fixture ?? run.meta.source?.profileId ?? run.meta.source?.name ?? "unknown"}
                  {run.outcome?.check ? ` · ${run.outcome.check}` : ""}
                </span>
                <RiArrowRightLine className="size-4 opacity-0 transition-opacity group-hover:opacity-60" />
              </CardContent>
            </Card>
          </Link>
        ))}
      </section>
    </div>
  );
}