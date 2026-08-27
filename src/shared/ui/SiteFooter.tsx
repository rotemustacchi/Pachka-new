import Link from "next/link";

const FOOTER_LINKS = [
  { href: "/terms", label: "תקנון" },
  { href: "/returns", label: "מדיניות החזרות" },
  { href: "/privacy", label: "פרטיות" },
] as const;

/** The site footer: Archivo-caps credit line + policy links (design/Main.dc.html). */
export function SiteFooter() {
  return (
    <footer className="flex flex-col items-center gap-4 border-t border-rule px-6 py-7 sm:flex-row sm:items-center sm:justify-between sm:px-14 sm:py-[30px]">
      <span className="caps text-caps-sm text-ink-muted">Empowering Creators Since 2026</span>
      <nav aria-label="ניווט תחתון" className="flex items-center gap-6 text-[13px] text-ink-muted">
        {FOOTER_LINKS.map((link) => (
          <Link key={link.href} href={link.href} className="hover:text-ink-soft">
            {link.label}
          </Link>
        ))}
      </nav>
    </footer>
  );
}
