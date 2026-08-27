/**
 * Returns, end to end, against the real database.
 *
 * Two decisions are what these tests defend.
 *
 * The buyer cannot be told the artist's address, so the parcel comes to PACHKA
 * and an operator forwards it (SECURITY.md SPEC-A). Several tests here seed a
 * real artist contact row with sentinel values and assert that none of it
 * reaches the buyer's instructions or the return record.
 *
 * The refund is released by that operator, not by the artist (SECURITY.md
 * SPEC-E). PACHKA holds the buyer's money, so the party who loses money by
 * refunding must not be the only party able to release it, and silence must
 * never work in their favour.
 */
import { describe, expect, it } from "vitest";
import { asUser, useTestDatabase } from "../harness";
import { setConfig } from "@/shared/config";
import type { Database } from "@/shared/db";
import {
  escalateSilentArtists,
  flagUnreceivedReturns,
  forwardToArtist,
  isArtworkHeldByOpenReturn,
  readReturn,
  recordArtistResponse,
  recordOperatorReceipt,
  requestReturn,
  resolveReturnByAdmin,
  returnTerms,
  type PostalAddress,
} from "@/modules/shipping";

const DELIVERED_AT = new Date("2026-03-01T09:00:00Z");
const DAY_10 = new Date("2026-03-11T09:00:00Z");
const DAY_20 = new Date("2026-03-21T09:00:00Z");

const uuid = (): string => crypto.randomUUID();

const ARTIST_SECRETS = {
  email: "noa@example.com",
  phone: "0501112222",
  streetAddress: "רחוב הפרח 12, חיפה",
  postalCode: "3100000",
} as const;

const ARTIST_ADDRESS: PostalAddress = {
  recipient: "Noa B.",
  line1: ARTIST_SECRETS.streetAddress,
  city: "חיפה",
  postalCode: ARTIST_SECRETS.postalCode,
  countryCode: "IL",
};

async function seedAccount(db: Database, name: string, role: string): Promise<string> {
  const { rows } = await db.query<{ user_id: string }>(
    "insert into profiles (user_id, display_name) values (gen_random_uuid(), $1) returning user_id",
    [name],
  );
  const id = rows[0]!.user_id;
  await db.query("insert into user_roles (user_id, role) values ($1, $2)", [id, role]);
  return id;
}

interface Parties {
  readonly buyerId: string;
  readonly artistId: string;
  readonly operatorId: string;
  readonly artworkId: string;
  readonly orderId: string;
  readonly fulfilmentId: string;
}

async function seedParties(db: Database): Promise<Parties> {
  const buyerId = await seedAccount(db, "Michal R.", "buyer");
  const artistId = await seedAccount(db, "Noa B.", "artist");
  const operatorId = await seedAccount(db, "PACHKA Ops", "admin");
  await db.query(
    `insert into artist_contact_details (user_id, email, phone, street_address, postal_code)
     values ($1, $2, $3, $4, $5)`,
    [
      artistId,
      ARTIST_SECRETS.email,
      ARTIST_SECRETS.phone,
      ARTIST_SECRETS.streetAddress,
      ARTIST_SECRETS.postalCode,
    ],
  );
  return {
    buyerId,
    artistId,
    operatorId,
    artworkId: uuid(),
    orderId: uuid(),
    fulfilmentId: uuid(),
  };
}

async function openReturn(
  db: Database,
  parties: Parties,
  overrides: { itemSubtotalAgorot?: number; shippingAgorot?: number; now?: Date } = {},
): Promise<string> {
  const result = await requestReturn(db, {
    orderId: parties.orderId,
    fulfilmentId: parties.fulfilmentId,
    artworkId: parties.artworkId,
    buyerId: parties.buyerId,
    artistId: parties.artistId,
    deliveredAt: DELIVERED_AT,
    itemSubtotalAgorot: overrides.itemSubtotalAgorot ?? 400_000,
    shippingAgorot: overrides.shippingAgorot ?? 5_000,
    now: overrides.now ?? DAY_10,
  });
  return result.returnCase.id;
}

