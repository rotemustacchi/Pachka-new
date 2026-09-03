/**
 * /studio — the artist's own listings.
 *
 * Task 3.10's tail: the dashboard API was built and tested, and nothing
 * mounted it. This route reads the session, calls `artistDashboard`, and
 * renders. It makes no query of its own.
 *
 * An unauthenticated visitor is redirected to sign in rather than shown a
 * not-found. The asymmetry with the admin surfaces is deliberate and both
 * halves are specified: /studio is a page every artist knows exists and being
 * told to sign in is the useful answer, whereas the admin queue must not
 * confirm it exists at all (moderation-admin, and see src/app/admin/access.ts).
 */
import { artistDashboard } from "@/modules/artworks";
import { currentUserId, signedInOrRedirect } from "../_lib/viewer";
import { artworksDeps } from "./deps";
import { StudioDashboard } from "./StudioDashboard";

export const dynamic = "force-dynamic";

export const metadata = { title: "היצירות שלי — פאצ׳קה" };

export default async function StudioPage() {
  const artistId = signedInOrRedirect(await currentUserId());
  const dashboard = await artistDashboard(artworksDeps(), artistId);

  return <StudioDashboard dashboard={dashboard} />;
}
