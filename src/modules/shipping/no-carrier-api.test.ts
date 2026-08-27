/**
 * "Without calling any carrier API."
 *
 * `shipping-and-returns` states it twice, and it is the kind of requirement
 * that is true on the day it is written and quietly false a year later when
 * somebody adds a tracking lookup to "improve" the shipped notification. A
 * runtime test cannot catch that -- the code path would simply not be taken in
 * the test. So this reads the module's own source instead.
 *
 * It doubles as the module-boundary check ARCHITECTURE.md asks for: `shipping`
 * may import `shared/*` and `orders`' public API, and nothing else.
 */
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const MODULE_DIR = path.join(process.cwd(), "src", "modules", "shipping");

function sourceFiles(): { name: string; text: string }[] {
  return readdirSync(MODULE_DIR)
    .filter((name) => name.endsWith(".ts") && !name.endsWith(".test.ts"))
    .map((name) => ({ name, text: readFileSync(path.join(MODULE_DIR, name), "utf8") }));
}

/** Strip comments, so the prose explaining the rule is not mistaken for a breach of it. */
function code(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/\/\/[^\n]*/g, " ");
}

describe("the shipping module", () => {
  it("has source files to check at all", () => {
    // Without this, every assertion below passes vacuously the day someone
    // moves the module.
    expect(sourceFiles().length).toBeGreaterThan(5);
  });

  it("makes no outbound network call, to a carrier or to anything else", () => {
    const offenders: string[] = [];
    const network = [
      /\bfetch\s*\(/,
      /\bXMLHttpRequest\b/,
      /from\s+["']node:https?["']/,
      /from\s+["'](axios|undici|got|node-fetch)["']/,
      /https?:\/\/[^\s"'`]+/,
    ];

    for (const file of sourceFiles()) {
      const body = code(file.text);
      for (const pattern of network) {
        if (pattern.test(body)) offenders.push(`${file.name}: ${pattern}`);
      }
    }

    expect(offenders, `outbound network in shipping: ${offenders.join(", ")}`).toEqual([]);
  });

  it("imports only shared code, its own files, and the modules it is allowed to call", () => {
    const offenders: string[] = [];

    for (const file of sourceFiles()) {
      for (const match of code(file.text).matchAll(/from\s+["']([^"']+)["']/g)) {
        const specifier = match[1] ?? "";
        const allowed =
          specifier.startsWith("./") ||
          specifier.startsWith("../") ||
          specifier.startsWith("@/shared/") ||
          // ARCHITECTURE.md: shipping and orders are mutually visible by design.
          specifier === "@/modules/orders" ||
          specifier === "zod";
        if (!allowed) offenders.push(`${file.name} imports ${specifier}`);
      }
    }

    expect(offenders, `boundary violations: ${offenders.join(", ")}`).toEqual([]);
  });

  it("reads money out of the database through shared/money, never as a raw number", () => {
    // A `bigint` column arrives from node-postgres as a string. Parsing one with
    // Number() instead of fromDbValue() silently mangles anything above 2^53 and
    // skips the validation `shared/money` exists to apply.
    const offenders = sourceFiles()
      .filter((file) => /agorot/i.test(file.text))
      .filter((file) => /Number\s*\(\s*\w*[Aa]gorot/.test(code(file.text)))
      .map((file) => file.name);

    expect(offenders).toEqual([]);
  });
});
