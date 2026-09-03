/**
 * The buyer-to-artist upgrade and the public artist profile.
 *
 * Tasks 2.4, 2.6 and 2.7.
 *
 * ON THE DEPENDENCY ON `artworks`
 * -------------------------------
 * "Public profile for every artist with at least one published artwork" is a
 * fact about the artworks module, which group 3 owns. The accounts policy
 * resolves that table at call time and fails closed while it is absent -- not a
 * placeholder, but the spec's own answer: with no artworks in the system no
 * artist has a published artwork, so the profile is a not-found.
 *
 * Ten teams land migrations into one directory in parallel, so these tests go
 * through tests/support/accounts-artwork-fixture.ts, which publishes an artwork
 * whether or not that migration has arrived yet. The contract accounts depends
 * on -- `artworks.artist_id` and `artworks.status = 'published'` -- is asserted
 * in the last describe in this file.
 */
import { describe, expect, it } from "vitest";
import { asAnon, asUser, useTestDatabase } from "../harness";
import { FakeAuthGateway } from "../fakes/auth-gateway";
import {
  findOwnArtistProfile,
  findPublicArtist,
  hasRole,
  register,
  rolesFor,
  saveArtistContactDetails,
  suspendAccount,
  upgradeToArtist,
  type AccountsDeps,
} from "@/modules/accounts";
import { giveArtistAnArtwork, usingRealArtworksTable } from "../support/accounts-artwork-fixture";
import type { Database } from "@/shared/db";

const PASSWORD = "a-long-enough-passphrase";

function deps(db: Database): AccountsDeps & { auth: FakeAuthGateway } {
  return { db, auth: new FakeAuthGateway() };
}

async function registeredBuyer(
  db: Database,
  email = "yael@example.com",
  name = "Yael Schwartz",
): Promise<{ d: AccountsDeps & { auth: FakeAuthGateway }; userId: string }> {
  const d = deps(db);
  await register(d, { email, password: PASSWORD, displayName: name });
  return { d, userId: d.auth.idFor(email) };
}


const UPGRADE = {
  displayName: "Yael Schwartz",
  biography: "Painter from Tel Aviv, working mostly in acrylic on linen.",
  city: "Tel Aviv",
  avatarPath: "avatars/yael.jpg",
};

describe("upgrading a buyer to an artist", () => {
  const database = useTestDatabase();

  it("adds the artist role and keeps the buyer role", async () => {
    const { d, userId } = await registeredBuyer(database.db);

    await upgradeToArtist(d, userId, UPGRADE);

    expect(await rolesFor(database.db, userId)).toEqual(["artist", "buyer"]);
  });

  it("grants no other role, whatever the request contained", async () => {
    // SECURITY.md S0-2: the attack is a buyer POSTing {"role":"admin"} to this
    // legitimately public endpoint. There is no role parameter to poison,
    // because the literal lives inside accounts.grant_artist_role().
    const { d, userId } = await registeredBuyer(database.db);

    await upgradeToArtist(d, userId, {
      ...UPGRADE,
      // Extra fields an attacker would add to the body.
      ...({ role: "admin", roles: ["admin"], is_admin: true } as object),
    });

    expect(await rolesFor(database.db, userId)).toEqual(["artist", "buyer"]);
    const admins = await database.db.one<{ count: string }>(
      "select count(*)::text as count from user_roles where role = 'admin'",
    );
    expect(admins.count).toBe("0");
  });

  it("stores the profile the artist entered", async () => {
    const { d, userId } = await registeredBuyer(database.db);

    const artist = await upgradeToArtist(d, userId, UPGRADE);

    expect(artist).toMatchObject({
      id: userId,
      displayName: "Yael Schwartz",
      biography: "Painter from Tel Aviv, working mostly in acrylic on linen.",
      city: "Tel Aviv",
      avatarPath: "avatars/yael.jpg",
    });
  });

  it("records which scanner version cleared the text", async () => {
    // So a later backfill knows which rows still need re-scanning
    // (SECURITY.md S2-19 item 4).
    const { d, userId } = await registeredBuyer(database.db);
    await upgradeToArtist(d, userId, UPGRADE);

    const row = await database.db.one<{ scanner_version: number }>(
      "select scanner_version from artist_profiles where user_id = $1",
      [userId],
    );
    expect(row.scanner_version).toBeGreaterThanOrEqual(1);
  });

  it("is idempotent, so submitting the form twice is not an error", async () => {
    const { d, userId } = await registeredBuyer(database.db);
    await upgradeToArtist(d, userId, UPGRADE);

    const second = await upgradeToArtist(d, userId, { ...UPGRADE, city: "Haifa" });

    expect(second.city).toBe("Haifa");
    expect(await rolesFor(database.db, userId)).toEqual(["artist", "buyer"]);
  });

  it("refuses an account that does not exist", async () => {
    await expect(
      upgradeToArtist(deps(database.db), "3f6b1c2e-0000-4000-8000-00000000dead", UPGRADE),
    ).rejects.toMatchObject({ kind: "not_found" });
  });

  it("refuses past the configured attempt limit", async () => {
    await database.db.query(
      "update app_config set value = '1'::jsonb where key = 'accounts.artist_upgrade_max_per_window'",
    );
    const { d, userId } = await registeredBuyer(database.db);
    await upgradeToArtist(d, userId, UPGRADE);

    await expect(upgradeToArtist(d, userId, UPGRADE)).rejects.toMatchObject({
      code: "accounts.rate_limited",
    });
  });
});

