"use client"

import { PageHeading } from "@/components/page-heading"
import { RunConsole } from "@/components/run-console"

export default function Page() {
  return (
    <div className="flex flex-col gap-8">
      <PageHeading
        title="Run"
        description="One thread: describe the purchase, let the agent draft the intent, create a live mandate in your wallet, then run it through every policy check."
      />
      <RunConsole />
    </div>
  )
}