describe("the fourteen-day cancellation right", () => {
  const database = useTestDatabase();

  it("accepts a request ten days after delivery and issues return instructions", async () => {
    const parties = await seedParties(database.db);

    const result = await requestReturn(database.db, {
      orderId: parties.orderId,
      fulfilmentId: parties.fulfilmentId,
      artworkId: parties.artworkId,
      buyerId: parties.buyerId,
      artistId: parties.artistId,
      deliveredAt: DELIVERED_AT,
      itemSubtotalAgorot: 400_000,
      now: DAY_10,
    });

    expect(result.returnCase.status).toBe("requested");
    expect(result.orderTransition).toBe("return_requested");
    expect(result.instructions.returnAddress.recipient).toBe("PACHKA");
  });

  it("declines a request twenty days after delivery and says the statutory window has closed", async () => {
    const parties = await seedParties(database.db);

    await expect(
      requestReturn(database.db, {
        orderId: parties.orderId,
        fulfilmentId: parties.fulfilmentId,
        artworkId: parties.artworkId,
        buyerId: parties.buyerId,
        artistId: parties.artistId,
        deliveredAt: DELIVERED_AT,
        itemSubtotalAgorot: 400_000,
        now: DAY_20,
      }),
    ).rejects.toMatchObject({
      kind: "validation",
      code: "returns.window_closed",
      message: /statutory cancellation window .* has closed/i,
    });

    const { rows } = await database.db.query<{ count: string }>(
      "select count(*)::text as count from returns",
    );
    expect(rows[0]?.count).toBe("0");
  });

  it("accepts a request on the last day of the window and refuses the moment after", async () => {
    const parties = await seedParties(database.db);
    const lastMoment = new Date("2026-03-15T09:00:00Z"); // delivered + 14 days.

    const accepted = await requestReturn(database.db, {
      orderId: parties.orderId,
      fulfilmentId: parties.fulfilmentId,
      artworkId: parties.artworkId,
      buyerId: parties.buyerId,
      artistId: parties.artistId,
      deliveredAt: DELIVERED_AT,
      itemSubtotalAgorot: 400_000,
      now: lastMoment,
    });
    expect(accepted.returnCase.status).toBe("requested");

    const second = await seedParties(database.db);
    await expect(
      requestReturn(database.db, {
        orderId: second.orderId,
        fulfilmentId: second.fulfilmentId,
        artworkId: second.artworkId,
        buyerId: second.buyerId,
        artistId: second.artistId,
        deliveredAt: DELIVERED_AT,
        itemSubtotalAgorot: 400_000,
        now: new Date(lastMoment.getTime() + 1),
      }),
    ).rejects.toMatchObject({ code: "returns.window_closed" });
  });

  it("counts the window in calendar days, so a weekend does not extend it", async () => {
    // 1 March 2026 is a Sunday; delivered + 14 calendar days spans two weekends.
    // Counting business days here would hand every buyer four extra days.
    const parties = await seedParties(database.db);

    await expect(
      requestReturn(database.db, {
        orderId: parties.orderId,
        fulfilmentId: parties.fulfilmentId,
        artworkId: parties.artworkId,
        buyerId: parties.buyerId,
        artistId: parties.artistId,
        deliveredAt: DELIVERED_AT,
        itemSubtotalAgorot: 400_000,
        now: new Date("2026-03-16T09:00:00Z"),
      }),
    ).rejects.toMatchObject({ code: "returns.window_closed" });
  });

  it("follows the configured window rather than a hard-coded fourteen", async () => {
    const parties = await seedParties(database.db);
    await setConfig(database.db, "returns.window_days", 30);

    const result = await requestReturn(database.db, {
      orderId: parties.orderId,
      fulfilmentId: parties.fulfilmentId,
      artworkId: parties.artworkId,
      buyerId: parties.buyerId,
      artistId: parties.artistId,
      deliveredAt: DELIVERED_AT,
      itemSubtotalAgorot: 400_000,
      now: DAY_20,
    });

    expect(result.returnCase.status).toBe("requested");
  });

  it("refuses a second request for the same artwork", async () => {
    const parties = await seedParties(database.db);
    await openReturn(database.db, parties);

    await expect(openReturn(database.db, parties)).rejects.toMatchObject({
      kind: "conflict",
      code: "returns.already_requested",
    });
  });
});

