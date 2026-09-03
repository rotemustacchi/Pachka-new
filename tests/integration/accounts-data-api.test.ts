/**
 * What an attacker holding nothing but the anon key can read.
 *
 * SECURITY.md S0-1 is the finding this file exists for, and it is the one that
 * inverts the mental model the architecture contract creates. `toPublicArtist()`
 * shapes artist data for PACHKA's own responses. It is not on this path at all.
 * The attacker opens the site, reads the anon key out of the JS bundle (it is
 * meant to be there), and issues `GET /rest/v1/artist_profiles?select=*`
 * straight at the Supabase project. RLS is row-level and cannot hide a column,
 * so a policy permissive enough to serve a public profile page serves every
 * column of that row.
 *
 * These tests therefore go through `asAnon` / `asUser`, which reproduce what
 * PostgREST does, rather than through `database.db`, which connects as the
 * owner and would prove nothing.
 */
import { describe, expect, it } from "vitest";
import { asAnon, asUser, useTestDatabase } from "../harness";
import { giveArtistAnArtwork } from "../support/accounts-artwork-fixture";
import type { Database } from "@/shared/db";

/**
 * Strings seeded into the database that must never come back out.
 *
 * Every one of them is long and unmistakable, and that is not fussiness. The
 * sweep below dumps every value from every anon-readable row into one string
 * and asserts these do not appear in it. A SHORT sentinel matches that dump by
 * CHANCE: `branch` was once the three characters `907`, which are all valid hex,
 * and `gen_random_uuid()` produces thirty-two hex characters per row. It failed
 * roughly one run in twenty, and got worse as other modules landed tables that
 * are legitimately anon-readable -- shipping's rate tables alone add about
 * nineteen more UUIDs to the dump.
 *
 * A flaky failure here is worse than a missing test. This file is the only
 * thing standing between an artist's phone number and anyone holding the anon
 * key, and a test that cries wolf once a fortnight is a test somebody marks
 * `.skip` in a hurry.
 *
 * The digits SECURITY.md S0-1 names specifically -- `0501234567` for the phone
 * and `123456789` for the account number -- appear verbatim inside the values
 * below, so the finding's own wording is still satisfied and still greppable.
 */
const SENTINEL = {
  phone: "PHONE-0501234567-SENTINEL",
  accountNumber: "ACCOUNT-123456789-SENTINEL",
  email: "leak-sentinel@example.invalid",
  handle: "@leakhandle-sentinel",
  street: "12 Nahalat Binyamin SENTINEL",
  bank: "BANK-LEUMI-SENTINEL",
  branch: "BRANCH-907-SENTINEL",
} as const;

/**
 * Column names that must not appear anywhere an anonymous caller can select
 * from. Matched as substrings, so `artist_email` and `phone_number` are caught
 * too -- a stricter reading than SECURITY.md's list, and the right one: the
 * finding is about the concept, not the exact spelling.
 */
const FORBIDDEN_COLUMN_FRAGMENTS = [
  "email",
  "phone",
  "address",
  "iban",
  "account_number",
  "branch",
  "bank",
  "social",
  "instagram",
] as const;

/**
 * One artist with something to lose, split across the three tables the way the
 * schema requires. Every test calls this itself against its own database, so
 * nothing is shared and order never matters.
 */
async function seedArtistWithSecrets(db: Database): Promise<{ artistId: string }> {
  const { rows } = await db.query<{ user_id: string }>(
    `insert into profiles (user_id, display_name, city)
     values (gen_random_uuid(), 'Yael Schwartz', 'Tel Aviv')
     returning user_id`,
  );
  const artistId = rows[0]!.user_id;

  await db.query("insert into account_status (user_id, verified_at) values ($1, now())", [
    artistId,
  ]);
  await db.query("insert into user_roles (user_id, role) values ($1, 'buyer'), ($1, 'artist')", [
    artistId,
  ]);
  await db.query(
    `insert into artist_profiles (user_id, display_name, biography, city)
     values ($1, 'Yael Schwartz', 'Painter, acrylic on linen.', 'Tel Aviv')`,
    [artistId],
  );
  await db.query(
    `insert into artist_contact_details
       (user_id, email, phone, street_address, instagram_handle)
     values ($1, $2, $3, $4, $5)`,
    [artistId, SENTINEL.email, SENTINEL.phone, SENTINEL.street, SENTINEL.handle],
  );
  await db.query(
    `insert into artist_payout_details
       (user_id, bank_name, branch, account_number, account_holder_name)
     values ($1, $2, $3, $4, 'Yael Schwartz')`,
    [artistId, SENTINEL.bank, SENTINEL.branch, SENTINEL.accountNumber],
  );

  return { artistId };
}

