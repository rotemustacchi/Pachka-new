/**
 * /returns — מדיניות ההחזרות.
 *
 * THE STATEMENTS ARE NOT TYPED INTO THIS PAGE
 * -------------------------------------------
 * `shipping.returnTerms()` already owns the wording of the six disclosures the
 * artwork page and the checkout summary show, and `_shipping/load.ts` says why:
 * the window and the cancellation fee are configuration, so a page with
 * "14 ימים" typed into it is a disclosure that silently stops matching the
 * policy the moment an operator changes `returns.window_days`. This page is a
 * third surface for the same terms, so it renders the same data — and the
 * narrative around it derives every number from the same `ReturnTerms`.
 *
 * `force-dynamic` for the same reason: a cached returns policy is a policy that
 * can contradict the one the checkout applies.
 *
 * `ReturnsDocument` is exported and takes its two configured values as props so
 * that an integration test can render THE REAL DOCUMENT against a real database
 * with a real `app_config` — the same split, and for the same reason, as
 * `routes-return-terms.test.ts`. A test that rebuilt the prose itself would
 * pass just as happily against a page with "14 ימים" typed into it.
 *
 * WHAT THIS PAGE ADDS THAT THE PANEL DOES NOT
 * -------------------------------------------
 * The panel is a pre-purchase summary. A policy page has to answer the
 * questions that arise after: what happens to a return that arrives damaged,
 * what happens when it never arrives, why the address is PACHKA's rather than
 * the artist's, and which parts of the refund are still undecided. Two of those
 * are genuinely open — the cancellation-fee decision and whether the outbound
 * shipping is refunded — and both are marked rather than answered.
 */
import type { Metadata } from "next";
import { getConfig } from "@/shared/config";
import { getDatabase } from "@/shared/db";
import type { ReturnTerms } from "@/modules/shipping";
import { loadReturnTerms } from "@/app/_shipping/load";
import { LegalDocument, Clause, Points, Review, Num } from "../LegalDocument";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "מדיניות החזרות — פאצ׳קה",
  description:
    "זכות הביטול, אופן החזרת יצירה לכתובת ההחזרות של פאצ׳קה, מי נושא בעלות ההחזרה ומתי מתקבל הזיכוי.",
};

export default async function ReturnsPage() {
  const db = getDatabase();

  // `returns.refund_includes_outbound_shipping` is read directly rather than
  // typed into a sentence. `ReturnTerms` does not carry it — which is itself a
  // reported gap, because it means the pre-purchase panel never discloses it —
  // so this page reads the same key the refund calculation reads, and says
  // whichever thing is actually configured.
  const [terms, refundsOutboundShipping] = await Promise.all([
    loadReturnTerms(),
    getConfig(db, "returns.refund_includes_outbound_shipping"),
  ]);

  return <ReturnsDocument terms={terms} refundsOutboundShipping={refundsOutboundShipping} />;
}

export interface ReturnsDocumentProps {
  readonly terms: ReturnTerms;
  readonly refundsOutboundShipping: boolean;
}