describe("the return instructions issued to the buyer", () => {
  const database = useTestDatabase();

  it("name the PACHKA return address and no artist detail of any kind", async () => {
    const parties = await seedParties(database.db);

    const result = await requestReturn(database.db, {
      orderId: parties.orderId,
      fulfilmentId: parties.fulfilmentId,
      artworkId: parties.artworkId,
      buyerId: parties.buyerId,
      artistId: parties.artistId,
      deliveredAt: DELIVERED_AT,
      itemSubtotalAgorot: 400_000,
      now: DAY_10,
    });

    const serialised = JSON.stringify(result.instructions);
    expect(result.instructions.returnAddress.recipient).toBe("PACHKA");
    for (const secret of Object.values(ARTIST_SECRETS)) {
      expect(serialised).not.toContain(secret);
    }
    expect(serialised).not.toContain(parties.artistId);
  });

  it("carry the terms, so the buyer sees who pays for the return alongside the address", async () => {
    const parties = await seedParties(database.db);
    const returnId = await openReturn(database.db, parties);
    const stored = await readReturn(database.db, returnId);

    expect(stored.status).toBe("requested");

    const terms = await returnTerms(database.db);
    expect(terms.returnShippingPaidBy).toBe("buyer");
    expect(terms.transitRiskBorneBy).toBe("buyer");
  });
});

describe("the return terms shown before purchase", () => {
  const database = useTestDatabase();

  it("state that the buyer bears return shipping and transit risk", async () => {
    const terms = await returnTerms(database.db);

    const codes = terms.statements.map((s) => s.code);
    expect(codes).toContain("return_shipping_paid_by_buyer");
    expect(codes).toContain("transit_risk_on_buyer");
    expect(terms.windowDays).toBe(14);
  });

  it("offer no breakage insurance", async () => {
    const terms = await returnTerms(database.db);
    expect(terms.breakageInsuranceOffered).toBe(false);
  });

  it("mention a cancellation fee only once one is configured", async () => {
    const before = await returnTerms(database.db);
    expect(before.statements.map((s) => s.code)).not.toContain("cancellation_fee");

    await setConfig(database.db, "returns.cancellation_fee_rate", 0.05);
    const after = await returnTerms(database.db);
    expect(after.statements.map((s) => s.code)).toContain("cancellation_fee");
  });

  it("say returns go to PACHKA rather than to the artist", async () => {
    const terms = await returnTerms(database.db);
    expect(terms.returnsRouteTo).toBe("pachka");
  });
});