/** Every base table an attacker could aim the data API at. */
async function publicTables(db: Database): Promise<string[]> {
  const { rows } = await db.query<{ relname: string }>(`
    select c.relname
    from pg_class c join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relkind = 'r'
    order by c.relname
  `);
  return rows.map((r) => r.relname);
}

interface Sweep {
  readonly columns: string[];
  readonly body: string;
  readonly readable: string[];
}

/**
 * `select *` against every table in `public`, as the given caller, collecting
 * the union of every column name returned and every value serialised to text.
 * A table the caller cannot touch simply contributes nothing -- that is the
 * outcome we want, not an error the test has to special-case.
 */
async function sweep(
  db: Database,
  run: <T>(fn: (tx: { query: Database["query"] }) => Promise<T>) => Promise<T>,
): Promise<Sweep> {
  const columns = new Set<string>();
  const chunks: string[] = [];
  const readable: string[] = [];

  for (const table of await publicTables(db)) {
    try {
      const rows = await run(async (tx) => {
        const result = await tx.query<Record<string, unknown>>(`select * from public.${table}`);
        return result.rows;
      });
      readable.push(table);
      for (const row of rows) {
        for (const [name, value] of Object.entries(row)) {
          columns.add(name.toLowerCase());
          if (value !== null && value !== undefined) chunks.push(String(value));
        }
      }
    } catch {
      // Permission denied, or no policy lets a row through. Either way the
      // attacker learns nothing, which is the point.
    }
  }

    // Joined on a newline rather than a space. Two sentinels contain spaces,
  // and a space separator could in principle let the tail of one value and
  // the head of the next form a match across a row boundary -- a false
  // positive in the one test nobody should ever have reason to distrust.
  return { columns: [...columns], body: chunks.join("\n"), readable };
}

describe("the data API, as an anonymous caller holding only the anon key", () => {
  const database = useTestDatabase();

  it("returns no contact or financial column from any table in public", async () => {
    await seedArtistWithSecrets(database.db);

    const { columns } = await sweep(database.db, (fn) => asAnon(database.dataApi, fn));

    const exposed = columns.filter((name) =>
      FORBIDDEN_COLUMN_FRAGMENTS.some((fragment) => name.includes(fragment)),
    );
    expect(exposed, `anonymously readable contact/financial columns: ${exposed.join(", ")}`).toEqual(
      [],
    );
  });

  it("returns none of the artist's actual contact details or bank details", async () => {
    await seedArtistWithSecrets(database.db);

    const { body } = await sweep(database.db, (fn) => asAnon(database.dataApi, fn));

    // Asserted value by value rather than in a loop, so a failure names which
    // one leaked.
    expect(body).not.toContain(SENTINEL.phone);
    expect(body).not.toContain(SENTINEL.accountNumber);
    expect(body).not.toContain(SENTINEL.email);
    expect(body).not.toContain(SENTINEL.handle);
    expect(body).not.toContain(SENTINEL.street);
    expect(body).not.toContain(SENTINEL.branch);
  });

  it("cannot touch artist_contact_details or artist_payout_details at all", async () => {
    // Not "returns no rows" -- no grant whatsoever, so the request is refused
    // before any policy is consulted. A future permissive policy cannot
    // resurrect the exposure on its own (SECURITY.md S0-1 item 2).
    await expect(
      asAnon(database.dataApi, (tx) => tx.query("select * from artist_contact_details")),
    ).rejects.toThrow(/permission denied/i);

    await expect(
      asAnon(database.dataApi, (tx) => tx.query("select * from artist_payout_details")),
    ).rejects.toThrow(/permission denied/i);
  });

  it("still sees a published artist's public columns, so the lockdown is not just an outage", async () => {
    // A test that everything is unreadable would also pass if the whole schema
    // were broken. The public half must genuinely work.
    const { artistId } = await seedArtistWithSecrets(database.db);
    await giveArtistAnArtwork(database.db, artistId);

    const rows = await asAnon(database.dataApi, async (tx) => {
      const result = await tx.query<{ display_name: string; city: string }>(
        "select display_name, city from profiles where user_id = $1",
        [artistId],
      );
      return result.rows;
    });

    expect(rows).toEqual([{ display_name: "Yael Schwartz", city: "Tel Aviv" }]);
  });

  it("cannot enumerate accounts that have no public presence", async () => {
    // `profiles` holds only public columns, which is why the original policy
    // was `using (true)`. That is right about the columns and wrong about the
    // rows: it turns /rest/v1/profiles into a directory of every registered
    // account, and the size of the user base into one request. Only a visible
    // artist, or the author of a displayed review, is genuinely public.
    const { artistId } = await seedArtistWithSecrets(database.db);
    await database.db.query(
      "insert into profiles (user_id, display_name, city) values (gen_random_uuid(), 'Private Buyer', 'Haifa')",
    );

    const rows = await asAnon(database.dataApi, async (tx) => {
      const result = await tx.query<{ display_name: string }>("select display_name from profiles");
      return result.rows;
    });

    expect(rows.map((r) => r.display_name)).not.toContain("Private Buyer");
    // The artist has published nothing either, so at this point nobody is public.
    expect(rows).toEqual([]);
    expect(artistId).toBeTruthy();
  });
});

