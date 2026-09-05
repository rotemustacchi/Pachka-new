import Link from "next/link";
import { LogoMark, Wordmark } from "@/assets";

/**
 * Every href here must resolve to a route that exists under `src/app`.
 * `siteHeader.test.tsx` asserts exactly that, because a header link is on every
 * page in the product and a 404 from the primary nav is the most visible
 * possible defect.
 *
 * `/catalog` is served by the catalog module's route wiring; `/artists` lists
 * every artist with published work. Both now exist, so both are back in the nav
 * — in the order design/Main.dc.html and design/Catalog.dc.html draw them.
 */
const NAV_LINKS = [
  { href: "/catalog", label: "קטלוג" },
  { href: "/artists", label: "אמנים" },
  { href: "/become-an-artist", label: "הצטרפות כאמן" },
] as const;

/**
 * The site header: logo mark + wordmark, and the RTL primary nav
 * (design/Main.dc.html, design/Catalog.dc.html). 1px `--rule` bottom border,
 * exact colours from the mockups.
 *
 * MOBILE. This used to demand 431px — a 152px logo, 231px of nav and 48px of
 * padding, laid out in a single unwrapping row. Because the header renders on
 * every page, that made the ENTIRE PRODUCT scroll sideways on a phone: 32px of
 * overflow at 375, 87px at 320. Hiding the header alone brought the document
 * back to exactly 375, which is how the audit pinned it here.
 *
 * The fix is layout, not a breakpoint hack and not a hamburger: the header
 * wraps, the nav wraps within it, and the logo steps down below `sm`. Every
 * link stays reachable at every width, which a collapsed menu would not give
 * for free.
 */
export function SiteHeader() {
  return (
    <header className="flex flex-wrap items-center justify-between gap-x-4 gap-y-3 border-b border-rule px-4 py-4 sm:px-14 sm:py-[26px]">
      <Link href="/" className="flex items-center gap-3" aria-label="פאצ׳קה, לעמוד הבית">
        <LogoMark className="h-6 w-10 shrink-0 text-ink sm:h-7 sm:w-11" />
        <Wordmark className="h-5 w-auto text-ink sm:h-6" />
      </Link>
      <nav
        aria-label="ניווט ראשי"
        className="flex flex-wrap items-center gap-x-4 gap-y-2 text-[14px] font-medium sm:gap-x-[30px] sm:text-[15px]"
      >
        {NAV_LINKS.map((link) => (
          <Link key={link.href} href={link.href} className="py-1 hover:text-ink-soft">
            {link.label}
          </Link>
        ))}
        <Link href="/sign-in" className="py-1 text-ink-muted hover:text-ink-soft">
          כניסה
        </Link>
      </nav>
    </header>
  );
}
