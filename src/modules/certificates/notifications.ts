/**
 * "Your certificate is ready" — returned, never sent.
 *
 * `authenticity-certificate`: the certificate is made "available to the buyer
 * from their order view and by emailed link."
 *
 * Nothing here sends anything. The function returns `NotificationRequest[]` and
 * the composition root dispatches them AFTER the issuing transaction has
 * committed. The shape is `orders.NotificationRequest` deliberately — that
 * module says why, and the reason applies verbatim: "the composition root
 * dispatches both through one mail layer, and two shapes would mean two
 * dispatchers." It also keeps mail outside this module entirely, so the tests
 * assert what the message SAYS rather than that a mailer object was called.
 *
 * WHAT THE MESSAGE CARRIES, AND WHAT IT MUST NOT
 * ----------------------------------------------
 * Identifiers and nothing else. No buyer name — the mail layer resolves the
 * address it is sending to from `recipientId`, the arrangement `orders` uses so
 * that no template holds personal data. No artist contact details. And no
 * assembled URL: the verification base URL is the app's to know, so the
 * identifier travels and the mail layer builds the link. A template that
 * received a finished URL would be a template that could be pointed somewhere
 * else by whatever built it.
 *
 * The link in that email resolves to the PUBLIC page, which carries no buyer
 * name. The buyer's own copy lives behind their signed-in order view. That
 * split is SPEC-B, and it is why an emailed link is safe to forward.
 */

/** Every template this module emits. */
export const CERTIFICATE_TEMPLATES = {
  certificateIssued: "certificates.issued",
} as const;

export type CertificateTemplate =
  (typeof CERTIFICATE_TEMPLATES)[keyof typeof CERTIFICATE_TEMPLATES];

/**
 * Structurally identical to `orders.NotificationRequest`. Declared rather than
 * imported so that a change to this module's messages cannot be made by editing
 * another module's file.
 */
export interface NotificationRequest {
  readonly audience: "buyer" | "artist" | "admin";
  readonly template: string;
  readonly recipientId?: string;
  readonly data: Readonly<Record<string, unknown>>;
}

/**
 * One message per delivery, listing every certificate that delivery produced.
 *
 * Not one message per certificate: an order of two pieces from one artist
 * arrives in one parcel, and two emails about one parcel is how a marketplace
 * teaches people to ignore its mail.
 *
 * Returns nothing at all when nothing was issued — a repeat call after a retry
 * must not re-notify. `issuedCount` from `issueCertificatesForFulfilment` is
 * what distinguishes the two cases, and the caller passes only the newly issued
 * identifiers here.
 */
export function certificateIssuedNotifications(input: {
  readonly buyerId: string;
  readonly orderId: string;
  readonly fulfilmentId: string;
  readonly identifiers: readonly string[];
}): NotificationRequest[] {
  if (input.identifiers.length === 0) return [];

  return [
    {
      audience: "buyer",
      template: CERTIFICATE_TEMPLATES.certificateIssued,
      recipientId: input.buyerId,
      data: {
        orderId: input.orderId,
        fulfilmentId: input.fulfilmentId,
        identifiers: [...input.identifiers],
      },
    },
  ];
}
