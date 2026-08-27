/**
 * `toPublicArtist()` — task 2.7.
 *
 * The interesting tests here are the refusals. A serializer that quietly drops
 * unexpected fields looks like it is working and leaves the too-wide query in
 * place, and the next person to use that query passes the row somewhere this
 * function is not (SECURITY.md S1-8: React serialises the whole prop object of
 * a Client Component into the HTML, whatever the JSX renders).
 */
import { describe, expect, it } from "vitest";
import { PUBLIC_ARTIST_COLUMNS, toPublicArtist, type ArtistProfileRow } from "./serialize";

const NARROW: ArtistProfileRow = {
  user_id: "3f6b1c2e-0000-4000-8000-000000000001",
  display_name: "Yael Schwartz",
  biography: "Painter, acrylic on linen.",
  city: "Tel Aviv",
  avatar_path: "avatars/yael.jpg",
  created_at: new Date("2026-02-01T09:00:00Z"),
};

describe("toPublicArtist", () => {
  it("returns exactly the public fields and no others", () => {
    // Asserted as an exact object rather than field by field: a new key added
    // to the return value should fail this test and make someone justify it.
    expect(toPublicArtist(NARROW)).toEqual({
      id: "3f6b1c2e-0000-4000-8000-000000000001",
      displayName: "Yael Schwartz",
      biography: "Painter, acrylic on linen.",
      city: "Tel Aviv",
      avatarPath: "avatars/yael.jpg",
      memberSince: "2026-02-01T09:00:00.000Z",
    });
  });

  it("has exactly these keys", () => {
    expect(Object.keys(toPublicArtist(NARROW)).sort()).toEqual([
      "avatarPath",
      "biography",
      "city",
      "displayName",
      "id",
      "memberSince",
    ]);
  });

  it("treats a missing biography as empty rather than as null on the page", () => {
    expect(toPublicArtist({ ...NARROW, biography: null }).biography).toBe("");
  });

  it("keeps a missing city null, because the page renders nothing for it", () => {
    expect(toPublicArtist({ ...NARROW, city: null }).city).toBeNull();
  });

  it("accepts a timestamp that arrived as a string", () => {
    const artist = toPublicArtist({ ...NARROW, created_at: "2026-02-01T09:00:00Z" });

    expect(artist.memberSince).toBe("2026-02-01T09:00:00.000Z");
  });
});

describe("a row that is too wide", () => {
  it.each([
    ["an email address", { email: "yael@gmail.com" }],
    ["a phone number", { phone: "0501234567" }],
    ["a street address", { street_address: "12 Nahalat Binyamin" }],
    ["an Instagram handle", { instagram_handle: "@yael" }],
    ["a website", { website_url: "https://yael.co.il" }],
    ["a bank account", { account_number: "123456789" }],
    ["a branch", { branch: "907" }],
    ["a bank name", { bank_name: "Leumi" }],
  ])("is refused when it carries %s", (_why, extra) => {
    expect(() => toPublicArtist({ ...NARROW, ...extra } as ArtistProfileRow)).toThrow(
      /too wide/i,
    );
  });

  it("names the offending field, so the fix is to the query and not to this call", () => {
    expect(() =>
      toPublicArtist({ ...NARROW, phone: "0501234567" } as ArtistProfileRow),
    ).toThrow(/phone/);
  });

  it("does not silently strip the field instead of refusing", () => {
    // Stripping would leave the wide query in place and working.
    let threw = false;
    try {
      toPublicArtist({ ...NARROW, email: "yael@gmail.com" } as ArtistProfileRow);
    } catch {
      threw = true;
    }
    expect(threw).toBe(true);
  });

  it("catches a prefixed spelling too", () => {
    expect(() =>
      toPublicArtist({ ...NARROW, artist_email: "yael@gmail.com" } as ArtistProfileRow),
    ).toThrow(/too wide/i);
  });
});

describe("the column list buyer-facing queries must use", () => {
  it("names every column the serializer reads", () => {
    // If these drift apart the query starts returning undefined for a field the
    // page renders, which is the sort of bug that reaches production looking
    // like a content problem.
    for (const column of Object.keys(NARROW)) {
      expect(PUBLIC_ARTIST_COLUMNS).toContain(column);
    }
  });

  it("names nothing else", () => {
    const listed = PUBLIC_ARTIST_COLUMNS.split(",").map((c) => c.trim());

    expect(listed.sort()).toEqual(Object.keys(NARROW).sort());
  });

  it("is not a star", () => {
    expect(PUBLIC_ARTIST_COLUMNS).not.toContain("*");
  });
});
