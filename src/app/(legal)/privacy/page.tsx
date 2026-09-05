/**
 * /privacy — מדיניות הפרטיות.
 *
 * WRITTEN FROM THE SCHEMA, NOT FROM A TEMPLATE
 * --------------------------------------------
 * The inventory of personal data below is the one ARCHITECTURE.md's table
 * ownership map actually describes, and the separations it names are real
 * schema facts rather than intentions:
 *
 *   profiles, account_status        display name, email verification state
 *   artist_profiles                 what a buyer may see: name, photo, bio, city
 *   artist_contact_details          email, phone, street address, social handles
 *   artist_payout_details           bank account holder, bank, branch, account
 *   orders / fulfilments            buyer name, phone, delivery address
 *   match_queries / notify_requests questionnaire answers, notify-me address
 *   admin_audit, order_transitions  who did what, and when
 *
 * The last two tables have every grant revoked from `anon` and `authenticated`,
 * because RLS is row-level and cannot hide a column from the PostgREST data
 * API. That is why this page can promise that an artist's phone number is not
 * merely filtered out of a response — it is not reachable by the key that ships
 * in the browser bundle at all.
 *
 * WHAT IS DELIBERATELY NOT CLAIMED
 * --------------------------------
 * Retention periods, the identity and location of the processors, the lawful
 * basis relied on, and whether a database registration or a privacy officer is
 * required are all left as marked gaps. Each of them is a statement about the
 * operator's arrangements rather than about the code, and a privacy policy that
 * invents one is worse than a privacy policy that admits it does not know.
 */
import type { Metadata } from "next";
import { LegalDocument, Clause, Points, Review } from "../LegalDocument";

export const metadata: Metadata = {
  title: "מדיניות פרטיות — פאצ׳קה",
  description: "איזה מידע אישי פאצ׳קה אוספת, לשם מה, מי רואה אותו ואילו זכויות יש למשתמש.",
};