describe("a return that arrives intact", () => {
  const database = useTestDatabase();

  it("releases the refund, completes the order and restores the artwork", async () => {
    const parties = await seedParties(database.db);
    const returnId = await openReturn(database.db, parties);

    const result = await recordOperatorReceipt(database.db, {
      returnId,
      operatorId: parties.operatorId,
      condition: "intact",
      now: new Date("2026-03-18T09:00:00Z"),
    });

    expect(result.returnCase.status).toBe("received_intact");
    expect(result.orderTransition).toBe("returned");
    expect(result.restoreInventory).toBe(true);
    expect(result.returnCase.inventoryRestoredAt).not.toBeNull();
    expect(result.returnCase.refundAuthorisedAt).not.toBeNull();
  });

  it("refunds the full subtotal when no cancellation fee is configured", async () => {
    const parties = await seedParties(database.db);
    const returnId = await openReturn(database.db, parties, { itemSubtotalAgorot: 400_000 });

    const result = await recordOperatorReceipt(database.db, {
      returnId,
      operatorId: parties.operatorId,
      condition: "intact",
    });

    expect(result.refund?.feeAgorot).toBe(0);
    expect(result.refund?.refundAgorot).toBe(400_000);
  });

  it("deducts the configured cancellation fee, and loses not one agora to rounding", async () => {
    const parties = await seedParties(database.db);
    await setConfig(database.db, "returns.cancellation_fee_rate", 0.05);
    // 133_337 * 0.05 = 6666.85, which has to round somewhere. Whichever way it
    // goes, fee + refund must still be exactly the subtotal.
    const returnId = await openReturn(database.db, parties, { itemSubtotalAgorot: 133_337 });

    const result = await recordOperatorReceipt(database.db, {
      returnId,
      operatorId: parties.operatorId,
      condition: "intact",
    });

    expect(result.refund?.feeAgorot).toBe(6667);
    expect(result.refund?.refundAgorot).toBe(126_670);
    expect((result.refund?.feeAgorot ?? 0) + (result.refund?.refundAgorot ?? 0)).toBe(133_337);
    expect(Number.isInteger(result.refund?.refundAgorot)).toBe(true);
  });

  it("stores the same figures it returned", async () => {
    const parties = await seedParties(database.db);
    await setConfig(database.db, "returns.cancellation_fee_rate", 0.05);
    const returnId = await openReturn(database.db, parties, { itemSubtotalAgorot: 400_000 });

    await recordOperatorReceipt(database.db, {
      returnId,
      operatorId: parties.operatorId,
      condition: "intact",
    });
    const stored = await readReturn(database.db, returnId);

    expect(stored.cancellationFeeAgorot).toBe(20_000);
    expect(stored.refundAmountAgorot).toBe(380_000);
  });

  it("puts the artwork back within reach of a new buyer", async () => {
    const parties = await seedParties(database.db);
    const returnId = await openReturn(database.db, parties);
    expect(await isArtworkHeldByOpenReturn(database.db, parties.artworkId)).toBe(true);

    await recordOperatorReceipt(database.db, {
      returnId,
      operatorId: parties.operatorId,
      condition: "intact",
    });

    expect(await isArtworkHeldByOpenReturn(database.db, parties.artworkId)).toBe(false);
  });

  it("cannot be recorded twice", async () => {
    const parties = await seedParties(database.db);
    const returnId = await openReturn(database.db, parties);
    await recordOperatorReceipt(database.db, {
      returnId,
      operatorId: parties.operatorId,
      condition: "intact",
    });

    await expect(
      recordOperatorReceipt(database.db, {
        returnId,
        operatorId: parties.operatorId,
        condition: "intact",
      }),
    ).rejects.toMatchObject({ kind: "conflict", code: "returns.already_received" });
  });
});

describe("a return that arrives damaged", () => {
  const database = useTestDatabase();

  it("withholds the refund, opens an admin case and tells both parties", async () => {
    const parties = await seedParties(database.db);
    const returnId = await openReturn(database.db, parties);

    const result = await recordOperatorReceipt(database.db, {
      returnId,
      operatorId: parties.operatorId,
      condition: "damaged",
      notes: "פינה שבורה, האריזה קרועה",
    });

    expect(result.returnCase.status).toBe("disputed");
    expect(result.refund).toBeNull();
    expect(result.returnCase.refundAuthorisedAt).toBeNull();
    expect(result.returnCase.escalationReason).toBe("damaged_on_arrival");
    expect(result.notifications.map((n) => n.audience).sort()).toEqual(["admin", "artist", "buyer"]);
  });

  it("does not put the artwork back on sale", async () => {
    const parties = await seedParties(database.db);
    const returnId = await openReturn(database.db, parties);

    const result = await recordOperatorReceipt(database.db, {
      returnId,
      operatorId: parties.operatorId,
      condition: "damaged",
    });

    expect(result.restoreInventory).toBe(false);
    expect(result.returnCase.inventoryRestoredAt).toBeNull();
    expect(await isArtworkHeldByOpenReturn(database.db, parties.artworkId)).toBe(true);
  });
});