export function ReturnsDocument({ terms, refundsOutboundShipping }: ReturnsDocumentProps) {
  const feePercent = Math.round(terms.cancellationFeeRate * 1000) / 10;

  return (
    <LegalDocument
      title="מדיניות ביטול והחזרות"
      summary="מה ניתן להחזיר, לאן שולחים, מי משלם על משלוח ההחזרה ומתי מתקבל הזיכוי."
    >
      <Clause heading="חלון הביטול">
        <p>
          ניתן לבקש ביטול עסקה והחזרת היצירה בתוך <Num>{terms.windowDays}</Num> ימים מיום קבלת
          היצירה, בהתאם לזכות הביטול בעסקת מכר מרחוק לפי חוק הגנת הצרכן, התשמ״א־1981.
        </p>
        <p>
          בקשה שמוגשת לאחר שהחלון נסגר נדחית, והמערכת מודיעה שהתקופה הקבועה בדין חלפה.
        </p>
        <p>
          <Review>
            הדין קובע תקופת ביטול ארוכה יותר לאוכלוסיות מסוימות (בין היתר אדם עם מוגבלות, אזרח
            ותיק ועולה חדש). המערכת מיישמת כיום חלון אחיד לכל הקונים ואינה מזהה זכאות מורחבת —
            יש להכריע כיצד ניתנת התקופה המורחבת ולתעד זאת כאן
          </Review>
        </p>
        <p>
          <Review>
            סוגי טובין שהדין מוציא מזכות הביטול, ובכלל זה טובין שיוצרו במיוחד עבור הקונה לפי
            מידותיו או דרישותיו — לפאצ׳קה יש יצירות בהזמנה אישית, וצריך להכריע אם והיכן החריג חל
          </Review>
        </p>
      </Clause>

      <Clause heading="התנאים במלואם">
        <p>אלה בדיוק התנאים שמוצגים בעמוד היצירה ובמסך התשלום לפני הרכישה:</p>
        <Points>
          {terms.statements.map((statement) => (
            <li key={statement.code}>{statement.text}</li>
          ))}
        </Points>
      </Clause>

      <Clause heading="איך מגישים בקשה">
        <p>
          הבקשה מוגשת דרך הפלטפורמה, ולא מול האמן. עם אישור הבקשה נשלחות לקונה הוראות החזרה
          הכוללות את כתובת ההחזרות של פאצ׳קה.
        </p>
        <p>
          <Review by="operator">
            ערוץ הגשת הבקשה בפועל. באתר אין כיום מסך שדרכו קונה מגיש בקשת ביטול, ועד שייבנה יש
            לקבוע ולפרסם כאן כתובת דוא״ל או טופס שאליהם פונים
          </Review>
        </p>
        <p>
          <Review by="operator">
            כתובת ההחזרות של פאצ׳קה עצמה. הערך השמור בהגדרות המערכת הוא כתובת דמה, וכל עוד הוא כזה
            לא ניתן לשלוח החזרה בפועל
          </Review>
        </p>
      </Clause>

      <Clause heading="לאן נשלחת ההחזרה, ולמה לא לאמן">
        <p>
          כל החזרה נשלחת לכתובת ההחזרות של פאצ׳קה בלבד. הוראות ההחזרה אינן כוללות כתובת, טלפון או
          דוא״ל של אמן, וגם כתובת השולח שמודפסת על החבילה היוצאת אל הקונה היא של פאצ׳קה — אחרת
          כתובתו הפרטית של האמן הייתה נחשפת כבר במכירה הראשונה.
        </p>
        <p>
          עם הגעת החבילה, נציג פאצ׳קה רושם את קבלתה ואת מצב היצירה, ורק אז מועברת היצירה לאמן.
          כתובת האמן מופיעה על תווית ההעברה הפנימית בלבד, ואינה נחשפת לקונה בשום שלב.
        </p>
      </Clause>

      <Clause heading="עלות ההחזרה והסיכון בדרך">
        <p>
          עלות משלוח ההחזרה חלה על הקונה, וכך גם האחריות לנזק שייגרם ליצירה במהלך משלוח ההחזרה.
          מומלץ לארוז את היצירה באריזה שבה התקבלה. אין בפלטפורמה ביטוח שבר.
        </p>
      </Clause>

      <Clause heading="הזיכוי">
        <Points>
          <li>
            הזיכוי מבוצע לאחר שנציג פאצ׳קה רשם את קבלת היצירה בכתובת ההחזרות במצבה המקורי. במקרה
            שנוי במחלוקת, ההכרעה היא של מנהל מערכת.
          </li>
          <li>
            {terms.cancellationFeeRate > 0 ? (
              <>
                מהזיכוי נגרעים דמי ביטול בשיעור <Num>{feePercent}%</Num> ממחיר היצירה.
              </>
            ) : (
              <>כיום לא נגבים דמי ביטול, והזיכוי הוא במלוא מחיר היצירה.</>
            )}{" "}
            <Review>
              ההכרעה על דמי הביטול טרם התקבלה. הדין מגביל את דמי הביטול לשיעור של{" "}
              <Num>5%</Num> ממחיר העסקה או <Num>100</Num> ש״ח, לפי הנמוך מביניהם, והמערכת חוסמת
              שיעור גבוה מ־<Num>5%</Num>. את התקרה השקלית יש לאכוף ולנסח כאן
            </Review>
          </li>
          <li>
            דמי המשלוח שהקונה שילם במשלוח היוצא{" "}
            {refundsOutboundShipping ? "מוחזרים לו" : "אינם מוחזרים"}.{" "}
            <Review>
              האם דמי המשלוח היוצא מוחזרים לקונה בביטול. זו שאלה משפטית ולא העדפה הנדסית, וברירת
              המחדל שנבחרה במערכת היא הפרשנות המחמירה — הקונה נושא בעלות ההחזרה, והמשלוח היוצא כבר
              בוצע
            </Review>
          </li>
          <li>
            <Review by="operator">
              אופן מתן הזיכוי ולוח הזמנים שלו — אין באתר סליקה מקוונת, ולכן ההשבה מבוצעת ידנית
            </Review>
          </li>
        </Points>
      </Clause>

      <Clause heading="החזרה שהגיעה פגומה, או שלא הגיעה">
        <Points>
          <li>
            יצירה שנרשמה כמי שהגיעה פגומה — הזיכוי מעוכב, המקרה עובר לתור טיפול של מנהל מערכת,
            ושני הצדדים מקבלים הודעה.
          </li>
          <li>
            החזרה שאישור קבלתה לא נרשם בתוך התקופה הקבועה מרגע הבקשה מועברת לבדיקת מנהל, ואינה
            מזוכה אוטומטית.
          </li>
          <li>
            אמן שקיבל יצירה מוחזרת ואינו מגיב בתוך התקופה הקבועה — המקרה עולה למנהל מערכת, שרשאי
            להכריע לטובת הקונה. שתיקת אמן אינה מעכבת את כספו של הקונה ללא הגבלת זמן.
          </li>
        </Points>
      </Clause>

      <Clause heading="מה קורה ליצירה שהוחזרה">
        <p>
          יצירה חוזרת להיות זמינה לרכישה רק כשההחזרה הסתיימה והיצירה נמצאה תקינה. כל עוד ההחזרה
          פתוחה או שנויה במחלוקת, היצירה אינה ניתנת לרכישה. תעודת המקוריות שהונפקה לעסקה שבוטלה
          מוצגת בעמוד האימות הציבורי כבטלה.
        </p>
      </Clause>
    </LegalDocument>
  );
}