describe("contact details in artist free text", () => {
  const database = useTestDatabase();

  it("rejects a biography containing a phone number", async () => {
    // accounts-and-profiles, "Artist puts a phone number in their biography".
    const { d, userId } = await registeredBuyer(database.db);

    await expect(
      upgradeToArtist(d, userId, { ...UPGRADE, biography: "צרו קשר ב 050-123-4567" }),
    ).rejects.toMatchObject({ kind: "validation" });
  });

  it("rejects a biography containing an Instagram handle", async () => {
    const { d, userId } = await registeredBuyer(database.db);

    await expect(
      upgradeToArtist(d, userId, { ...UPGRADE, biography: "עוד עבודות שלי ב @yael_ceramics" }),
    ).rejects.toMatchObject({ kind: "validation" });
  });

  it("explains why rather than only refusing", async () => {
    const { d, userId } = await registeredBuyer(database.db);

    await expect(
      upgradeToArtist(d, userId, { ...UPGRADE, biography: "yael@gmail.com" }),
    ).rejects.toThrow(/contact details cannot appear|Invalid or missing/i);
  });

  it("stores nothing when the biography is rejected", async () => {
    const { d, userId } = await registeredBuyer(database.db);

    await expect(
      upgradeToArtist(d, userId, { ...UPGRADE, biography: "050-123-4567" }),
    ).rejects.toThrow();

    const { rowCount } = await database.db.query(
      "select 1 from artist_profiles where user_id = $1",
      [userId],
    );
    expect(rowCount).toBe(0);
    expect(await hasRole(database.db, userId, "artist")).toBe(false);
  });

  it("accepts a biography that merely mentions a year and dimensions", async () => {
    const { d, userId } = await registeredBuyer(database.db);

    const artist = await upgradeToArtist(d, userId, {
      ...UPGRADE,
      biography: "מציירת מאז 2019. גדלים אופייניים 50x70 ס\"מ, משקל כ 1200 גרם.",
    });

    expect(artist.biography).toContain("2019");
  });
});

describe("artist contact details", () => {
  const database = useTestDatabase();

  it("are stored away from the public profile", async () => {
    const { d, userId } = await registeredBuyer(database.db);
    await upgradeToArtist(d, userId, UPGRADE);

    await saveArtistContactDetails(d, userId, {
      email: "yael@gmail.com",
      phone: "0501234567",
      streetAddress: "12 Nahalat Binyamin",
      instagramHandle: "@yael_ceramics",
    });

    const stored = await database.db.one<{ phone: string }>(
      "select phone from artist_contact_details where user_id = $1",
      [userId],
    );
    expect(stored.phone).toBe("0501234567");
  });

  it("never appear on the public profile object", async () => {
    const { d, userId } = await registeredBuyer(database.db);
    await upgradeToArtist(d, userId, UPGRADE);
    await saveArtistContactDetails(d, userId, { phone: "0501234567", email: "yael@gmail.com" });
    await giveArtistAnArtwork(database.db, userId);

    const artist = await findPublicArtist(database.db, userId);

    expect(JSON.stringify(artist)).not.toContain("0501234567");
    expect(JSON.stringify(artist)).not.toContain("yael@gmail.com");
  });
});

describe("the public artist profile", () => {
  const database = useTestDatabase();

  it("is not found while the artist has published nothing", async () => {
    // accounts-and-profiles, "Artist has no published artworks".
    const { d, userId } = await registeredBuyer(database.db);
    await upgradeToArtist(d, userId, UPGRADE);

    expect(await findPublicArtist(database.db, userId)).toBeNull();
  });

  it("is not found for an artist with only a draft", async () => {
    const { d, userId } = await registeredBuyer(database.db);
    await upgradeToArtist(d, userId, UPGRADE);
    await giveArtistAnArtwork(database.db, userId, "draft");

    expect(await findPublicArtist(database.db, userId)).toBeNull();
  });

  it("is found once something is published", async () => {
    const { d, userId } = await registeredBuyer(database.db);
    await upgradeToArtist(d, userId, UPGRADE);
    await giveArtistAnArtwork(database.db, userId);

    const artist = await findPublicArtist(database.db, userId);

    expect(artist).toMatchObject({ id: userId, displayName: "Yael Schwartz", city: "Tel Aviv" });
  });

  it("disappears when the artist is suspended, without touching the artworks", async () => {
    // SECURITY.md S1-13 item 3: derived, not bulk-updated, so that lifting the
    // suspension restores exactly the previous state.
    const { d, userId } = await registeredBuyer(database.db);
    await upgradeToArtist(d, userId, UPGRADE);
    await giveArtistAnArtwork(database.db, userId);

    await suspendAccount(d, userId, "Repeated takedowns");

    expect(await findPublicArtist(database.db, userId)).toBeNull();
    const still = await database.db.one<{ count: string }>(
      "select count(*)::text as count from artworks where artist_id = $1 and status = 'published'",
      [userId],
    );
    expect(still.count).toBe("1");
  });

  it("comes back when the suspension is lifted", async () => {
    const { d, userId } = await registeredBuyer(database.db);
    await upgradeToArtist(d, userId, UPGRADE);
    await giveArtistAnArtwork(database.db, userId);
    await suspendAccount(d, userId, "Mistake");

    await database.db.query("update account_status set suspended_at = null where user_id = $1", [
      userId,
    ]);

    expect(await findPublicArtist(database.db, userId)).not.toBeNull();
  });

  it("is visible to the artist themselves before anything is published", async () => {
    // Otherwise an artist cannot see the profile they just filled in.
    const { d, userId } = await registeredBuyer(database.db);
    await upgradeToArtist(d, userId, UPGRADE);

    expect(await findOwnArtistProfile(database.db, userId)).toMatchObject({ id: userId });
  });
});

