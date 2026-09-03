/**
 * Artist-managed fulfilment: the deadline, the tracking reference, and the
 * packaging confirmation.
 *
 * Three refusals in `shipping-and-returns` are asserted here rather than
 * assumed: shipping without a tracking reference, shipping a fragile piece
 * without confirming the packaging, and touching another artist's fulfilment.
 * The first two are also CHECK constraints, and the test at the bottom writes
 * straight to the table to prove the constraint holds even when module code is
 * not the one writing.
 */
import { describe, expect, it } from "vitest";
import { asUser, useTestDatabase } from "../harness";
import { setConfig } from "@/shared/config";
import type { Database } from "@/shared/db";
import {
  dispatchInstructions,
  flagOverdueDispatches,
  markShipped,
  outboundReturnAddress,
  readDispatch,
  recordDispatchObligation,
} from "@/modules/shipping";

const PAID_AT = new Date("2026-03-04T09:00:00Z"); // A Wednesday.

async function seedArtist(db: Database, name: string): Promise<string> {
  const { rows } = await db.query<{ user_id: string }>(
    "insert into profiles (user_id, display_name) values (gen_random_uuid(), $1) returning user_id",
    [name],
  );
  const id = rows[0]!.user_id;
  await db.query("insert into user_roles (user_id, role) values ($1, 'artist')", [id]);
  return id;
}

const uuid = (): string => crypto.randomUUID();

describe("the dispatch deadline", () => {
  const database = useTestDatabase();

  it("is the stated lead time plus the configured grace, counted in business days", async () => {
    const artistId = await seedArtist(database.db, "Noa B.");
    // Default grace is 3 business days. 5 + 3 from Wednesday 4 March lands on
    // Monday 16 March: the two weekends in between are not working days, and
    // counting them would chase this artist four days early.
    const { dispatch } = await recordDispatchObligation(database.db, {
      fulfilmentId: uuid(),
      orderId: uuid(),
      artistId,
      leadTimeDays: 5,
      paidAt: PAID_AT,
    });

    expect(dispatch.dueAt.toISOString()).toBe("2026-03-16T09:00:00.000Z");
  });

  it("moves when an admin changes the grace period, with no deployment", async () => {
    const artistId = await seedArtist(database.db, "Noa B.");
    await setConfig(database.db, "shipping.unshipped_grace_days", 0);

    const { dispatch } = await recordDispatchObligation(database.db, {
      fulfilmentId: uuid(),
      orderId: uuid(),
      artistId,
      leadTimeDays: 5,
      paidAt: PAID_AT,
    });

    expect(dispatch.dueAt.toISOString()).toBe("2026-03-11T09:00:00.000Z");
  });

  it("is not reset by a retried payment webhook", async () => {
    const artistId = await seedArtist(database.db, "Noa B.");
    const fulfilmentId = uuid();
    const first = await recordDispatchObligation(database.db, {
      fulfilmentId,
      orderId: uuid(),
      artistId,
      leadTimeDays: 5,
      paidAt: PAID_AT,
    });

    // Same fulfilment, a day later. A second row -- or a later deadline -- would
    // hand an artist an extra day for every duplicated webhook.
    const second = await recordDispatchObligation(database.db, {
      fulfilmentId,
      orderId: uuid(),
      artistId,
      leadTimeDays: 5,
      paidAt: new Date("2026-03-05T09:00:00Z"),
    });

    expect(second.dispatch.dueAt.toISOString()).toBe(first.dispatch.dueAt.toISOString());
    const { rows } = await database.db.query<{ count: string }>(
      "select count(*)::text as count from shipping_dispatches where fulfilment_id = $1",
      [fulfilmentId],
    );
    expect(rows[0]?.count).toBe("1");
  });
});