describe("a return that never arrives", () => {
  const database = useTestDatabase();

  it("is flagged for admin review and is not refunded automatically", async () => {
    const parties = await seedParties(database.db);
    const returnId = await openReturn(database.db, parties);

    // The configured receipt window is 14 days from the request.
    const sweep = await flagUnreceivedReturns(database.db, {
      now: new Date("2026-03-30T09:00:00Z"),
    });

    expect(sweep.cases.map((c) => c.id)).toEqual([returnId]);
    expect(sweep.notifications.some((n) => n.audience === "admin")).toBe(true);

    const stored = await readReturn(database.db, returnId);
    expect(stored.status).toBe("unreceived");
    expect(stored.escalationReason).toBe("never_arrived");
    expect(stored.refundAuthorisedAt).toBeNull();
    expect(stored.refundAmountAgorot).toBeNull();
  });

  it("is left alone while the window is still open", async () => {
    const parties = await seedParties(database.db);
    await openReturn(database.db, parties);

    const sweep = await flagUnreceivedReturns(database.db, {
      now: new Date("2026-03-20T09:00:00Z"),
    });

    expect(sweep.cases).toEqual([]);
  });

  it("keeps the artwork unavailable while it is unresolved", async () => {
    const parties = await seedParties(database.db);
    await openReturn(database.db, parties);
    await flagUnreceivedReturns(database.db, { now: new Date("2026-03-30T09:00:00Z") });

    expect(await isArtworkHeldByOpenReturn(database.db, parties.artworkId)).toBe(true);
  });

  it("still accepts a late arrival an operator finds afterwards", async () => {
    const parties = await seedParties(database.db);
    const returnId = await openReturn(database.db, parties);
    await flagUnreceivedReturns(database.db, { now: new Date("2026-03-30T09:00:00Z") });

    const result = await recordOperatorReceipt(database.db, {
      returnId,
      operatorId: parties.operatorId,
      condition: "intact",
      now: new Date("2026-03-31T09:00:00Z"),
    });

    expect(result.returnCase.status).toBe("received_intact");
    expect(result.restoreInventory).toBe(true);
  });
});

describe("forwarding the artwork on to its artist", () => {
  const database = useTestDatabase();

  it("cannot happen before an operator has the parcel in hand", async () => {
    const parties = await seedParties(database.db);
    const returnId = await openReturn(database.db, parties);

    await expect(
      forwardToArtist(database.db, {
        returnId,
        operatorId: parties.operatorId,
        artistAddress: ARTIST_ADDRESS,
      }),
    ).rejects.toMatchObject({ kind: "conflict", code: "returns.not_received" });
  });

  it("puts the artist's address on the label and nowhere else", async () => {
    const parties = await seedParties(database.db);
    const returnId = await openReturn(database.db, parties);
    await recordOperatorReceipt(database.db, {
      returnId,
      operatorId: parties.operatorId,
      condition: "intact",
    });

    const { label } = await forwardToArtist(database.db, {
      returnId,
      operatorId: parties.operatorId,
      artistAddress: ARTIST_ADDRESS,
      now: new Date("2026-03-19T09:00:00Z"),
    });

    expect(label.to.line1).toBe(ARTIST_SECRETS.streetAddress);

    // And the row itself holds none of it. The buyer has a read policy on this
    // table; the artist's street address must not be sitting on it.
    const { rows } = await database.db.query("select * from returns where id = $1", [returnId]);
    const stored = JSON.stringify(rows[0]);
    for (const secret of Object.values(ARTIST_SECRETS)) {
      expect(stored).not.toContain(secret);
    }
  });
});

