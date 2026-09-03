/**
 * The boundaries this module is not allowed to be sure about.
 *
 * ARCHITECTURE.md's test policy permits a deterministic fake for "AI providers,
 * email, and payment... *external boundaries only* — never for PACHKA's own
 * logic". This file is the complete list of what that means here, and it is one
 * item long: mail.
 *
 * THERE IS NO AI PORT HERE, AND THAT IS THE POINT
 * ----------------------------------------------
 * `uploads` declares an `Embedder` and a `VisionAnalyst` because it calls them,
 * once per artwork, at upload. This module declares neither, because it must
 * never call one: "No outbound AI call at query time. Embeddings are computed at
 * upload and stored. If a matchmaker code path can reach an AI provider, it is
 * wrong" (ARCHITECTURE.md). A module cannot accidentally call a provider it was
 * never handed, so the absence of a port here is a structural control rather
 * than a note. If a future change needs one, it has to add it to this file
 * first, in a diff a reviewer sees.
 */

/** One message, already composed. Addresses are set by the caller, never by a user. */
export interface OutboundEmail {
  readonly to: string;
  readonly subject: string;
  readonly body: string;
}

/**
 * Somewhere to hand a message. A real provider in production.
 *
 * SECURITY.md S2-21 item 5: all platform mail uses a fixed platform `From` and
 * `Reply-To`, and "no user-supplied value ever populates any address header".
 * This port therefore takes only a recipient — there is nowhere on it to put a
 * user-supplied sender, which is the kind of impossibility worth designing for.
 */
export interface Mailer {
  send(message: OutboundEmail): Promise<void>;
}

/**
 * A mailer that refuses to send.
 *
 * The honest default for a deployment where mail is not wired yet: notify-me
 * still stores the subscription, and the confirmation is recorded as not sent
 * rather than pretended. Double opt-in means an unconfirmed subscription
 * receives nothing anyway, so an unwired mailer costs a buyer a confirmation
 * email and costs nobody a leak.
 */
export const noMailer: Mailer = {
  async send() {
    throw new Error("matchmaker: no Mailer is wired; nothing was sent");
  },
};
