/**
 * "This artist has something published" — for the accounts tests.
 *
 * The accounts module's visibility rule is that an artist profile is public
 * only when the artist has at least one published artwork and is not suspended
 * (accounts-and-profiles; SECURITY.md S1-13). `artworks` belongs to the
 * artworks module, so the accounts policy resolves that table at call time and
 * fails closed while it is absent.
 *
 * Ten teams are landing migrations into one directory in parallel, so the
 * accounts suite has to pass in both worlds: before the artworks migration
 * exists and after. This helper does whichever applies.
 *
 *   absent   -> create the two columns the accounts policy reads, and insert.
 *              Faithful to the contract, and nothing more.
 *   present  -> insert a genuinely complete published row, because the real
 *              table has a check constraint refusing `published` while any
 *              mandatory specification field is null.
 *
 * If the artworks team changes the contract this helper fails loudly, which is
 * correct: artist-profile visibility genuinely depends on their definition of
 * "published", and a silent false would turn every artist profile into a 404.
 */
import type { Database } from "@/shared/db";

async function artworksTableExists(db: Database): Promise<boolean> {
  const row = await db.one<{ present: boolean }>(
    "select to_regclass('public.artworks') is not null as present",
  );
  return row.present;
}

/** The two columns `accounts.artist_has_published_artwork()` reads. */
async function createStandIn(db: Database): Promise<void> {
  await db.query(`
    create table artworks (
      id        uuid primary key default gen_random_uuid(),
      artist_id uuid not null,
      status    text not null
    )
  `);
  await db.query("alter table artworks enable row level security");
  await db.query("alter table artworks force row level security");
  await db.query(
    "create policy artworks_stand_in_read on artworks for select to anon using (status = 'published')",
  );
}

/**
 * Give an artist one artwork in the given status.
 *
 * `medium` is `textile_clothing` on purpose: it is the one medium the real
 * table's publish constraint does not additionally require a depth or a framing
 * answer for, so the fixture stays as small as the constraint allows.
 */
export async function giveArtistAnArtwork(
  db: Database,
  artistId: string,
  status: "draft" | "published" = "published",
): Promise<void> {
  if (!(await artworksTableExists(db))) {
    await createStandIn(db);
    await db.query("insert into artworks (artist_id, status) values ($1, $2)", [artistId, status]);
    return;
  }

  if (status !== "published") {
    await db.query("insert into artworks (artist_id, status) values ($1, $2)", [artistId, status]);
    return;
  }

  await db.query(
    `insert into artworks (
       artist_id, status, title, description, price_agorot,
       height_mm, width_mm, weight_grams, materials, lead_time_days,
       medium, styles, moods,
       originality_declared_by, originality_declared_at, ai_assisted, published_at
     ) values (
       $1, 'published', 'קו החוף, שקיעה', 'אקריליק על פשתן.', 125000,
       700, 500, 1200, 'אקריליק, פשתן', 7,
       'textile_clothing', array['minimalist']::text[], array['calm']::text[],
       $1, now(), false, now()
     )`,
    [artistId],
  );
}

/** Whether the real artworks migration is in the tree yet. */
export async function usingRealArtworksTable(db: Database): Promise<boolean> {
  if (!(await artworksTableExists(db))) return false;
  const row = await db.one<{ present: boolean }>(
    `select exists (
       select 1 from information_schema.columns
       where table_schema = 'public' and table_name = 'artworks' and column_name = 'price_agorot'
     ) as present`,
  );
  return row.present;
}
