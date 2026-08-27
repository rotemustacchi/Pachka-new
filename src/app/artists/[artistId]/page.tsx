/**
 * /artists/[artistId] — the public artist profile.
 *
 * accounts-and-profiles, "Public artist profile": a page for every artist with
 * at least one published artwork, showing display name, photo, biography, city
 * at city granularity, published artworks and buyer reviews. An artist with
 * nothing published is a not-found.
 *
 * ARCHITECTURE.md: routes parse input, call a module API, and render. The
 * not-found decision is not made here -- `findPublicArtist` returns null for an
 * artist who has published nothing, who is suspended, or who does not exist,
 * and this route turns all three into the same 404. Three different answers
 * would be an enumeration oracle: "suspended" tells a visitor something about
 * an account that "no such artist" does not.
 */
import { notFound } from "next/navigation";
import { getDatabase } from "@/shared/db";
import { findPublicArtist, getArtistReviews } from "@/modules/accounts";
import { ArtistProfileView } from "./ArtistProfileView";

export const dynamic = "force-dynamic";

interface PageProps {
  readonly params: Promise<{ readonly artistId: string }>;
}

export default async function ArtistProfilePage({ params }: PageProps) {
  const { artistId } = await params;

  // A malformed id is a 404, not a 500. Postgres would raise a type error on a
  // non-uuid, and an error page that differs from the not-found page is another
  // way to tell a prober that they got the shape right.
  if (!/^[0-9a-f-]{36}$/i.test(artistId)) notFound();

  const db = getDatabase();
  const artist = await findPublicArtist(db, artistId);
  if (!artist) notFound();

  const { reviews, summary } = await getArtistReviews(db, artistId);

  return <ArtistProfileView artist={artist} reviews={reviews} summary={summary} />;
}