describe("an artist who does not respond to a forwarded return", () => {
  const database = useTestDatabase();

  async function forwarded(db: Database): Promise<{ parties: Parties; returnId: string }> {
    const parties = await seedParties(db);
    const returnId = await openReturn(db, parties);
    await recordOperatorReceipt(db, {
      returnId,
      operatorId: parties.operatorId,
      condition: "intact",
      now: new Date("2026-03-18T09:00:00Z"),
    });
    await forwardToArtist(db, {
      returnId,
      operatorId: parties.operatorId,
      artistAddress: ARTIST_ADDRESS,
      now: new Date("2026-03-19T09:00:00Z"),
    });
    return { parties, returnId };
  }

  it("escalates to an admin once the response window passes", async () => {
    const { returnId } = await forwarded(database.db);

    const sweep = await escalateSilentArtists(database.db, {
      now: new Date("2026-03-27T09:00:00Z"),
    });

    expect(sweep.cases.map((c) => c.id)).toEqual([returnId]);
    expect(sweep.notifications[0]?.audience).toBe("admin");
    expect((await readReturn(database.db, returnId)).escalationReason).toBe("artist_silent");
  });

  it("does not claw back the buyer's refund, because silence must never hold a buyer's money", async () => {
    const { returnId } = await forwarded(database.db);
    await escalateSilentArtists(database.db, { now: new Date("2026-03-27T09:00:00Z") });

    const stored = await readReturn(database.db, returnId);
    expect(stored.refundAuthorisedAt).not.toBeNull();
    expect(stored.refundAmountAgorot).toBe(400_000);
  });

  it("is not escalated while the response window is still open", async () => {
    await forwarded(database.db);

    const sweep = await escalateSilentArtists(database.db, {
      now: new Date("2026-03-22T09:00:00Z"),
    });

    expect(sweep.cases).toEqual([]);
  });

  it("is not escalated once they have confirmed receipt", async () => {
    const { parties, returnId } = await forwarded(database.db);
    await recordArtistResponse(database.db, {
      returnId,
      artistId: parties.artistId,
      response: "confirmed",
      now: new Date("2026-03-21T09:00:00Z"),
    });

    const sweep = await escalateSilentArtists(database.db, {
      now: new Date("2026-03-27T09:00:00Z"),
    });

    expect(sweep.cases).toEqual([]);
  });

  it("raises their damage claim as an escalation without unsettling the buyer's refund", async () => {
    const { parties, returnId } = await forwarded(database.db);

    const result = await recordArtistResponse(database.db, {
      returnId,
      artistId: parties.artistId,
      response: "damaged",
      notes: "הגיע שבור",
      now: new Date("2026-03-21T09:00:00Z"),
    });

    // The case stays settled from the buyer's side. The artist's claim is
    // against PACHKA, who had custody of the parcel, and an admin picks it up
    // from the escalation -- it is not a question about the refund, which was
    // released when the operator recorded the artwork as intact.
    expect(result.returnCase.status).toBe("received_intact");
    expect(result.returnCase.artistDamageReportedAt).not.toBeNull();
    expect(result.returnCase.escalationReason).toBe("artist_reported_damage");
    expect(result.returnCase.refundAuthorisedAt).not.toBeNull();
    expect(result.returnCase.refundAmountAgorot).toBe(400_000);
    expect(result.notifications.some((n) => n.audience === "admin")).toBe(true);
  });

  it("still opens a dispute when no refund has been released yet", async () => {
    // The other route into forwarding: the operator recorded damage, so the case
    // is already disputed and no money has moved. An artist report there is a
    // genuine dispute, and must stay one.
    const parties = await seedParties(database.db);
    const returnId = await openReturn(database.db, parties);
    await recordOperatorReceipt(database.db, {
      returnId,
      operatorId: parties.operatorId,
      condition: "damaged",
    });
    await forwardToArtist(database.db, {
      returnId,
      operatorId: parties.operatorId,
      artistAddress: ARTIST_ADDRESS,
      now: new Date("2026-03-19T09:00:00Z"),
    });

    const result = await recordArtistResponse(database.db, {
      returnId,
      artistId: parties.artistId,
      response: "damaged",
      now: new Date("2026-03-21T09:00:00Z"),
    });

    expect(result.returnCase.status).toBe("disputed");
    expect(result.returnCase.refundAuthorisedAt).toBeNull();
  });

  it("cannot respond to another artist's return, and is told nothing about it", async () => {
    const { returnId } = await forwarded(database.db);
    const otherArtist = await seedAccount(database.db, "Ori K.", "artist");

    await expect(
      recordArtistResponse(database.db, {
        returnId,
        artistId: otherArtist,
        response: "confirmed",
      }),
    ).rejects.toMatchObject({ kind: "not_found" });
  });
});