describe("marking a fulfilment shipped", () => {
  const database = useTestDatabase();

  async function obligation(
    db: Database,
    options: { fragile?: boolean; medium?: string } = {},
  ): Promise<{ artistId: string; fulfilmentId: string; orderId: string }> {
    const artistId = await seedArtist(db, "Noa B.");
    const fulfilmentId = uuid();
    const orderId = uuid();
    await recordDispatchObligation(db, {
      fulfilmentId,
      orderId,
      artistId,
      leadTimeDays: 5,
      paidAt: PAID_AT,
      ...options,
    });
    return { artistId, fulfilmentId, orderId };
  }

  it("records the carrier and tracking reference and notifies the buyer with it", async () => {
    const { artistId, fulfilmentId, orderId } = await obligation(database.db);

    const result = await markShipped(database.db, {
      fulfilmentId,
      artistId,
      carrierName: "דואר ישראל",
      trackingReference: "RR123456785IL",
      now: new Date("2026-03-09T10:00:00Z"),
    });

    expect(result.dispatch.shippedAt?.toISOString()).toBe("2026-03-09T10:00:00.000Z");
    expect(result.dispatch.trackingReference).toBe("RR123456785IL");

    const buyerNotice = result.notifications.find((n) => n.audience === "buyer");
    expect(buyerNotice?.template).toBe("shipping.fulfilment_shipped");
    expect(buyerNotice?.data).toMatchObject({ trackingReference: "RR123456785IL", orderId });

    const stored = await readDispatch(database.db, { fulfilmentId });
    expect(stored.carrierName).toBe("דואר ישראל");
  });

  it("is rejected without a tracking reference, and leaves the fulfilment unshipped", async () => {
    const { artistId, fulfilmentId } = await obligation(database.db);

    await expect(
      markShipped(database.db, {
        fulfilmentId,
        artistId,
        carrierName: "דואר ישראל",
        trackingReference: "   ",
      }),
    ).rejects.toMatchObject({ kind: "validation", code: "shipping.tracking_required" });

    const stored = await readDispatch(database.db, { fulfilmentId });
    expect(stored.shippedAt).toBeNull();
    expect(stored.trackingReference).toBeNull();
  });

  it("is rejected without a carrier name", async () => {
    const { artistId, fulfilmentId } = await obligation(database.db);

    await expect(
      markShipped(database.db, {
        fulfilmentId,
        artistId,
        carrierName: "",
        trackingReference: "RR123456785IL",
      }),
    ).rejects.toMatchObject({ kind: "validation", code: "shipping.tracking_required" });

    expect((await readDispatch(database.db, { fulfilmentId })).shippedAt).toBeNull();
  });

  it("names both missing fields at once rather than one per attempt", async () => {
    const { artistId, fulfilmentId } = await obligation(database.db);

    await expect(
      markShipped(database.db, { fulfilmentId, artistId, carrierName: "", trackingReference: "" }),
    ).rejects.toMatchObject({
      fields: {
        carrierName: expect.any(Array),
        trackingReference: expect.any(Array),
      },
    });
  });

  it("is rejected twice, so a double submit cannot re-stamp the shipping date", async () => {
    const { artistId, fulfilmentId } = await obligation(database.db);
    await markShipped(database.db, {
      fulfilmentId,
      artistId,
      carrierName: "דואר ישראל",
      trackingReference: "RR123456785IL",
      now: new Date("2026-03-09T10:00:00Z"),
    });

    await expect(
      markShipped(database.db, {
        fulfilmentId,
        artistId,
        carrierName: "אחר",
        trackingReference: "ZZ999999999IL",
        now: new Date("2026-03-10T10:00:00Z"),
      }),
    ).rejects.toMatchObject({ kind: "conflict", code: "shipping.already_shipped" });

    const stored = await readDispatch(database.db, { fulfilmentId });
    expect(stored.trackingReference).toBe("RR123456785IL");
  });

  it("is not something another artist can do to your fulfilment, and says nothing about it existing", async () => {
    const { fulfilmentId } = await obligation(database.db);
    const otherArtist = await seedArtist(database.db, "Ori K.");

    // not_found, not forbidden: "forbidden" confirms the fulfilment exists and
    // lets an artist enumerate a competitor's sales (SECURITY.md S1-18).
    await expect(
      markShipped(database.db, {
        fulfilmentId,
        artistId: otherArtist,
        carrierName: "דואר ישראל",
        trackingReference: "RR123456785IL",
      }),
    ).rejects.toMatchObject({ kind: "not_found" });
  });
});

