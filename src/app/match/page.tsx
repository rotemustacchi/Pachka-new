/**
 * /match — the matchmaker, PACHKA's defining feature.
 *
 * ARCHITECTURE.md: routes parse input, call a module API, and render. This one
 * parses the URL into `URLSearchParams`, hashes the client's address, and hands
 * both to `MatchScreen`, which is where the fetch and the render live together
 * so that a test executes what a visitor receives.
 *
 * THE FINGERPRINT IS HASHED HERE, AT THE EDGE
 * -------------------------------------------
 * `matchmaker/index.ts` asks for exactly this — "a hashed client fingerprint
 * per request — `hashSubject` at the edge, so a raw IP never reaches this
 * module at all". SECURITY.md's log-redaction rule puts raw client IPs on the
 * never-stored list, and `match_queries.client_fingerprint` is a stored column,
 * so the hashing cannot be the module's job to remember.
 *
 * The viewer fingerprint is the same value today. The two are separate
 * parameters because a signed-in buyer has a session that outlives their
 * address; wiring that is a change here and nowhere else.
 */
import { hashSubject } from "@/modules/matchmaker";
import { getDatabase } from "@/shared/db";
import { catalogDeps } from "@/app/_lib/deps";
import { clientIp } from "@/app/_lib/request";
import { MatchScreen } from "./MatchScreen";

export const dynamic = "force-dynamic";

interface PageProps {
  readonly searchParams: Promise<Record<string, string | string[] | undefined>>;
}

/** `Record` in, `URLSearchParams` out — repeated answers survive as repeats. */
function toSearchParams(raw: Record<string, string | string[] | undefined>): URLSearchParams {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(raw)) {
    if (typeof value === "string") params.append(key, value);
    else if (Array.isArray(value)) for (const entry of value) params.append(key, entry);
  }
  return params;
}

export default async function MatchPage({ searchParams }: PageProps) {
  const params = toSearchParams(await searchParams);
  const fingerprint = hashSubject(await clientIp());
  const db = getDatabase();

  return (
    <MatchScreen
      deps={{ db }}
      catalog={catalogDeps(db)}
      params={params}
      clientFingerprint={fingerprint}
      viewerFingerprint={fingerprint}
    />
  );
}
