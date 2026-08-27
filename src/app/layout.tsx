import type { Metadata } from "next";
import { Heebo, Archivo } from "next/font/google";
import { PaperGrain } from "@/assets";
import { SiteHeader, SiteFooter } from "@/shared/ui";
import "./globals.css";

// Heebo: the Hebrew-and-Latin UI face (design.md). Hebrew subset is
// mandatory — this is a Hebrew-first product, not a Latin one with a Hebrew
// fallback.
const heebo = Heebo({
  subsets: ["hebrew", "latin"],
  weight: ["300", "400", "500", "700", "900"],
  variable: "--font-heebo",
  display: "swap",
});

// Archivo: the caps-accent face. Latin only — it is never used for Hebrew
// text (design.md).
const archivo = Archivo({
  subsets: ["latin"],
  weight: ["600", "800"],
  variable: "--font-archivo",
  display: "swap",
});

export const metadata: Metadata = {
  title: "פאצ׳קה — אמנות מקורית, מותאמת לחלל שלכם",
  description: "פאצ׳קה מחברת בין אמנים מהקהילה לבין הבית שמחכה ליצירה שלהם.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  // Hebrew is the document default, not a mirror pass (task 1.2): lang="he"
  // dir="rtl" here, not toggled by a locale switch.
  return (
    <html lang="he" dir="rtl" className={`${heebo.variable} ${archivo.variable}`}>
      <body className="flex min-h-dvh flex-col antialiased">
        <PaperGrain />
        <SiteHeader />
        <main className="flex-1">{children}</main>
        <SiteFooter />
      </body>
    </html>
  );
}
