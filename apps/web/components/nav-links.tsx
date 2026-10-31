"use client";

import { Menu } from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { NAV } from "@/lib/site";

export function NavLinks() {
  const path = usePathname();
  return (
    <nav className="nav" aria-label="Main">
      {NAV.map((item) => (
        <Link key={item.href} href={item.href} aria-current={path === item.href ? "page" : undefined}>
          {item.label}
        </Link>
      ))}
    </nav>
  );
}

/**
 * The same links in a disclosure for narrow screens, which works without JavaScript. Keyed on the
 * path, so following a link mounts a fresh, closed menu.
 */
export function MobileNav() {
  const path = usePathname();
  return (
    <details className="mnav" key={path}>
      <summary aria-label="Menu">
        <Menu strokeWidth={1.5} aria-hidden />
      </summary>
      <nav className="mnav-panel" aria-label="Main">
        <Link href="/" aria-current={path === "/" ? "page" : undefined}>
          Home
        </Link>
        {NAV.map((item) => (
          <Link key={item.href} href={item.href} aria-current={path === item.href ? "page" : undefined}>
            {item.label}
          </Link>
        ))}
      </nav>
    </details>
  );
}
