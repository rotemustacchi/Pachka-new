/**
 * Swap the database name in a libpq connection URL, leaving credentials,
 * host (including a `?host=/unix/socket` override) and every other parameter
 * untouched.
 */
export function databaseUrl(baseUrl: string, database: string): string {
  const queryAt = baseUrl.indexOf("?");
  const head = queryAt === -1 ? baseUrl : baseUrl.slice(0, queryAt);
  const tail = queryAt === -1 ? "" : baseUrl.slice(queryAt);
  const authorityEnd = head.indexOf("/", "postgresql://".length);
  const authority = authorityEnd === -1 ? head : head.slice(0, authorityEnd);
  return `${authority}/${encodeURIComponent(database)}${tail}`;
}
