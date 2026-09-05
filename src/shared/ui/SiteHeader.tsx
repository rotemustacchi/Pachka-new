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
 * exact colours from the mockups, fluid padding for mobile.
 */
export function SiteHeader() {
  return (
    <header className="flex items-center justify-between border-b border-rule px-6 py-5 sm:px-14 sm:py-[26px]">
      <Link href="/" className="flex items-center gap-3" aria-label="פאצ׳קה, לעמוד הבית">
        <LogoMark className="h-7 w-11 text-ink" />
        <Wordmark className="h-6 w-auto text-ink" />
      </Link>
      <nav aria-label="ניווט ראשי" className="flex items-center gap-5 text-[15px] font-medium sm:gap-[30px]">
        {NAV_LINKS.map((link) => (
          <Link key={link.href} href={link.href} className="hover:text-ink-soft">
            {link.label}
          </Link>
        ))}
        <Link href="/sign-in" className="text-ink-muted hover:text-ink-soft">
          כניסה
        </Link>
      </nav>
    </header>
  );
}