describe("a fragile fulfilment", () => {
  const database = useTestDatabase();

  async function ceramicObligation(db: Database): Promise<{ artistId: string; fulfilmentId: string }> {
    const artistId = await seedArtist(db, "Noa B.");
    const fulfilmentId = uuid();
    await recordDispatchObligation(db, {
      fulfilmentId,
      orderId: uuid(),
      artistId,
      leadTimeDays: 3,
      medium: "ceramics and objects",
      paidAt: PAID_AT,
    });
    return { artistId, fulfilmentId };
  }

  it("carries a packaging obligation the artist is shown before dispatching", async () => {
    const { artistId, fulfilmentId } = await ceramicObligation(database.db);

    const instructions = await dispatchInstructions(database.db, { fulfilmentId, artistId });

    expect(instructions.packaging.required).toBe(true);
    expect(instructions.packaging.requirements.length).toBeGreaterThan(0);
    expect(instructions.packaging.breakageInsuranceOffered).toBe(false);
  });

  it("cannot be marked shipped without confirming the packaging was done", async () => {
    const { artistId, fulfilmentId } = await ceramicObligation(database.db);

    await expect(
      markShipped(database.db, {
        fulfilmentId,
        artistId,
        carrierName: "דואר ישראל",
        trackingReference: "RR123456785IL",
      }),
    ).rejects.toMatchObject({ kind: "validation", code: "shipping.packaging_confirmation_required" });

    expect((await readDispatch(database.db, { fulfilmentId })).shippedAt).toBeNull();
  });

  it("cannot be marked shipped by passing anything other than an explicit confirmation", async () => {
    const { artistId, fulfilmentId } = await ceramicObligation(database.db);

    await expect(
      markShipped(database.db, {
        fulfilmentId,
        artistId,
        carrierName: "דואר ישראל",
        trackingReference: "RR123456785IL",
        packagingConfirmed: false,
      }),
    ).rejects.toMatchObject({ code: "shipping.packaging_confirmation_required" });
  });

  it("ships once the artist confirms, and the confirmation is recorded", async () => {
    const { artistId, fulfilmentId } = await ceramicObligation(database.db);

    const result = await markShipped(database.db, {
      fulfilmentId,
      artistId,
      carrierName: "דואר ישראל",
      trackingReference: "RR123456785IL",
      packagingConfirmed: true,
      now: new Date("2026-03-09T10:00:00Z"),
    });

    // There is no breakage insurance behind this. The record of what the artist
    // confirmed is the only thing that exists when a ceramic arrives broken.
    expect(result.dispatch.packagingConfirmedAt?.toISOString()).toBe("2026-03-09T10:00:00.000Z");
    expect(result.dispatch.shippedAt).not.toBeNull();
  });

  it("does not demand a confirmation from an artwork that is not fragile", async () => {
    const artistId = await seedArtist(database.db, "Noa B.");
    const fulfilmentId = uuid();
    await recordDispatchObligation(database.db, {
      fulfilmentId,
      orderId: uuid(),
      artistId,
      leadTimeDays: 3,
      medium: "photography",
      paidAt: PAID_AT,
    });

    const result = await markShipped(database.db, {
      fulfilmentId,
      artistId,
      carrierName: "דואר ישראל",
      trackingReference: "RR123456785IL",
    });

    expect(result.dispatch.shippedAt).not.toBeNull();
    expect(result.dispatch.packagingConfirmedAt).toBeNull();
  });
});

describe("the dispatch deadline passing", () => {
  const database = useTestDatabase();

  it("flags the fulfilment and notifies both the artist and an admin", async () => {
    const artistId = await seedArtist(database.db, "Noa B.");
    const fulfilmentId = uuid();
    await recordDispatchObligation(database.db, {
      fulfilmentId,
      orderId: uuid(),
      artistId,
      leadTimeDays: 5,
      paidAt: PAID_AT,
    });

    const sweep = await flagOverdueDispatches(database.db, {
      now: new Date("2026-03-17T09:00:00Z"),
    });

    expect(sweep.flagged.map((d) => d.fulfilmentId)).toEqual([fulfilmentId]);
    expect(sweep.notifications.map((n) => n.audience).sort()).toEqual(["admin", "artist"]);
    expect((await readDispatch(database.db, { fulfilmentId })).flaggedAt).not.toBeNull();
  });

  it("does not flag a fulfilment whose deadline has not arrived", async () => {
    const artistId = await seedArtist(database.db, "Noa B.");
    await recordDispatchObligation(database.db, {
      fulfilmentId: uuid(),
      orderId: uuid(),
      artistId,
      leadTimeDays: 5,
      paidAt: PAID_AT,
    });

    const sweep = await flagOverdueDispatches(database.db, {
      now: new Date("2026-03-15T09:00:00Z"),
    });

    expect(sweep.flagged).toEqual([]);
  });

  it("does not flag a fulfilment that shipped in time", async () => {
    const artistId = await seedArtist(database.db, "Noa B.");
    const fulfilmentId = uuid();
    await recordDispatchObligation(database.db, {
      fulfilmentId,
      orderId: uuid(),
      artistId,
      leadTimeDays: 5,
      paidAt: PAID_AT,
    });
    await markShipped(database.db, {
      fulfilmentId,
      artistId,
      carrierName: "דואר ישראל",
      trackingReference: "RR123456785IL",
      now: new Date("2026-03-09T10:00:00Z"),
    });

    const sweep = await flagOverdueDispatches(database.db, {
      now: new Date("2026-03-30T09:00:00Z"),
    });

    expect(sweep.flagged).toEqual([]);
  });

  it("does not chase the same artist twice when the sweep runs twice", async () => {
    const artistId = await seedArtist(database.db, "Noa B.");
    await recordDispatchObligation(database.db, {
      fulfilmentId: uuid(),
      orderId: uuid(),
      artistId,
      leadTimeDays: 5,
      paidAt: PAID_AT,
    });

    const now = new Date("2026-03-17T09:00:00Z");
    const first = await flagOverdueDispatches(database.db, { now });
    // A scheduler firing twice is normal, not exceptional.
    const second = await flagOverdueDispatches(database.db, { now });

    expect(first.flagged).toHaveLength(1);
    expect(second.flagged).toEqual([]);
    expect(second.notifications).toEqual([]);
  });
});