describe("an admin resolving a disputed return", () => {
  const database = useTestDatabase();

  async function disputed(db: Database): Promise<{ parties: Parties; returnId: string }> {
    const parties = await seedParties(db);
    const returnId = await openReturn(db, parties);
    await recordOperatorReceipt(db, {
      returnId,
      operatorId: parties.operatorId,
      condition: "damaged",
    });
    return { parties, returnId };
  }

  it("may refund the buyer even though the artwork came back damaged", async () => {
    const { parties, returnId } = await disputed(database.db);

    const result = await resolveReturnByAdmin(database.db, {
      returnId,
      adminId: parties.operatorId,
      outcome: "refund_buyer",
      notes: "האריזה תקינה, הנזק נגרם במעבר",
    });

    expect(result.returnCase.status).toBe("resolved_refunded");
    expect(result.refund?.refundAgorot).toBe(400_000);
  });

  it("does not put a damaged artwork back on sale, whoever the refund went to", async () => {
    const { parties, returnId } = await disputed(database.db);

    const result = await resolveReturnByAdmin(database.db, {
      returnId,
      adminId: parties.operatorId,
      outcome: "refund_buyer",
    });

    expect(result.restoreInventory).toBe(false);
    expect(result.orderTransition).toBeNull();
    expect(result.returnCase.inventoryRestoredAt).toBeNull();
  });

  it("may deny the refund, and issues none when it does", async () => {
    const { parties, returnId } = await disputed(database.db);

    const result = await resolveReturnByAdmin(database.db, {
      returnId,
      adminId: parties.operatorId,
      outcome: "deny_refund",
    });

    expect(result.returnCase.status).toBe("resolved_denied");
    expect(result.refund).toBeNull();
    expect(result.returnCase.refundAuthorisedAt).toBeNull();
  });

  it("may resolve a return that never arrived, and still restores nothing", async () => {
    const parties = await seedParties(database.db);
    const returnId = await openReturn(database.db, parties);
    await flagUnreceivedReturns(database.db, { now: new Date("2026-03-30T09:00:00Z") });

    const result = await resolveReturnByAdmin(database.db, {
      returnId,
      adminId: parties.operatorId,
      outcome: "refund_buyer",
    });

    expect(result.returnCase.status).toBe("resolved_refunded");
    expect(result.restoreInventory).toBe(false);
  });

  it("has nothing to resolve on a case the operator already settled", async () => {
    const parties = await seedParties(database.db);
    const returnId = await openReturn(database.db, parties);
    await recordOperatorReceipt(database.db, {
      returnId,
      operatorId: parties.operatorId,
      condition: "intact",
    });

    await expect(
      resolveReturnByAdmin(database.db, {
        returnId,
        adminId: parties.operatorId,
        outcome: "deny_refund",
      }),
    ).rejects.toMatchObject({ kind: "conflict", code: "returns.not_disputed" });
  });
});

describe("the refund and inventory gates in the database itself", () => {
  const database = useTestDatabase();

  it("refuse a refund authorised on a return nobody has received", async () => {
    const parties = await seedParties(database.db);
    const returnId = await openReturn(database.db, parties);

    await expect(
      database.db.query(
        "update returns set refund_authorised_at = now(), refund_amount_agorot = 400000 where id = $1",
        [returnId],
      ),
    ).rejects.toThrow(/returns_refund_requires_gate/);
  });

  it("refuse restoring inventory for an artwork that came back damaged", async () => {
    const parties = await seedParties(database.db);
    const returnId = await openReturn(database.db, parties);
    await recordOperatorReceipt(database.db, {
      returnId,
      operatorId: parties.operatorId,
      condition: "damaged",
    });

    await expect(
      database.db.query("update returns set inventory_restored_at = now() where id = $1", [returnId]),
    ).rejects.toThrow(/returns_inventory_requires_intact/);
  });

  it("refuse a receipt recorded without a condition", async () => {
    const parties = await seedParties(database.db);
    const returnId = await openReturn(database.db, parties);

    await expect(
      database.db.query("update returns set received_at = now() where id = $1", [returnId]),
    ).rejects.toThrow(/returns_received_has_condition/);
  });
});

describe("a return on the public data API", () => {
  const database = useTestDatabase();

  it("is readable by its buyer and its artist, and by nobody else", async () => {
    const parties = await seedParties(database.db);
    await openReturn(database.db, parties);
    const stranger = await seedAccount(database.db, "Someone Else", "buyer");

    const asBuyer = await asUser(database.db, parties.buyerId, async (tx) =>
      (await tx.query("select id from returns")).rows,
    );
    const asArtist = await asUser(database.db, parties.artistId, async (tx) =>
      (await tx.query("select id from returns")).rows,
    );
    const asStranger = await asUser(database.db, stranger, async (tx) =>
      (await tx.query("select id from returns")).rows,
    );

    expect(asBuyer).toHaveLength(1);
    expect(asArtist).toHaveLength(1);
    expect(asStranger).toEqual([]);
  });

  it("cannot be written by its own buyer", async () => {
    const parties = await seedParties(database.db);
    await openReturn(database.db, parties);

    await expect(
      asUser(database.db, parties.buyerId, (tx) =>
        tx.query("update returns set status = 'received_intact'"),
      ),
    ).rejects.toThrow(/permission denied/i);
  });
});
