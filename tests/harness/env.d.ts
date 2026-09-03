declare module "vitest" {
  export interface ProvidedContext {
    /** Superuser. Creates and drops test databases; see `privileged.ts`. */
    pachkaAdminUrl: string;
    /** The server's own connection role: non-superuser, member of service_role. */
    pachkaAppUrl: string;
    /** PostgREST's authenticator: non-superuser, member of anon/authenticated. */
    pachkaDataApiUrl: string;
    pachkaTemplate: string;
  }
}

export {};
