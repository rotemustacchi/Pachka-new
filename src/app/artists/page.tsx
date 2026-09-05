/**
 * /artists — the index the header links to.
 *
 * ARCHITECTURE.md: routes parse input, call a module API, and render. There is
 * no input here, so this route is the composition root's half of that sentence
 * and nothing else — `ArtistIndex.tsx` holds the read and the render together
 * so an integration test can execute what a visitor receives.
 */
import { catalogDeps } from "@/app/_lib/deps";
import { ArtistIndex, listPublishedArtists } from "./ArtistIndex";

export const dynamic = "force-dynamic";
export const metadata = { title: "אמנים — פאצ׳קה" };

export default async function ArtistsPage() {
  return <ArtistIndex artists={await listPublishedArtists(catalogDeps())} />;
}
