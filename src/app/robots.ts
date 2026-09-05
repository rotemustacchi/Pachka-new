/**
 * /robots.txt
 *
 * WHY THIS FILE EXISTS AT ALL
 * ---------------------------
 * design.md chose Option B — a browsable catalog alongside the matchmaker —
 * over a matchmaker-only homepage specifically so that PACHKA has an indexable
 * surface: a questionnaire behind a button ranks for nothing, while a page per
 * artwork ranks for the artist's name and the work's title. So the catalog and
 * the artwork pages are the whole SEO case, and this file's job is to keep
 * everything else out of the index without hiding them.
 *
 * WHAT IS DISALLOWED, AND WHY EACH ONE
 * ------------------------------------
 *   /admin, /studio    operator and artist workspaces. Nothing here is public,
 *                      and a crawler following /studio would index an empty
 *                      signed-out shell under a URL that means something else
 *                      to a signed-in artist.
 *   /checkout, /orders one visitor's cart and one buyer's order. Indexing a
 *                      per-buyer URL is the failure mode that puts an order
 *                      into someone else's search results.
 *   /certificates      certificate-verification pages. The identifiers are
 *                      unguessable BY DESIGN and the endpoint is rate limited
 *                      so the space cannot be enumerated — a crawler that
 *                      discovered one identifier and published it would undo
 *                      that, and a sitemap-less unguessable URL is only
 *                      unguessable until something links to it.
 *   auth routes        sign-in, register, reset-password. Thin, duplicated,
 *                      and worth nothing in an index.
 *   /match/search,
 *   /match/notify      route handlers, not pages. `/match` itself is public and
 *                      deliberately left crawlable: it is the product's front
 *                      door and it needs no account.
 *
 * A `Disallow` is not access control. Every one of these paths is protected by
 * its own authorisation check; this file only keeps well-behaved crawlers from
 * spending crawl budget on them and from putting them in front of the wrong
 * person. `/api`-shaped secrets are not defended here and are not defended by
 * being omitted here either.
 */
import type { MetadataRoute } from "next";
import { publicEnv } from "@/shared/config/env";

/** Paths no crawler should index. Kept in one list so the sitemap test can assert against it. */
export const DISALLOWED_PATHS = [
  "/admin",
  "/studio",
  "/checkout",
  "/orders",
  "/certificates",
  "/sign-in",
  "/register",
  "/reset-password",
  "/match/search",
  "/match/notify",
] as const;

export default function robots(): MetadataRoute.Robots {
  const siteUrl = publicEnv().NEXT_PUBLIC_SITE_URL;

  return {
    rules: [
      {
        userAgent: "*",
        allow: "/",
        disallow: [...DISALLOWED_PATHS],
      },
    ],
    sitemap: new URL("/sitemap.xml", siteUrl).toString(),
    host: siteUrl,
  };
}