export default function PrivacyPage() {
  return (
    <LegalDocument
      title="מדיניות פרטיות"
      summary="איזה מידע נאסף עליכם, למה הוא נחוץ, מי יכול לראות אותו ומה אפשר לדרוש בקשר אליו."
    >
      <Clause heading="מי אחראי על המידע">
        <p>
          בעל השליטה במידע הוא{" "}
          <Review>שם החברה הרשום ומספר החברה או מספר העוסק</Review>. פניות בענייני פרטיות יש להפנות
          אל <Review by="operator">כתובת דוא״ל ייעודית לפניות בנושא פרטיות</Review> או בדואר אל{" "}
          <Review by="operator">כתובת הדואר לפניות</Review>.
        </p>
        <p>
          <Review>
            חובות לפי חוק הגנת הפרטיות, התשמ״א־1981 ותקנות אבטחת מידע שמכוחו — רמת האבטחה שחלה על
            המאגר, וכן האם קמה חובת מינוי ממונה על הגנת הפרטיות או חובת רישום
          </Review>
        </p>
      </Clause>

      <Clause heading="איזה מידע נאסף">
        <p>
          <strong>מכל מי שנרשם:</strong> כתובת דואר אלקטרוני, סיסמה (נשמרת מוצפנת בשירות האימות
          ואינה נגישה לפאצ׳קה כטקסט), שם תצוגה, ומצב אימות הדוא״ל.
        </p>
        <p>
          <strong>מקונה שמבצע הזמנה:</strong> שם מלא, מספר טלפון וכתובת מסירה. אלה נאספים לפני
          התשלום משום שבלעדיהם לא ניתן למסור את היצירה, ולא לשום מטרה אחרת.
        </p>
        <p>
          <strong>מאמן:</strong> שם תצוגה, תמונת פרופיל, טקסט חופשי ועיר — אלה גלויים לציבור;
          וכן, בנפרד ולא לציבור, פרטי התקשרות (דוא״ל, טלפון, כתובת, חשבונות רשתות חברתיות) ופרטי
          בנק לתשלום (שם בעל החשבון, בנק, סניף ומספר חשבון).
        </p>
        <p>
          <strong>ממי שממלא את השאלון:</strong> התשובות לשאלון ההתאמה. השאלון אינו דורש חשבון. מי
          שמבקש לקבל עדכון על יצירות מתאימות מוסר גם כתובת דואר אלקטרוני, שנשמרת יחד עם תשובותיו.
        </p>
        <p>
          <strong>נוצר על ידי המערכת:</strong> רשומות ההזמנות ושינויי מצבן, רשומות משלוח והחזרה,
          תעודות מקוריות, ביקורות, ספירת הצגות של יצירה בשאלון, יומן פעולות של מנהלי מערכת, ונתונים
          טכניים המשמשים להגבלת קצב בקשות ולמניעת שימוש לרעה.
        </p>
        <p>
          <Review>
            אילו נתונים טכניים נשמרים בפועל להגבלת קצב ולמניעת שימוש לרעה, ולכמה זמן — ובפרט האם
            נשמרת כתובת IP
          </Review>
        </p>
      </Clause>

      <Clause heading="תמונות שאמנים מעלים">
        <p>
          כל תמונה שאמן מעלה נשלחת לספק בינה מלאכותית חיצוני לצורך אחד: הצעת סיווג ליצירה וסינון
          תוכן אסור. הניתוח מבוצע פעם אחת, בעת ההעלאה, ולא בכל חיפוש. שאלון ההתאמה אינו פונה לספק
          חיצוני כלל.
        </p>
        <p>
          התיאור שהמודל מייצר נסרק באותה סריקה שעוברות שדות הטקסט של האמן, כדי שפרט התקשרות שצויר
          על גבי הבד לא ייכנס לאתר דרך הדלת האחורית.
        </p>
        <p>
          <Review>
            זהות ספק הבינה המלאכותית, מיקום העיבוד, ותנאי עיבוד המידע מולו — לרבות משך שמירת
            התמונה אצלו והאם היא משמשת לאימון
          </Review>
        </p>
      </Clause>

      <Clause heading="מי רואה מה">
        <Points>
          <li>
            <strong>קונה לעולם אינו רואה פרטי קשר של אמן</strong> — לא לפני הרכישה, לא אחריה ולא
            לאחר שההזמנה סופקה. פרטים אלה שמורים בטבלאות נפרדות שאינן נגישות למפתח הציבורי של
            האתר, ולא רק מסוננים מהתשובה.
          </li>
          <li>
            <strong>אמן רואה את שם הקונה, הטלפון והכתובת</strong> רק עבור המשלוח שלו עצמו, ורק
            לאחר שההזמנה שולמה. אמן אינו רואה משלוח של אמן אחר, ואינו רואה פרטי קונה בהזמנה שטרם
            שולמה.
          </li>
          <li>
            <strong>פרטי הבנק של אמן</strong> גלויים לאמן עצמו ולמנהלי מערכת בלבד, ואינם מופיעים
            בשום מסך או תשובה שפונים לקונים.
          </li>
          <li>
            <strong>עמוד אימות תעודת מקוריות הוא ציבורי</strong> ואינו כולל את שם הקונה או כל פרט
            אחר עליו. שם הקונה מופיע רק בעותק שנמסר לו.
          </li>
          <li>
            <strong>ביקורת שכתב קונה מוצגת בפומבי</strong> עם שם התצוגה שלו בפרופיל האמן.
          </li>
          <li>
            <strong>מנהלי מערכת</strong> נדרשים למידע רחב יותר לצורך טיפול בדיווחים, בהחזרות
            ובתשלומים. כל פעולת מנהל נרשמת ביומן ביקורת.
          </li>
        </Points>
      </Clause>

      <Clause heading="עוגיות">
        <p>
          האתר משתמש בעוגיות תפעוליות בלבד: עוגיית התחברות שמזהה את המשתמש הרשום, ועוגייה שמחזיקה
          את תוכן עגלת הקניות. תוכן העגלה נבדק מחדש מול השרת בכל צפייה, ואף מחיר ששמור בעוגייה
          אינו משמש כסכום לחיוב.
        </p>
        <p>
          <Review>
            האם ייעשה שימוש בכלי מדידה, אנליטיקה או פרסום. כיום אין באתר עוגיות כאלה, ואם ייווספו
            — יידרשו גילוי ומנגנון הסכמה
          </Review>
        </p>
      </Clause>

      <Clause heading="העברת מידע לצדדים שלישיים">
        <p>
          המידע נמסר לספקים שמספקים לפאצ׳קה שירות תשתית — אחסון בסיס הנתונים, אחסון קבצי התמונות,
          שירות האימות, שליחת דואר אלקטרוני, וספק ניתוח התמונות שתואר לעיל — ולגורמים שהדין מחייב
          למסור להם. המידע אינו נמכר.
        </p>
        <p>
          <Review>
            רשימת הספקים בשמם, מיקום שרתיהם, והאם מבוצעת העברת מידע אל מחוץ לישראל — ואם כן, על
            איזה בסיס
          </Review>
        </p>
      </Clause>

      <Clause heading="כמה זמן המידע נשמר">
        <p>
          <Review by="operator">
            תקופות השמירה טרם נקבעו. יש לקבוע לכל סוג מידע — חשבון שנסגר, הזמנה שהושלמה, רשומות
            שהדין מחייב לשמור לצורכי הנהלת חשבונות, תשובות שאלון, וכתובת שנמסרה לצורך עדכון —
            כמה זמן הוא נשמר ומה נעשה בו אחר כך
          </Review>
        </p>
        <p>
          יובהר שתעודות מקוריות שהונפקו אינן ניתנות לשינוי מעצם טיבן, ורשומות שינוי מצב של הזמנה
          ויומן פעולות מנהלים נשמרים בדרך של הוספה בלבד ואינם נמחקים בדיעבד.{" "}
          <Review>
            המתח בין רשומות שאינן ניתנות לשינוי לבין בקשת מחיקה של מידע אישי, וכיצד מיושבת בקשה
            כזו
          </Review>
        </p>
      </Clause>

      <Clause heading="הזכויות שלכם">
        <p>
          לפי חוק הגנת הפרטיות עומדת לכם הזכות לעיין במידע שמוחזק עליכם ולבקש את תיקונו אם אינו
          נכון, שלם, ברור או מעודכן. ניתן גם לעדכן בעצמכם את פרטי החשבון והפרופיל דרך האתר, ולבקש
          הסרה מרשימת העדכונים.
        </p>
        <p>
          פנייה בעניין זה תופנה לכתובת שבראש עמוד זה.{" "}
          <Review>נוסח הזכויות, לוחות הזמנים למענה, ודרך אימות זהות הפונה</Review>
        </p>
      </Clause>

      <Clause heading="אבטחה">
        <p>
          הגישה למידע מוגבלת ברמת בסיס הנתונים עצמו ולא רק ברמת היישום, וכל טבלה נושאת מדיניות
          הרשאות משלה. פרטי ההתקשרות ופרטי הבנק של אמנים מוחזקים בטבלאות נפרדות שאין להן הרשאה
          כלשהי למפתח הציבורי שנשלח לדפדפן, כך שהם אינם נגישים גם למי שפונה ישירות לממשק הנתונים.
        </p>
        <p>
          אף שיטה אינה בטוחה לחלוטין.{" "}
          <Review>נוהל טיפול ודיווח באירוע אבטחת מידע, לרבות דיווח לרשות ולנפגעים</Review>
        </p>
      </Clause>

      <Clause heading="שינויים במדיניות">
        <p>
          מדיניות זו עשויה להתעדכן.{" "}
          <Review>אופן מתן ההודעה על עדכון מהותי</Review>
        </p>
        <p>
          עודכן לאחרונה: <Review by="operator">תאריך אישור הנוסח</Review>
        </p>
      </Clause>
    </LegalDocument>
  );
}
