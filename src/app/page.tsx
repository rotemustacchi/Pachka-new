import Link from "next/link";
import { Badge, Button, Card, SectionHeading } from "@/shared/ui";

/**
 * Presentational placeholder home page (task 1.5) — renders the base layout
 * and shared primitives so the design system is visible end to end. No
 * business logic, no data fetching: the featured works below are static
 * display data, not a catalog query (that is task 5, `modules/catalog`).
 */

interface FeaturedWork {
  readonly id: string;
  readonly title: string;
  readonly artist: string;
  readonly price: string;
  readonly swatch: string;
  readonly aiAssisted?: boolean;
}

const FEATURED_WORKS: readonly FeaturedWork[] = [
  { id: "1", title: "אגרטל חימר, ידני", artist: "נועה ברזילי", price: "₪ 480", swatch: "#B4664A" },
  { id: "2", title: "קו החוף, שקיעה", artist: "יעל שוורץ", price: "₪ 1,250", swatch: "#2E4756" },
  { id: "3", title: "קווים מס׳ 7", artist: "דנה אלמוג", price: "₪ 720", swatch: "#8C4A34" },
  {
    id: "4",
    title: "מעגלים, פופ",
    artist: "איתי לוין",
    price: "₪ 950",
    swatch: "#C4442E",
    aiAssisted: true,
  },
];

const STEPS = [
  {
    number: "01",
    title: "עונים על שאלון קצר",
    body: "סגנון, חלל, וייב ותקציב. שש שאלות, פחות מדקה.",
  },
  {
    number: "02",
    title: "מקבלים התאמות",
    body: "האוצר הדיגיטלי מדרג את יצירות הקהילה מול מה שסיפרתם.",
  },
  {
    number: "03",
    title: "קונים ישירות מהאמן",
    body: "היצירה נשלחת מהסטודיו, עם תעודת מקוריות דיגיטלית.",
  },
] as const;

export default function HomePage() {
  return (
    <>
      <section className="grid gap-14 px-6 py-16 sm:px-14 sm:py-[76px] lg:grid-cols-[1.05fr_.95fr] lg:items-center">
        <div>
          <p className="caps text-caps mb-5 text-ink-muted">Your Personal Art Curator</p>
          <h1 className="mb-6 text-[40px] font-black leading-[1.06] tracking-[-.02em] sm:text-[60px]">
            אמנות מקורית,
            <br />
            מותאמת לחלל שלכם.
          </h1>
          <p className="mb-9 max-w-[480px] text-lg font-light leading-relaxed text-ink-soft">
            פאצ׳קה מחברת בין יוצרים מהקהילה לבין הבית שמחכה ליצירה שלהם. ענו על שאלון קצר, וקבלו
            התאמות אישיות במקום אינסוף גלילה.
          </p>
          <div className="flex flex-wrap items-center gap-4">
            <Button variant="primary">התחילו את ההתאמה</Button>
            <Link href="/catalog" className="border-b border-rule pb-1 text-base font-medium">
              או עיינו בקטלוג
            </Link>
          </div>
        </div>
        <div className="relative">
          <div className="border border-rule bg-card p-10">
            <p className="text-center text-ink-muted">תצוגה מקדימה של יצירה</p>
          </div>
          <div className="absolute bottom-[-16px] start-[-16px] bg-ink px-5 py-3 text-paper">
            <p className="text-[13px] font-light opacity-70">״כלי חימר מס׳ 3״</p>
            <p className="text-[15px] font-bold">נועה ברזילי</p>
          </div>
        </div>
      </section>

      <section className="px-6 pb-16 sm:px-14 sm:pb-[70px]">
        <div className="mb-7 flex items-end justify-between">
          <SectionHeading>יצירות נבחרות</SectionHeading>
          <Link href="/catalog" className="border-b border-rule pb-[3px] text-[15px] text-ink-muted">
            לכל הקטלוג ←
          </Link>
        </div>
        <div className="grid gap-5 sm:grid-cols-2 lg:grid-cols-4">
          {FEATURED_WORKS.map((work) => (
            <Card key={work.id} className="relative">
              {work.aiAssisted ? <Badge variant="ai">נוצר בעזרת AI</Badge> : null}
              <div className="h-[180px] w-full" style={{ backgroundColor: work.swatch }} aria-hidden="true" />
              <div className="p-4">
                <p className="mb-1 text-base font-bold">{work.title}</p>
                <p className="mb-3 text-[13px] text-ink-muted">{work.artist}</p>
                <p className="numeric text-base font-bold">{work.price}</p>
              </div>
            </Card>
          ))}
        </div>
      </section>

      <section className="border-y border-rule bg-paper-deep px-6 py-14 sm:px-14">
        <div className="grid gap-11 sm:grid-cols-3">
          {STEPS.map((step) => (
            <div key={step.number}>
              <p className="caps text-caps mb-4 text-ink-muted">{step.number}</p>
              <p className="mb-2 text-xl font-bold">{step.title}</p>
              <p className="text-[15px] font-light leading-relaxed text-ink-soft">{step.body}</p>
            </div>
          ))}
        </div>
      </section>

      <section className="flex flex-col items-start gap-8 px-6 py-14 sm:flex-row sm:items-center sm:justify-between sm:px-14">
        <div>
          <p className="caps text-caps mb-3 text-ink-muted">The Artist&apos;s Platform</p>
          <p className="mb-2 text-[28px] font-black">אתם יוצרים?</p>
          <p className="max-w-[520px] text-base font-light leading-relaxed text-ink-soft">
            פתחו חנות בלי עלות התחלתית. העלו תמונה, והמערכת מתייגת אותה בשבילכם.
          </p>
        </div>
        <Button variant="secondary" className="whitespace-nowrap">
          הצטרפו כאמן
        </Button>
      </section>
    </>
  );
}
