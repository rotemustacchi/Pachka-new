/**
 * "The system SHALL NOT initiate any transfer itself."
 *
 * `artist-payouts` states it twice -- once in the settlement requirement and
 * again as *No automated transfer*: "WHEN a payout becomes eligible THEN the
 * system notifies the operator but initiates no financial transaction."
 *
 * That is the kind of requirement that is true on the day it is written and
 * quietly false a year later, when somebody adds a bank API to "save the
 * operator a step". A runtime test cannot catch it -- the new code path would
 * simply not be taken by any existing test -- so this reads the module's own
 * source, the way `shipping/no-carrier-api.test.ts` does for carrier APIs.
 *
 * It doubles as the module-boundary check ARCHITECTURE.md asks for, and as the
 * standing proof of two claims this module makes about itself: that it writes
 * no other module's tables, and that it does not import `moderation` -- which is
 * the entire reason `AdminActionPort` exists.
 */
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const MODULE_DIR = path.join(process.cwd(), "src", "modules", "payouts");

function sourceFiles(): { name: string; text: string }[] {
  return readdirSync(MODULE_DIR)
    .filter((name) => name.endsWith(".ts") && !name.endsWith(".test.ts"))
    .map((name) => ({ name, text: readFileSync(path.join(MODULE_DIR, name), "utf8") }));
}

/** Strip comments, so the prose explaining a rule is not mistaken for a breach of it. */
function code(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/\/\/[^\n]*/g, " ");
}

