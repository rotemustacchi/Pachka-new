/**
 * The mail transport, without a network.
 *
 * ARCHITECTURE.md's test policy permits a deterministic fake for "AI providers,
 * email, and payment ... *external boundaries only*". The provider's HTTP
 * endpoint is that boundary and it is the only thing faked here: `fetch` is
 * injected, and every assertion below is about what the adapter DID — the
 * request it built, the message the logging adapter kept, the error a caller
 * received — never about whether a function object was invoked.
 *
 * No test in this file can reach the network. `createResendMailer` takes its
 * `fetch`, and `createMailer` is only ever called with an explicit `env`, so a
 * machine with `RESEND_API_KEY` exported in its shell runs the same tests as a
 * machine without one.
 */
import { describe, expect, it } from "vitest";
import {
  composeNotification,
  createLoggingMailer,
  createMailer,
  createResendMailer,
  deliverQuietly,
  dispatchNotifications,
  escapeHtml,
  hebrewHtmlBody,
  redactAddress,
  RESEND_ENDPOINT,
  type AddressBook,
  type FetchLike,
  type MailMessage,
} from "@/shared/mail";
import { isAppError } from "@/shared/errors";

// ---------------------------------------------------------------------------
// The one fake: the provider's HTTP endpoint.
// ---------------------------------------------------------------------------

interface CapturedRequest {
  readonly url: string;
  readonly headers: Record<string, string>;
  readonly body: Record<string, unknown>;
}

/** Records what was posted and answers with whatever the test asked for. */
function fakeEndpoint(reply: { status: number; body?: string } = { status: 200, body: "{}" }) {
  const requests: CapturedRequest[] = [];
  const fetch: FetchLike = async (url, init) => {
    requests.push({
      url,
      headers: init.headers,
      body: JSON.parse(init.body) as Record<string, unknown>,
    });
    return {
      ok: reply.status >= 200 && reply.status < 300,
      status: reply.status,
      text: async () => reply.body ?? "",
    };
  };
  return { requests, fetch };
}

/** A boundary that is down. */
const unreachable: FetchLike = async () => {
  throw new TypeError("fetch failed");
};

/** Collects log lines instead of printing them. */
function fakeLog() {
  const warns: string[] = [];
  const infos: string[] = [];
  const errors: unknown[][] = [];
  return {
    warns,
    infos,
    errors,
    warn: (line: string) => void warns.push(line),
    info: (line: string) => void infos.push(line),
    error: (...args: unknown[]) => void errors.push(args),
  };
}

const MESSAGE: MailMessage = {
  to: "dana@example.com",
  subject: "אישור הרשמה לעדכונים מפצ׳קה",
  body: "קיבלנו בקשה לעדכן אתכם.\nלאישור: https://pachka.test/confirm/abc",
};

// ---------------------------------------------------------------------------
// Choosing an adapter
// ---------------------------------------------------------------------------

