"use client"

import Link from "next/link"
import { usePathname } from "next/navigation"
import {
  RiNotification3Line,
  RiSecurePaymentLine,
  RiFileList3Line,
  RiTestTubeLine,
  RiHome5Line,
  RiHistoryLine,
} from "@remixicon/react"

import { cn } from "@/lib/utils"

const navigation = [
  { href: "/", label: "Run", icon: RiHome5Line },
  { href: "/mandates", label: "Mandates", icon: RiSecurePaymentLine },
  { href: "/runs", label: "Runs", icon: RiFileList3Line },
  { href: "/ledger", label: "Ledger", icon: RiHistoryLine },
  { href: "/injection-demo", label: "Injection boundary", icon: RiTestTubeLine },
]

function isCurrent(pathname: string, href: string) {
  if (href === "/") return pathname === href
  return pathname.startsWith(href)
}

export function AppShell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname()

  return (
    <div className="min-h-svh bg-background">
      <aside className="fixed inset-y-0 left-0 hidden w-60 border-r bg-background px-5 py-8 lg:flex lg:flex-col">
        <Link
          href="/"
          className="flex min-h-11 items-center gap-3 text-xl font-semibold text-primary"
        >
          <span
            aria-hidden="true"
            className="flex size-8 items-center justify-center border border-primary"
          >
            S
          </span>
          StraitsX
        </Link>
        <nav className="mt-14 flex flex-col gap-2" aria-label="Primary">
          {navigation.map((item) => {
            const active = isCurrent(pathname, item.href)
            const Icon = item.icon
            return (
              <Link
                key={item.href}
                href={item.href}
                aria-current={active ? "page" : undefined}
                className={cn(
                  "flex min-h-12 items-center gap-3 px-3 text-sm font-medium transition-colors",
                  active
                    ? "bg-primary/8 text-primary"
                    : "text-muted-foreground hover:bg-muted hover:text-foreground"
                )}
              >
                <Icon aria-hidden="true" className="size-5" />
                {item.label}
              </Link>
            )
          })}
        </nav>
        <p className="mt-auto text-xs leading-5 text-muted-foreground">
          Mandated payments
          <br />
          Nothing signs without a live mandate
        </p>
      </aside>

      <div className="lg:pl-60">
        <header className="sticky top-0 z-20 flex h-16 items-center justify-between border-b bg-background/95 px-5 backdrop-blur lg:justify-end lg:px-10">
          <Link
            href="/"
            className="flex items-center gap-2 text-lg font-semibold text-primary lg:hidden"
          >
            <span
              aria-hidden="true"
              className="flex size-7 items-center justify-center border border-primary text-sm"
            >
              S
            </span>
            StraitsX
          </Link>
          <span
            aria-label="Operational notifications"
            className="relative flex size-11 items-center justify-center text-muted-foreground"
          >
            <RiNotification3Line aria-hidden="true" className="size-5" />
          </span>
        </header>

        <main className="mx-auto w-full max-w-7xl px-5 pt-8 pb-28 md:px-8 lg:px-12 lg:pt-12 lg:pb-12">
          {children}
        </main>
      </div>

      <nav
        className="pb-safe fixed inset-x-0 bottom-0 z-30 grid grid-cols-5 border-t bg-background/98 px-2 pt-2 backdrop-blur lg:hidden"
        aria-label="Primary"
      >
        {navigation.map((item) => {
          const active = isCurrent(pathname, item.href)
          const Icon = item.icon
          return (
            <Link
              key={item.href}
              href={item.href}
              aria-current={active ? "page" : undefined}
              className={cn(
                "flex min-h-14 flex-col items-center justify-center gap-1 text-[11px] font-medium transition-colors",
                active ? "text-primary" : "text-muted-foreground"
              )}
            >
              <Icon aria-hidden="true" className="size-5" />
              {item.label}
            </Link>
          )
        })}
      </nav>
    </div>
  )
}