/**
 * `certificates` — the Certificate of Authenticity: what it says, who may read
 * it, and what stops it becoming a public register of who bought what.
 *
 * This file is the module's entire surface. ARCHITECTURE.md: nothing outside a
 * module may import a deeper path than its `index.ts`.
 *
 * WHAT THE DOCUMENT ASSERTS — THE ONE THING TO GET RIGHT
 * -----------------------------------------------------
 * PACHKA has never seen the object. The certificate records THE ARTIST'S OWN
 * DECLARATION and says so on its face, in the document body, at body size,
 * every time. Where the artist declared generative AI assistance it says that
 * too. `declaration.ts` holds the wording and the reasoning; treat it as a
 * liability boundary rather than a disclaimer, because a certificate of
 * authenticity issued by a party in no position to verify authenticity, with no
 * statement of its own limits, is a misrepresentation with the platform's name
 * on it.
 *
 * THE PRIVACY RULE THAT CHANGED, AND HOW IT IS ENFORCED
 * ----------------------------------------------------
 * The spec originally put the buyer's name on a publicly-resolvable page. That
 * publishes a purchase record naming a private individual; the security review
 * caught it (SECURITY.md S0-6, SPEC-B) and the spec was rewritten. The buyer's
 * name now appears only on the copy delivered privately to the buyer.
 *
 * That is enforced four times over, and none of the four is "remember not to":
 *
 *   1. There is no buyer-name column. The name is read at render time through
 *      `orders.buyerOrder()`, which scopes by buyer in its own WHERE clause.
 *   2. `PublicCertificate` has no field that could carry a buyer detail — not a
 *      name, not an order id, not an account id.
 *   3. `CertificateDocument` accepts a `PublicCertificate` and nothing else, so
 *      no composition of it can render a name.
 *   4. `certificates` has no `anon` grant and no `anon` policy, so the data API
 *      cannot reach the table at all. The public page is a server route.
 *
 * FOR THE COMPOSITION ROOT — THE WIRING THIS MODULE NEEDS AND DOES NOT OWN
 * -----------------------------------------------------------------------
 * `orders` cannot call this module: ARCHITECTURE.md's dependency table points
 * `certificates` at `orders`, not the reverse. So delivery does not issue
 * certificates by itself. `app/` calls `orders.confirmDelivery()` and then
 * `issueCertificatesForFulfilment()`, dispatching the returned notifications
 * after the transaction commits.
 *
 * A missed hook is survivable: issuance is idempotent, and `orderCertificates()`
 * issues anything a delivered fulfilment is owed when the buyer next opens the
 * order. The hook is an optimisation over that self-heal, not the only path.
 *
 * `buyerNames` must be wired with `buyerNamesFromOrders(ordersDeps)` for the
 * private copy to render; unwired it raises rather than rendering a document
 * with mandatory content missing.
 */

// ---- What this module is handed, and the two ports it declares.
export {
  artistNameSourceFor,
  sqlArtistNames,
  verificationLimitFor,
  DEFAULT_VERIFICATION_RATE_LIMIT,
  type ArtistNameSource,
  type BuyerNameSource,
  type CertificatesDeps,
  type VerificationRateLimit,
} from "./deps";

// ---- The domain types.
//
// `CertificateRecord` is deliberately NOT exported. It carries `buyerId`, and a
// shape linking a person to a purchase has no business outside this module.
export {
  toPublicCertificate,
  CERTIFICATE_VALIDITIES,
  type BuyerCertificate,
  type CertificateValidity,
  type EditionPosition,
  type PublicCertificate,
} from "./types";

// ---- The wording. Exported so the tests and any future document renderer
// assert against one definition rather than a copy of the prose.
export {
  declarationStatements,
  editionStatement,
  AI_ASSISTANCE_STATEMENT,
  ARTIST_DECLARATION_HEADING,
  ARTIST_DECLARATION_STATEMENT,
  CERTIFICATE_TITLE,
  DECLARATION_VERSION,
  UNIQUE_WORK_STATEMENT,
  VALID_STATEMENT,
  VOID_STATEMENT,
} from "./declaration";

// ---- The identifier: minted, validated, and the one refusal.
export {
  certificateNotFound,
  isCertificateIdentifier,
  newCertificateIdentifier,
  parseCertificateIdentifier,
  CERTIFICATE_NOT_FOUND_MESSAGE,
} from "./identifier";

// ---- Issuance. Called after `orders.confirmDelivery()`; idempotent.
export {
  certificatesForFulfilment,
  issueCertificatesForFulfilment,
  withheldReason,
  type IssueCertificatesResult,
  type WithheldReason,
} from "./issue";

// ---- The public verification path. The ONLY way a certificate reaches an
// anonymous reader, and it returns a projection with no buyer field.
export {
  deriveValidity,
  verifyCertificate,
  type VerifyCertificateRequest,
} from "./verify";

// ---- The buyer's own copy and their order view.
export {
  buyerCertificate,
  buyerNamesFromOrders,
  certificatesForOrder,
  orderCertificates,
  type OrderCertificateEntry,
} from "./buyer";

// ---- The rate limit on the verification endpoint (SECURITY.md S0-6 item 5).
export { consumeVerificationAttempt, hashVerificationSubject, pruneVerificationEvents } from "./rate-limit";

// ---- What needs telling. Returned, never sent from inside a transaction.
export {
  certificateIssuedNotifications,
  CERTIFICATE_TEMPLATES,
  type CertificateTemplate,
  type NotificationRequest,
} from "./notifications";

// ---- The document, the public page, and the buyer's copy.
//
// `PublicVerificationPage` is the page, not a view of it: it fetches and
// renders as one unit, so the integration test executes what the visitor
// receives. See the file's own header for why the fetch is not in `app/`.
export {
  CertificateDocument,
  type CertificateDocumentProps,
} from "./ui/CertificateDocument";
export {
  PublicVerificationPage,
  type PublicVerificationPageProps,
} from "./ui/PublicVerificationPage";
export {
  BuyerCertificateDocument,
  type BuyerCertificateDocumentProps,
} from "./ui/BuyerCertificateDocument";