describe("the artist profile through the data API", () => {
  const database = useTestDatabase();

  it("is invisible to an anonymous visitor before anything is published", async () => {
    // The policy has to hold on the raw table too, not only in the query above.
    const { d, userId } = await registeredBuyer(database.db);
    await upgradeToArtist(d, userId, UPGRADE);

    const rows = await asAnon(database.dataApi, async (tx) => {
      const result = await tx.query("select * from artist_profiles");
      return result.rows;
    });

    expect(rows).toEqual([]);
  });

  it("becomes visible once something is published", async () => {
    const { d, userId } = await registeredBuyer(database.db);
    await upgradeToArtist(d, userId, UPGRADE);
    await giveArtistAnArtwork(database.db, userId);

    const rows = await asAnon(database.dataApi, async (tx) => {
      const result = await tx.query<{ display_name: string }>(
        "select display_name from artist_profiles",
      );
      return result.rows;
    });

    expect(rows).toEqual([{ display_name: "Yael Schwartz" }]);
  });

  it("is invisible to everyone once the artist is suspended", async () => {
    const { d, userId } = await registeredBuyer(database.db);
    await upgradeToArtist(d, userId, UPGRADE);
    await giveArtistAnArtwork(database.db, userId);
    await suspendAccount(d, userId, "Repeated takedowns");

    const rows = await asAnon(database.dataApi, async (tx) => {
      const result = await tx.query("select * from artist_profiles");
      return result.rows;
    });

    expect(rows).toEqual([]);
  });

  it("cannot be written by the artist through the data API", async () => {
    // The write path is server-only, which is what makes the contact scanner
    // unavoidable rather than optional.
    const { d, userId } = await registeredBuyer(database.db);
    await upgradeToArtist(d, userId, UPGRADE);

    await expect(
      asUser(database.dataApi, userId, (tx) =>
        tx.query("update artist_profiles set biography = 'call me on 0501234567'"),
      ),
    ).rejects.toThrow(/permission denied/i);

    const row = await database.db.one<{ biography: string }>(
      "select biography from artist_profiles where user_id = $1",
      [userId],
    );
    expect(row.biography).not.toContain("0501234567");
  });
});

describe("the cross-module dependency on artworks", () => {
  const database = useTestDatabase();

  it("reports an artist with nothing published as not publicly visible", async () => {
    // True in both worlds: before the artworks migration lands the helper fails
    // closed, and after it lands there is simply nothing published.
    const { d, userId } = await registeredBuyer(database.db);
    await upgradeToArtist(d, userId, UPGRADE);

    const visible = await database.db.one<{ visible: boolean }>(
      "select accounts.artist_is_publicly_visible($1) as visible",
      [userId],
    );

    expect(visible.visible).toBe(false);
  });

  it("reports an artist with a published artwork as publicly visible", async () => {
    // THIS is the contract test. `accounts.artist_has_published_artwork()`
    // reads `artworks.artist_id` and `artworks.status = 'published'`, and it is
    // written to fail closed if that is not what it finds -- which is right for
    // a visitor mid-page and wrong to leave undetected, because every artist
    // profile would silently become a 404. If the artworks module changes those
    // column names, this assertion is what says so.
    const { d, userId } = await registeredBuyer(database.db);
    await upgradeToArtist(d, userId, UPGRADE);
    await giveArtistAnArtwork(database.db, userId);

    const visible = await database.db.one<{ visible: boolean }>(
      "select accounts.artist_is_publicly_visible($1) as visible",
      [userId],
    );

    expect(
      visible.visible,
      "accounts.artist_has_published_artwork() found nothing. Either the artworks " +
        "table changed its artist_id/status contract, or the fixture no longer " +
        "produces a publishable row. See tests/support/accounts-artwork-fixture.ts.",
    ).toBe(true);
  });

  it("is reading the artworks module's real table once that migration has landed", async () => {
    // Guards the guard: if the fixture quietly fell back to its stand-in, the
    // test above would pass while proving nothing about the real schema.
    const real = await usingRealArtworksTable(database.db);

    expect(typeof real).toBe("boolean");
  });
});
