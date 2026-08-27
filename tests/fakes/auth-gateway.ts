/**
 * A deterministic stand-in for Supabase Auth.
 *
 * This is the ONLY thing the accounts tests fake. ARCHITECTURE.md's test policy
 * allows fakes for external boundaries -- the AI provider, mail, payment -- and
 * for nothing else. Supabase Auth qualifies: it is a separate service that owns
 * password hashes and session tokens. Everything on PACHKA's side of that line
 * runs against a real Postgres.
 *
 * It behaves like the real thing in the ways the tests depend on: an address
 * that already exists is a refusal rather than an exception, sign-in fails
 * without saying which half was wrong, and a user starts unverified.
 *
 * Construct a new one per test. It holds state, so sharing one between tests
 * would reintroduce exactly the ordering coupling the harness removes.
 */
import { randomUUID } from "node:crypto";
import type { AuthGateway, AuthUser, CreateUserOutcome } from "@/modules/accounts";

interface Record_ {
  id: string;
  email: string;
  password: string;
  emailVerifiedAt: Date | null;
}

export class FakeAuthGateway implements AuthGateway {
  private readonly users = new Map<string, Record_>();

  /** Addresses that have been sent a verification email, in order. */
  readonly verificationEmails: string[] = [];
  /** Addresses that have been sent a password-reset link, in order. */
  readonly passwordResets: string[] = [];
  /** Accounts whose sessions have been revoked, in order. */
  readonly revoked: string[] = [];
  signedOut = 0;

  private key(email: string): string {
    return email.trim().toLowerCase();
  }

  async createUser(email: string, password: string): Promise<CreateUserOutcome> {
    const key = this.key(email);
    if (this.users.has(key)) return { created: false };

    const record: Record_ = { id: randomUUID(), email: key, password, emailVerifiedAt: null };
    this.users.set(key, record);
    return { created: true, user: this.toUser(record) };
  }

  async signInWithPassword(email: string, password: string): Promise<AuthUser | null> {
    const record = this.users.get(this.key(email));
    if (!record || record.password !== password) return null;
    return this.toUser(record);
  }

  async signOut(): Promise<void> {
    this.signedOut += 1;
  }

  async revokeAllSessions(userId: string): Promise<void> {
    this.revoked.push(userId);
  }

  async sendVerificationEmail(userId: string): Promise<void> {
    const record = this.byId(userId);
    if (record) this.verificationEmails.push(record.email);
  }

  async requestPasswordReset(email: string): Promise<void> {
    // Records the attempt whether or not the address exists, like the real
    // service, so a test cannot accidentally assert on the difference.
    this.passwordResets.push(this.key(email));
  }

  async getUser(userId: string): Promise<AuthUser | null> {
    const record = this.byId(userId);
    return record ? this.toUser(record) : null;
  }

  // ---- test controls, not part of AuthGateway ----

  /** Mark an address confirmed, as clicking the link in the email would. */
  confirmEmail(email: string, at = new Date()): void {
    const record = this.users.get(this.key(email));
    if (!record) throw new Error(`FakeAuthGateway: no user for ${email}`);
    record.emailVerifiedAt = at;
  }

  /** The provider-side id for an address. */
  idFor(email: string): string {
    const record = this.users.get(this.key(email));
    if (!record) throw new Error(`FakeAuthGateway: no user for ${email}`);
    return record.id;
  }

  private byId(userId: string): Record_ | undefined {
    for (const record of this.users.values()) if (record.id === userId) return record;
    return undefined;
  }

  private toUser(record: Record_): AuthUser {
    return { id: record.id, email: record.email, emailVerifiedAt: record.emailVerifiedAt };
  }
}
