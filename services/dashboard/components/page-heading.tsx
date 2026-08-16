import Link from "next/link"
import { RiArrowLeftLine } from "@remixicon/react"

export function PageHeading({
  title,
  description,
  backHref,
}: {
  title: string
  description?: string
  backHref?: string
}) {
  return (
    <header className="flex max-w-2xl flex-col gap-3">
      {backHref ? (
        <Link
          href={backHref}
          className="flex min-h-11 w-fit items-center gap-2 text-sm font-medium text-muted-foreground hover:text-foreground"
        >
          <RiArrowLeftLine aria-hidden="true" className="size-4" />
          Back
        </Link>
      ) : null}
      <h1 className="text-3xl font-semibold tracking-tight md:text-4xl">
        {title}
      </h1>
      {description ? (
        <p className="max-w-xl text-sm leading-6 text-muted-foreground md:text-base">
          {description}
        </p>
      ) : null}
    </header>
  )
}