describe("choosing a transport from the environment", () => {
  it("selects the logging adapter when no API key is configured, rather than crashing", () => {
    const transport = createMailer({ env: {}, fetch: unreachable as never, log: fakeLog() });

    expect(transport.state().kind).toBe("logging");
    expect(transport.state().configured).toBe(false);
    expect(transport.state().reason).toContain("RESEND_API_KEY");
  });

  it("does not send anything when it is unconfigured, so a missing key cannot fail a checkout", async () => {
    const log = fakeLog();
    // A boundary that throws on contact: if the logging adapter reached the
    // network at all, this send would reject and the assertion below would fail.
    const transport = createMailer({ env: {}, fetch: unreachable as never, log });

    await expect(transport.send(MESSAGE)).resolves.toBeUndefined();
    expect(log.warns[0]).toContain("NOT CONFIGURED");
  });

  it("refuses to send with a key and no sender, because a From is not optional", () => {
    const state = createMailer({ env: { RESEND_API_KEY: "re_x" }, log: fakeLog() }).state();

    expect(state.kind).toBe("logging");
    expect(state.reason).toContain("MAIL_FROM is unset");
  });

  it("treats a sender that is not an address as unconfigured, and does not echo it", () => {
    const state = createMailer({
      env: { RESEND_API_KEY: "re_x", MAIL_FROM: "hello@localhost" },
      log: fakeLog(),
    }).state();

    expect(state.kind).toBe("logging");
    expect(state.reason).toBe("MAIL_FROM is not a valid address.");
    expect(state.reason).not.toContain("hello@localhost");
  });

  it("selects the real provider once both variables are set", () => {
    const state = createMailer({
      env: { RESEND_API_KEY: "re_x", MAIL_FROM: "PACHKA <hello@pachka.co.il>" },
      log: fakeLog(),
    }).state();

    expect(state.kind).toBe("resend");
    expect(state.configured).toBe(true);
    expect(state.from).toBe("PACHKA <hello@pachka.co.il>");
    expect(state.reason).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// The logging adapter
// ---------------------------------------------------------------------------

describe("the logging adapter", () => {
  it("keeps the whole message so a developer can read what would have been sent", async () => {
    const mailer = createLoggingMailer({ reason: "no key", log: fakeLog() });

    await mailer.send(MESSAGE);

    expect(mailer.records).toHaveLength(1);
    expect(mailer.records[0]!.to).toBe("dana@example.com");
    expect(mailer.records[0]!.subject).toBe(MESSAGE.subject);
    expect(mailer.records[0]!.body).toContain("https://pachka.test/confirm/abc");
  });

  it("warns once and not once per message, so the warning is still visible on day two", async () => {
    const log = fakeLog();
    const mailer = createLoggingMailer({ reason: "no key", log });

    await mailer.send(MESSAGE);
    await mailer.send(MESSAGE);
    await mailer.send(MESSAGE);

    expect(log.warns).toHaveLength(1);
    expect(log.infos).toHaveLength(3);
  });

  it("does not write a whole address to the log, because a log is not a place for one", async () => {
    const log = fakeLog();
    const mailer = createLoggingMailer({ reason: "no key", log });

    await mailer.send(MESSAGE);

    expect(log.infos[0]).not.toContain("dana@example.com");
    expect(log.infos[0]).toContain("d***@example.com");
    expect(redactAddress("dana@example.com")).toBe("d***@example.com");
  });

  it("forgets the oldest message rather than growing without bound", async () => {
    const mailer = createLoggingMailer({ reason: "no key", log: fakeLog(), limit: 2 });

    for (const subject of ["one", "two", "three"]) {
      await mailer.send({ ...MESSAGE, subject });
    }

    expect(mailer.records.map((record) => record.subject)).toEqual(["two", "three"]);
  });
});

// ---------------------------------------------------------------------------
// The Resend adapter
// ---------------------------------------------------------------------------

describe("the Resend adapter", () => {
  it("posts the message the provider expects, with the platform sender", async () => {
    const endpoint = fakeEndpoint();
    const mailer = createResendMailer({
      apiKey: "re_secret",
      from: "PACHKA <hello@pachka.co.il>",
      fetch: endpoint.fetch,
    });

    await mailer.send(MESSAGE);

    expect(endpoint.requests).toHaveLength(1);
    const sent = endpoint.requests[0]!;
    expect(sent.url).toBe(RESEND_ENDPOINT);
    expect(sent.headers.authorization).toBe("Bearer re_secret");
    expect(sent.body.from).toBe("PACHKA <hello@pachka.co.il>");
    expect(sent.body.to).toEqual(["dana@example.com"]);
    expect(sent.body.subject).toBe(MESSAGE.subject);
    expect(sent.body.text).toBe(MESSAGE.body);
  });

  it("sends an HTML part that is the same words, right to left", async () => {
    const endpoint = fakeEndpoint();
    const mailer = createResendMailer({
      apiKey: "re_secret",
      from: "hello@pachka.co.il",
      fetch: endpoint.fetch,
    });

    await mailer.send(MESSAGE);

    const html = endpoint.requests[0]!.body.html as string;
    expect(html).toContain('dir="rtl"');
    expect(html).toContain('lang="he"');
    expect(html).toContain("קיבלנו בקשה לעדכן אתכם.");
    expect(html).toContain("https://pachka.test/confirm/abc");
  });

  it("reports a 429 as retryable and everything else as an outage", async () => {
    const limited = createResendMailer({
      apiKey: "re_secret",
      from: "hello@pachka.co.il",
      fetch: fakeEndpoint({ status: 429, body: '{"name":"rate_limit_exceeded"}' }).fetch,
    });
    const refused = createResendMailer({
      apiKey: "re_secret",
      from: "hello@pachka.co.il",
      fetch: fakeEndpoint({ status: 422, body: '{"name":"validation_error"}' }).fetch,
    });

    await expect(limited.send(MESSAGE)).rejects.toMatchObject({ kind: "rate_limited" });
    await expect(refused.send(MESSAGE)).rejects.toMatchObject({ kind: "external_failure" });
  });

  it("never repeats the provider's prose, because a failure is stored in a database column", async () => {
    // Resend quotes the offending field back. `moderation` writes a delivery
    // failure to `reports.notification_error`, so anything that travels out of
    // here travels into a table.
    const mailer = createResendMailer({
      apiKey: "re_secret",
      from: "hello@pachka.co.il",
      fetch: fakeEndpoint({
        status: 422,
        body: '{"name":"validation_error","message":"Invalid `to` field: dana@example.com"}',
      }).fetch,
    });

    const error = await mailer.send(MESSAGE).catch((cause: unknown) => cause);

    expect(isAppError(error)).toBe(true);
    expect((error as Error).message).not.toContain("dana@example.com");
    expect((error as Error).message).toContain("validation_error");
  });

  it("reports an unreachable provider as an outage rather than leaking the transport error", async () => {
    const mailer = createResendMailer({
      apiKey: "re_secret",
      from: "hello@pachka.co.il",
      fetch: unreachable,
    });

    const error = await mailer.send(MESSAGE).catch((cause: unknown) => cause);

    expect(isAppError(error)).toBe(true);
    expect((error as { kind: string }).kind).toBe("external_failure");
    expect((error as { code: string }).code).toBe("mail.provider_unreachable");
  });
});

// ---------------------------------------------------------------------------
// Delivery must not break the operation that triggered it
// ---------------------------------------------------------------------------

describe("deliverQuietly", () => {
  it("turns a rejection into a reported outcome, so a caller carries on", async () => {
    const mailer = createResendMailer({
      apiKey: "re_secret",
      from: "hello@pachka.co.il",
      fetch: fakeEndpoint({ status: 500, body: '{"name":"internal_error"}' }).fetch,
    });
    const log = fakeLog();

    const outcome = await deliverQuietly(mailer, MESSAGE, log);

    expect(outcome.sent).toBe(false);
    expect(outcome.error).toContain("500");
    expect(log.errors).toHaveLength(1);
  });

  it("reports success without an error when the provider accepts", async () => {
    const mailer = createResendMailer({
      apiKey: "re_secret",
      from: "hello@pachka.co.il",
      fetch: fakeEndpoint().fetch,
    });

    expect(await deliverQuietly(mailer, MESSAGE, fakeLog())).toEqual({ sent: true, error: null });
  });

  it("keeps a failure short enough for reports.notification_error", async () => {
    const mailer = createResendMailer({
      apiKey: "re_secret",
      from: "hello@pachka.co.il",
      fetch: fakeEndpoint({ status: 503, body: '{"name":"service_unavailable"}' }).fetch,
    });

    const outcome = await deliverQuietly(mailer, MESSAGE, fakeLog());

    expect(outcome.error!.length).toBeLessThanOrEqual(500);
  });
});

// ---------------------------------------------------------------------------
// Hebrew, right to left
// ---------------------------------------------------------------------------

describe("the Hebrew body", () => {
  it("states the direction rather than leaving the client to guess it", () => {
    const html = hebrewHtmlBody("שלום");

    expect(html).toContain('dir="rtl"');
    expect(html).toContain("direction:rtl");
    expect(html).toContain("text-align:right");
  });

  it("keeps two lines of one thought together and separates two thoughts", () => {
    const html = hebrewHtmlBody("שורה ראשונה\nשורה שנייה\n\nפסקה שנייה");

    expect(html).toContain("שורה ראשונה<br>שורה שנייה");
    expect((html.match(/<p /g) ?? [])).toHaveLength(2);
  });

  it("escapes what a buyer typed, so a note cannot become markup", () => {
    const html = hebrewHtmlBody('<script>alert("x")</script>');

    expect(html).not.toContain("<script>");
    expect(html).toContain("&lt;script&gt;");
    expect(escapeHtml(`a & b < c > d " e ' f`)).toBe(
      "a &amp; b &lt; c &gt; d &quot; e &#39; f",
    );
  });
});

// ---------------------------------------------------------------------------
// The descriptor family
// ---------------------------------------------------------------------------

describe("composing a notification descriptor", () => {
  const SITE = "https://pachka.test";

  it("carries the payment instructions and the total a buyer must act on", () => {
    const { subject, body } = composeNotification(
      {
        audience: "buyer",
        template: "orders.order_placed",
        recipientId: "buyer-1",
        data: {
          orderId: "ord-77",
          subtotalAgorot: 125_000,
          shippingAgorot: 3_500,
          totalAgorot: 128_500,
          currency: "ILS",
          parcelCount: 2,
          instructions: "העברה בנקאית לחשבון 12-345-678900",
        },
      },
      SITE,
    );

    expect(subject).toContain("הוראות תשלום");
    expect(body).toContain("העברה בנקאית לחשבון 12-345-678900");
    expect(body).toContain("₪1,285.00");
    expect(body).toContain("ord-77");
    expect(body).toContain("מספר חבילות: 2");
    expect(body).toContain(`${SITE}/orders/ord-77`);
  });

  it("gives an artist the settlement reference and no bank identifier at all", () => {
    // SECURITY.md S1-11 item 3: the settlement notification "does not contain
    // the account number, branch, or bank". `payouts` guarantees that by having
    // no parameter one could travel in; this checks the mail layer does not
    // reintroduce one.
    const { body } = composeNotification(
      {
        audience: "artist",
        template: "payouts.payout_settled",
        recipientId: "artist-1",
        data: {
          ledgerEntryId: "led-9",
          netAgorot: 90_000,
          netFormatted: "₪900.00",
          settledOn: "2026-09-01",
          bankReference: "TRF-4411",
        },
      },
      SITE,
    );

    expect(body).toContain("TRF-4411");
    expect(body).toContain("₪900.00");
    expect(body).not.toMatch(/\b\d{6,}\b/);
  });

  it("links a certificate by its identifier, which is the only thing the module sent", () => {
    const { body, subject } = composeNotification(
      {
        audience: "buyer",
        template: "certificates.issued",
        recipientId: "buyer-1",
        data: { orderId: "ord-1", fulfilmentId: "ful-1", identifiers: ["PCH-2026-000123"] },
      },
      SITE,
    );

    expect(subject).toContain("תעודת המקוריות");
    expect(body).toContain(`${SITE}/certificates/PCH-2026-000123`);
  });

  it("confirms a notify-me subscription with the copy `matchmaker` used to send", () => {
    // The words moved out of `matchmaker/notify.ts` and into the template table
    // when the module stopped sending. They did not change on the way, and the
    // module never sees them, so this is where they are checked.
    const token = "a".repeat(64);
    const { subject, body } = composeNotification(
      {
        audience: "subscriber",
        template: "matchmaker.notify_confirmation",
        recipientId: "sub-1",
        data: { confirmationToken: token },
      },
      SITE,
    );

    expect(subject).toBe("אישור הרשמה לעדכונים מפצ׳קה");
    expect(body).toContain("קיבלנו בקשה לעדכן אתכם כשיגיעו עבודות שמתאימות לתשובות שלכם.");
    expect(body).toContain(`לאישור: ${SITE}/match/notify/confirm/${token}`);
    expect(body).toContain("אם זה לא אתם, אפשר להתעלם מההודעה ולא יישלח אליכם דבר נוסף.");
  });

  it("prints the confirmation token only inside the link it authorises", () => {
    // The token is a credential. It travels in `data` because the URL is the
    // root's to build, and a labelled `confirmationToken: <hex>` line would put
    // it in the message a second time, outside the link.
    const token = "b".repeat(64);
    const { body } = composeNotification(
      {
        audience: "subscriber",
        template: "matchmaker.notify_confirmation",
        recipientId: "sub-1",
        data: { confirmationToken: token },
      },
      SITE,
    );

    expect(body).not.toContain(`confirmationToken: ${token}`);
    expect(body.split(token)).toHaveLength(2);
  });

  it("alerts the operator with the copy `moderation` used to send, and names the subject", () => {
    const { subject, body } = composeNotification(
      {
        audience: "admin",
        template: "moderation.report_filed",
        data: {
          reportId: "rep-1",
          subjectType: "artwork",
          subjectId: "art-9",
          reason: "undeclared_ai",
          reasonLabel: "Undeclared AI generation",
          details: "The brushwork is generated.",
        },
      },
      SITE,
    );

    expect(subject).toBe("New PACHKA report: artwork art-9");
    expect(body).toContain("A new report has been filed against artwork art-9.");
    expect(body).toContain("Reason: Undeclared AI generation");
    expect(body).toContain("Details: The brushwork is generated.");
    expect(body).toContain(`Queue item: ${SITE}/admin/queue/artwork/art-9`);
    // The reporter picked from a labelled set; the operator reads the label.
    expect(body).not.toContain("undeclared_ai");
  });

  it("omits the details line from an operator alert that has none", () => {
    const { body } = composeNotification(
      {
        audience: "admin",
        template: "moderation.report_filed",
        data: {
          reportId: "rep-2",
          subjectType: "artist",
          subjectId: "usr-3",
          reason: "other",
          reasonLabel: "Something else",
        },
      },
      SITE,
    );

    expect(body).not.toContain("Details:");
    expect(body).toContain(`Queue item: ${SITE}/admin/queue/artist/usr-3`);
  });

  it("tells an artist their listing came down, titled or not, with no link at all", () => {
    const titled = composeNotification(
      {
        audience: "artist",
        template: "moderation.artwork_taken_down",
        recipientId: "artist-1",
        data: {
          artworkId: "art-4",
          artworkTitle: "Quiet Harbour",
          reason: "undeclared_ai",
          reasonLabel: "Undeclared AI generation",
        },
      },
      SITE,
    );

    expect(titled.subject).toBe("Your PACHKA listing has been removed");
    expect(titled.body).toContain('Your listing "Quiet Harbour" has been removed from PACHKA.');
    expect(titled.body).toContain("Reason: Undeclared AI generation");
    expect(titled.body).toContain("A removed listing cannot be republished.");
    expect(titled.body).not.toContain("undeclared_ai");
    // Nothing to link to: a removed listing has no page, and the artist is
    // asked to reply rather than to follow a URL.
    expect(titled.body).not.toContain(SITE);

    const untitled = composeNotification(
      {
        audience: "artist",
        template: "moderation.artwork_taken_down",
        recipientId: "artist-1",
        data: { artworkId: "art-5", artworkTitle: "", reason: "free text", reasonLabel: "free text" },
      },
      SITE,
    );

    expect(untitled.body).toContain("Your listing has been removed from PACHKA.");
    expect(untitled.body).toContain("Reason: free text");
  });

  it("still says something when a template has no wording yet, and names itself", () => {
    const { subject, body } = composeNotification(
      { audience: "buyer", template: "returns.never_arrived", data: { orderId: "ord-3" } },
      SITE,
    );

    expect(subject).toBe("הודעה מפצ׳קה");
    expect(body).toContain("returns.never_arrived");
    expect(body).toContain("ord-3");
  });
});

describe("dispatching descriptors", () => {
  const addresses: AddressBook = {
    async addressFor(audience, recipientId) {
      if (audience === "admin") return { address: "operator@pachka.test" };
      return recipientId === "known" ? { address: "known@example.com" } : { address: null };
    },
  };

  it("delivers each descriptor and reports what happened to it", async () => {
    const endpoint = fakeEndpoint();
    const mailer = createResendMailer({
      apiKey: "re_x",
      from: "hello@pachka.co.il",
      fetch: endpoint.fetch,
    });

    const outcomes = await dispatchNotifications(
      mailer,
      { addresses, siteUrl: "https://pachka.test" },
      [
        {
          audience: "buyer",
          template: "orders.order_placed",
          recipientId: "known",
          data: { orderId: "ord-1", totalAgorot: 1000, instructions: "העברה בנקאית" },
        },
        {
          audience: "admin",
          template: "orders.operator_payment_pending",
          data: { orderId: "ord-1", totalAgorot: 1000 },
        },
      ],
    );

    expect(outcomes.map((outcome) => outcome.sent)).toEqual([true, true]);
    expect(endpoint.requests.map((request) => request.body.to)).toEqual([
      ["known@example.com"],
      ["operator@pachka.test"],
    ]);
  });

  it("records a recipient with no address on file instead of raising", async () => {
    const endpoint = fakeEndpoint();
    const mailer = createResendMailer({
      apiKey: "re_x",
      from: "hello@pachka.co.il",
      fetch: endpoint.fetch,
    });

    const outcomes = await dispatchNotifications(
      mailer,
      { addresses, siteUrl: "https://pachka.test" },
      [
        {
          audience: "artist",
          template: "orders.artist_dispatch_requested",
          recipientId: "stranger",
          data: { orderId: "ord-1" },
        },
      ],
    );

    expect(outcomes).toEqual([
      {
        audience: "artist",
        template: "orders.artist_dispatch_requested",
        sent: false,
        error: "No address on file for this recipient",
      },
    ]);
    expect(endpoint.requests).toEqual([]);
  });

  it("carries on through a failure, so one dead message does not stop the rest", async () => {
    let calls = 0;
    const fetch: FetchLike = async () => {
      calls += 1;
      return calls === 1
        ? { ok: false, status: 500, text: async () => '{"name":"internal_error"}' }
        : { ok: true, status: 200, text: async () => "{}" };
    };
    const mailer = createResendMailer({ apiKey: "re_x", from: "hello@pachka.co.il", fetch });

    const outcomes = await dispatchNotifications(
      mailer,
      { addresses, siteUrl: "https://pachka.test" },
      [
        { audience: "buyer", template: "orders.order_delivered", recipientId: "known", data: {} },
        { audience: "admin", template: "orders.operator_payment_pending", data: {} },
      ],
    );

    expect(outcomes.map((outcome) => outcome.sent)).toEqual([false, true]);
  });
});