describe("the data API, as a signed-in buyer who is not the artist", () => {
  const database = useTestDatabase();

  async function seedBuyer(db: Database): Promise<string> {
    const { rows } = await db.query<{ user_id: string }>(
      `insert into profiles (user_id, display_name) values (gen_random_uuid(), 'Michal R.')
       returning user_id`,
    );
    const buyerId = rows[0]!.user_id;
    await db.query("insert into account_status (user_id, verified_at) values ($1, now())", [
      buyerId,
    ]);
    await db.query("insert into user_roles (user_id, role) values ($1, 'buyer')", [buyerId]);
    return buyerId;
  }

  it("reads no contact or financial column either", async () => {
    await seedArtistWithSecrets(database.db);
    const buyerId = await seedBuyer(database.db);

    const { columns, body } = await sweep(database.db, (fn) => asUser(database.dataApi, buyerId, fn));

    const exposed = columns.filter((name) =>
      FORBIDDEN_COLUMN_FRAGMENTS.some((fragment) => name.includes(fragment)),
    );
    expect(exposed, `readable by any signed-in buyer: ${exposed.join(", ")}`).toEqual([]);
    expect(body).not.toContain(SENTINEL.phone);
    expect(body).not.toContain(SENTINEL.accountNumber);
    expect(body).not.toContain(SENTINEL.email);
  });

  it("cannot read another account's roles", async () => {
    const { artistId } = await seedArtistWithSecrets(database.db);
    const buyerId = await seedBuyer(database.db);

    const rows = await asUser(database.dataApi, buyerId, async (tx) => {
      const result = await tx.query("select * from user_roles where user_id = $1", [artistId]);
      return result.rows;
    });

    expect(rows).toEqual([]);
  });

  it("cannot read another account's suspension or verification state", async () => {
    const { artistId } = await seedArtistWithSecrets(database.db);
    const buyerId = await seedBuyer(database.db);

    const rows = await asUser(database.dataApi, buyerId, async (tx) => {
      const result = await tx.query("select * from account_status where user_id = $1", [artistId]);
      return result.rows;
    });

    expect(rows).toEqual([]);
  });

  it("reads its own roles, so the policy is scoped and not simply closed", async () => {
    const buyerId = await seedBuyer(database.db);

    const rows = await asUser(database.dataApi, buyerId, async (tx) => {
      const result = await tx.query<{ role: string }>("select role from user_roles");
      return result.rows;
    });

    expect(rows).toEqual([{ role: "buyer" }]);
  });
});

describe("an artist reading their own data through the data API", () => {
  const database = useTestDatabase();

  it("cannot reach even their own contact details, because the grant is gone", async () => {
    // The self-policy on this table is the belt to the revoke's braces.
    // Postgres checks grants before policies, so the revoke wins and the table
    // is server-only. An artist edits these details through the application,
    // which is the path that also runs the contact scanner.
    const { artistId } = await seedArtistWithSecrets(database.db);

    await expect(
      asUser(database.dataApi, artistId, (tx) => tx.query("select * from artist_contact_details")),
    ).rejects.toThrow(/permission denied/i);
  });

  it("cannot reach their own bank details either", async () => {
    const { artistId } = await seedArtistWithSecrets(database.db);

    await expect(
      asUser(database.dataApi, artistId, (tx) => tx.query("select * from artist_payout_details")),
    ).rejects.toThrow(/permission denied/i);
  });

  it("is still readable through the privileged server connection", async () => {
    // Proves the data is actually there and the tests above are about access,
    // not about an empty table.
    const { artistId } = await seedArtistWithSecrets(database.db);

    const row = await database.db.one<{ phone: string; account_number: string }>(
      `select c.phone, p.account_number
       from artist_contact_details c join artist_payout_details p using (user_id)
       where c.user_id = $1`,
      [artistId],
    );

    expect(row).toEqual({ phone: SENTINEL.phone, account_number: SENTINEL.accountNumber });
  });
});
