/**
 * /admin — the index.
 *
 * Deliberately plain: the design set has no admin layout, and inventing one
 * would be inventing a design. Links, and the same not-found answer every other
 * admin surface gives.
 */
import Link from "next/link";
import { getDatabase } from "@/shared/db";
import { Card, SectionHeading } from "@/shared/ui";
import { currentUserId } from "../_lib/viewer";
import { adminOrNotFound } from "./access";

export const dynamic = "force-dynamic";

export const metadata = { title: "ניהול — פאצ׳קה" };

const SURFACES = [
  { href: "/admin/queue", label: "תור המנהלים", body: "דיווחים פתוחים והעלאות שסומנו." },
  { href: "/admin/shipping", label: "טבלת המשלוחים", body: "תעריף לכל אזור וגודל." },
] as const;

export default async function AdminHomePage() {
  await adminOrNotFound(getDatabase(), await currentUserId());

  return (
    <div className="mx-auto flex max-w-[900px] flex-col gap-8 px-6 py-12 sm:px-12">
      <SectionHeading as="h1">ניהול</SectionHeading>
      <ul className="grid gap-4 sm:grid-cols-2">
        {SURFACES.map((surface) => (
          <li key={surface.href}>
            <Card className="p-5">
              <Link href={surface.href} className="text-lg font-bold">
                {surface.label}
              </Link>
              <p className="m-0 mt-2 text-[14px] text-ink-soft">{surface.body}</p>
            </Card>
          </li>
        ))}
      </ul>
    </div>
  );
}