describe("the payouts module", () => {
  it("has source files to check at all", () => {
    // Without this, every assertion below passes vacuously the day someone
    // moves or renames the module.
    expect(sourceFiles().length).toBeGreaterThan(8);
  });

  it("makes no outbound network call, to a bank or to anything else", () => {
    const offenders: string[] = [];
    const network = [
      /\bfetch\s*\(/,
      /\bXMLHttpRequest\b/,
      /from\s+["']node:https?["']/,
      /from\s+["'](axios|undici|got|node-fetch|stripe|@stripe\/[^"']+)["']/,
      /https?:\/\/[^\s"'`]+/,
    ];

    for (const file of sourceFiles()) {
      const body = code(file.text);
      for (const pattern of network) {
        if (pattern.test(body)) offenders.push(`${file.name}: ${pattern}`);
      }
    }

    expect(offenders, `outbound network in payouts: ${offenders.join(", ")}`).toEqual([]);
  });

  it("has no payment provider, and never captures, authorizes or transfers", () => {
    // `orders` legitimately has a `PaymentProvider` -- it takes the buyer's
    // money. `payouts` sends money the other way, and the MVP's answer to that
    // is a human at a bank. If any of these appear here, the answer changed.
    const offenders: string[] = [];
    const moving = [
      /\bPaymentProvider\b/,
      /\bcapture\s*\(/,
      /\bauthorize\s*\(/,
      /\binitiateTransfer\b/,
      /\bcreateTransfer\b/,
      /\bcreatePayout\b/,
    ];

    for (const file of sourceFiles()) {
      const body = code(file.text);
      for (const pattern of moving) {
        if (pattern.test(body)) offenders.push(`${file.name}: ${pattern}`);
      }
    }

    expect(offenders, `a money-moving call appeared in payouts: ${offenders.join(", ")}`).toEqual(
      [],
    );
  });

  it("writes no table it does not own", () => {
    // ARCHITECTURE.md: "A module owns its own tables. No module writes another
    // module's tables." `payouts` owns exactly one, `payout_ledger`. Everything
    // else it touches -- fulfilments, orders, order_transitions, returns,
    // artist_payout_details, admin_audit -- it reads.
    const offenders: string[] = [];
    const writes =
      /\b(insert\s+into|update|delete\s+from)\s+([a-z_]+)/gi;
    let ownWrites = 0;

    for (const file of sourceFiles()) {
      const body = code(file.text);
      for (const match of body.matchAll(writes)) {
        const table = (match[2] ?? "").toLowerCase();
        if (table === "payout_ledger") ownWrites += 1;
        else offenders.push(`${file.name}: ${match[1]} ${table}`);
      }
    }

    expect(offenders, `payouts wrote a table it does not own: ${offenders.join(", ")}`).toEqual([]);
    // Positive control: the scan really does find writes. Without it, a regex
    // that matched nothing would report a perfectly clean module forever.
    expect(ownWrites).toBeGreaterThanOrEqual(3);
  });

  it("never selects a bank detail outside the one file that is allowed to", () => {
    // SECURITY.md S1-11. `bank-details.ts` is the only file that may name that
    // table; everything else in the module works from a boolean or a masked
    // shape, so there is no account number in scope to leak.
    const offenders = sourceFiles()
      .filter((file) => file.name !== "bank-details.ts")
      .filter((file) => /artist_payout_details|account_number/i.test(code(file.text)))
      .map((file) => file.name);

    expect(offenders, `bank details reached outside bank-details.ts: ${offenders.join(", ")}`)
      .toEqual([]);
  });

  it("logs nothing, because the settlement flow is where a debug line gets added", () => {
    // SECURITY.md S1-11 item 1 names the scenario exactly: "the settlement flow
    // is exactly where a developer adds `console.log(payout)` to debug."
    const offenders: string[] = [];
    for (const file of sourceFiles()) {
      if (/\bconsole\s*\.\s*(log|info|warn|error|debug|dir|table)\b/.test(code(file.text))) {
        offenders.push(file.name);
      }
    }

    expect(offenders, `a logging call appeared in payouts: ${offenders.join(", ")}`).toEqual([]);
  });

  it("imports only shared code, its own files, and the modules it is allowed to call", () => {
    // ARCHITECTURE.md's dependency table: payouts may call `orders` and
    // `accounts`, and nothing else. Notably NOT `moderation` -- which is why
    // `AdminActionPort` exists and why `moderation-port.ts` restates a shape
    // rather than importing it.
    const offenders: string[] = [];
    const imports = /from\s+["']([^"']+)["']/g;

    for (const file of sourceFiles()) {
      for (const match of code(file.text).matchAll(imports)) {
        const target = match[1] ?? "";
        const allowed =
          target.startsWith("./") ||
          target.startsWith("@/shared/") ||
          target === "@/modules/orders" ||
          target === "@/modules/accounts" ||
          target.startsWith("node:");
        if (!allowed) offenders.push(`${file.name}: ${target}`);
      }
    }

    expect(offenders, `boundary violation in payouts: ${offenders.join(", ")}`).toEqual([]);

    // Positive control, and a standing statement of fact: this module currently
    // imports NOTHING from another module. `orders` and `accounts` are permitted
    // and unused -- what it needs from them, it reads as rows.
    const moduleImports = sourceFiles().flatMap((file) =>
      [...code(file.text).matchAll(imports)]
        .map((match) => match[1] ?? "")
        .filter((target) => target.startsWith("@/modules/")),
    );
    expect(moduleImports).toEqual([]);
  });

  it("does not reach for shared/money's float-rate commission split", () => {
    // The whole point of `commission.ts`. `splitCommission` takes a rate in
    // [0, 1], which means 1500 bp becomes 0.15 -- a float -- and rounds half
    // away from zero rather than flooring. Either would be a silent change to
    // what an artist is paid, so importing it here is a defect, not a style
    // choice. `commission.test.ts` may import it, to demonstrate the divergence.
    const offenders = sourceFiles()
      .filter((file) => /\bsplitCommission\b(?!Bp)/.test(code(file.text)))
      .map((file) => file.name);

    expect(offenders, `shared/money.splitCommission used in payouts: ${offenders.join(", ")}`)
      .toEqual([]);
  });
});
