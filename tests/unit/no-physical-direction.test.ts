import { RuleTester } from "eslint";
import { describe, it } from "vitest";
import rule from "../../eslint-rules/no-physical-direction.mjs";

// RuleTester needs `describe`/`it` from the test runner when it isn't run
// under its native Mocha-style globals.
RuleTester.describe = describe;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
RuleTester.it = it as any;

const ruleTester = new RuleTester({
  languageOptions: {
    ecmaVersion: 2022,
    sourceType: "module",
    parserOptions: {
      ecmaFeatures: { jsx: true },
    },
  },
});

ruleTester.run("no-physical-direction", rule, {
  valid: [
    // The logical replacements themselves must never be flagged.
    { code: '<div className="ms-4" />' },
    { code: '<div className="me-2 ps-3 pe-1" />' },
    { code: '<div className="border-e" />' },
    { code: '<div className="border-s-2" />' },
    { code: '<div className="rounded-s rounded-e-lg" />' },
    { code: '<div className="text-start text-end" />' },
    { code: '<div className="start-0 end-4" />' },
    // Substrings that merely resemble a physical prefix must not match.
    { code: '<div className="overflow-x-auto" />' },
    { code: '<div className="prose prose-lg" />' },
    { code: '<div className="border-red-500 border-rose-400" />' },
    { code: '<div className="rounded-lg rounded-full" />' },
    { code: '<div className="process-badge" />' },
    // Symmetric spacing (both sides) is not a physical-direction problem.
    { code: '<div className="px-4 py-2" />' },
    // Variant-prefixed logical utilities are fine too.
    { code: '<div className="md:ms-4 hover:pe-2" />' },
    // Non-className/class attributes are out of scope for this rule.
    { code: '<div data-align="pr-4 ml-2" />' },
    // Template literals with only logical utilities.
    { code: '<div className={`ms-4 ${extra}`} />' },
  ],
  invalid: [
    {
      code: '<div className="ml-4" />',
      errors: [{ messageId: "physicalDirection" }],
    },
    {
      code: '<div className="mr-2" />',
      errors: [{ messageId: "physicalDirection" }],
    },
    {
      code: '<div className="pl-3" />',
      errors: [{ messageId: "physicalDirection" }],
    },
    {
      code: '<div className="pr-3" />',
      errors: [{ messageId: "physicalDirection" }],
    },
    {
      code: '<div className="left-0" />',
      errors: [{ messageId: "physicalDirection" }],
    },
    {
      code: '<div className="-right-4" />',
      errors: [{ messageId: "physicalDirection" }],
    },
    {
      code: '<div className="text-left" />',
      errors: [{ messageId: "physicalDirection" }],
    },
    {
      code: '<div className="text-right" />',
      errors: [{ messageId: "physicalDirection" }],
    },
    {
      code: '<div className="border-l" />',
      errors: [{ messageId: "physicalDirection" }],
    },
    {
      code: '<div className="border-r-2" />',
      errors: [{ messageId: "physicalDirection" }],
    },
    {
      code: '<div className="rounded-l" />',
      errors: [{ messageId: "physicalDirection" }],
    },
    {
      code: '<div className="rounded-r-lg" />',
      errors: [{ messageId: "physicalDirection" }],
    },
    {
      code: '<div className="float-left" />',
      errors: [{ messageId: "physicalDirection" }],
    },
    {
      code: '<div className="float-right" />',
      errors: [{ messageId: "physicalDirection" }],
    },
    // Variant prefixes must still be caught.
    {
      code: '<div className="md:hover:pr-4" />',
      errors: [{ messageId: "physicalDirection" }],
    },
    // Multiple violations in one className are all reported.
    {
      code: '<div className="ml-2 mr-2 text-left" />',
      errors: [
        { messageId: "physicalDirection" },
        { messageId: "physicalDirection" },
        { messageId: "physicalDirection" },
      ],
    },
    // Plain `class` attribute (non-React markup) is checked too.
    {
      code: '<div class="pr-4" />',
      errors: [{ messageId: "physicalDirection" }],
    },
    // Template literal quasis are checked.
    {
      code: '<div className={`ml-4 ${extra}`} />',
      errors: [{ messageId: "physicalDirection" }],
    },
  ],
});