describe("the outbound parcel", () => {
  const database = useTestDatabase();

  it("carries the PACHKA return address, not the artist's", async () => {
    const artistId = await seedArtist(database.db, "Noa B.");
    await database.db.query(
      `insert into artist_contact_details (user_id, email, phone, street_address, postal_code)
       values ($1, 'noa@example.com', '0501112222', 'רחוב הפרח 12, חיפה', '3100000')`,
      [artistId],
    );
    const fulfilmentId = uuid();
    await recordDispatchObligation(database.db, {
      fulfilmentId,
      orderId: uuid(),
      artistId,
      leadTimeDays: 3,
      paidAt: PAID_AT,
    });

    const instructions = await dispatchInstructions(database.db, { fulfilmentId, artistId });
    const serialised = JSON.stringify(instructions);

    // A return address on the label discloses the artist on the very first sale,
    // whatever the software does afterwards (SECURITY.md SPEC-A).
    expect(instructions.returnAddress.recipient).toBe("PACHKA");
    for (const secret of ["noa@example.com", "0501112222", "רחוב הפרח 12, חיפה", "3100000"]) {
      expect(serialised).not.toContain(secret);
    }
  });

  it("uses the same PACHKA address for every artist", async () => {
    const first = await outboundReturnAddress(database.db);
    const second = await outboundReturnAddress(database.db);
    expect(first).toEqual(second);
    expect(first.recipient).toBe("PACHKA");
  });
});

describe("the shipped state in the database itself", () => {
  const database = useTestDatabase();

  it("cannot exist without a tracking reference, however the row is written", async () => {
    const artistId = await seedArtist(database.db, "Noa B.");
    const fulfilmentId = uuid();
    await recordDispatchObligation(database.db, {
      fulfilmentId,
      orderId: uuid(),
      artistId,
      leadTimeDays: 3,
      paidAt: PAID_AT,
    });

    await expect(
      database.db.query("update shipping_dispatches set shipped_at = now() where fulfilment_id = $1", [
        fulfilmentId,
      ]),
    ).rejects.toThrow(/shipping_dispatches_shipped_needs_tracking/);
  });

  it("cannot exist for a fragile fulfilment without a packaging confirmation", async () => {
    const artistId = await seedArtist(database.db, "Noa B.");
    const fulfilmentId = uuid();
    await recordDispatchObligation(database.db, {
      fulfilmentId,
      orderId: uuid(),
      artistId,
      leadTimeDays: 3,
      medium: "ceramics and objects",
      paidAt: PAID_AT,
    });

    await expect(
      database.db.query(
        `update shipping_dispatches
            set shipped_at = now(), carrier_name = 'x1', tracking_reference = 'RR1234'
          where fulfilment_id = $1`,
        [fulfilmentId],
      ),
    ).rejects.toThrow(/shipping_dispatches_fragile_needs_confirmation/);
  });
});

describe("a dispatch on the public data API", () => {
  const database = useTestDatabase();

  it("is visible to the artist it belongs to and to nobody else", async () => {
    const artistId = await seedArtist(database.db, "Noa B.");
    const otherArtist = await seedArtist(database.db, "Ori K.");
    await recordDispatchObligation(database.db, {
      fulfilmentId: uuid(),
      orderId: uuid(),
      artistId,
      leadTimeDays: 3,
      paidAt: PAID_AT,
    });

    const own = await asUser(database.dataApi, artistId, async (tx) =>
      (await tx.query("select id from shipping_dispatches")).rows,
    );
    const other = await asUser(database.dataApi, otherArtist, async (tx) =>
      (await tx.query("select id from shipping_dispatches")).rows,
    );

    expect(own).toHaveLength(1);
    expect(other).toEqual([]);
  });
});
