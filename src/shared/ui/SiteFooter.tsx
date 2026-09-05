import Link from "next/link";

const FOOTER_LINKS = [
  { href: "/terms", label: "תקנון" },
  { href: "/returns", label: "מדיניות החזרות" },
  { href: "/privacy", label: "פרטיות" },
] as const;

/**
 * The site footer: Archivo-caps credit line + policy links (design/Main.dc.html).
 *
 * THE PADDING ON THE LINKS IS A TAP TARGET, NOT A STYLE CHOICE
 * -----------------------------------------------------------
 * Measured at 375px, these three links were 20px tall and "תקנון" was 28px
 * wide — under the 24×24 CSS-pixel floor WCAG 2.2 sets for a pointer target
 * (2.5.8), on the one piece of navigation that appears on every page in the
 * product, and the only route to the three legal documents. `py-2 px-1` takes
 * them to 36×36 without changing the type or the spacing a reader sees; the
 * matching `-my-2` on the nav keeps the footer the height the mockup draws,
 * so the target grows and the layout does not.
 */
export function SiteFooter() {
  return (
    <footer className="flex flex-col items-center gap-4 border-t border-rule px-6 py-7 sm:flex-row sm:items-center sm:justify-between sm:px-14 sm:py-[30px]">
      <span className="caps text-caps-sm text-ink-muted">Empowering Creators Since 2026</span>
      <nav
        aria-label="ניווט תחתון"
        className="-my-2 flex items-center gap-5 text-[13px] text-ink-muted"
      >
        {FOOTER_LINKS.map((link) => (
          <Link
            key={link.href}
            href={link.href}
            className="inline-flex items-center px-1 py-2 hover:text-ink-soft"
          >
            {link.label}
          </Link>
        ))}
      </nav>
    </footer>
  );
}
