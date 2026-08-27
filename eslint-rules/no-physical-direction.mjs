/**
 * Local ESLint rule: no-physical-direction
 *
 * PACHKA is RTL-first (see ARCHITECTURE.md, task 1.2). A physical-direction
 * Tailwind utility (`ml-`, `pr-`, `text-left`, `border-r`, ...) hard-codes a
 * side that flips under `dir="rtl"`, silently breaking layout in Hebrew. This
 * rule reports those utilities wherever they appear in a JSX `className` (or
 * a plain `class`) string, and names the logical replacement the author
 * should use instead.
 *
 * Only whole utility tokens are matched (variants like `md:` / `hover:` /
 * `dark:` are stripped first), so this does not flag substrings that merely
 * contain a physical-looking prefix — `overflow-x-auto`, `prose`, `border-red-500`,
 * and `rounded-lg` are all left alone. See the RuleTester suite at
 * tests/unit/no-physical-direction.test.ts for the full set of cases proven
 * safe and unsafe.
 */

/** @type {ReadonlyArray<{ test: (token: string) => boolean; logical: string }>} */
const CHECKS = [
  { test: (t) => /^-?ml(-|$)/.test(t), logical: "ms- (margin-inline-start)" },
  { test: (t) => /^-?mr(-|$)/.test(t), logical: "me- (margin-inline-end)" },
  { test: (t) => /^-?pl(-|$)/.test(t), logical: "ps- (padding-inline-start)" },
  { test: (t) => /^-?pr(-|$)/.test(t), logical: "pe- (padding-inline-end)" },
  { test: (t) => /^-?left(-|$)/.test(t), logical: "start- (inset-inline-start)" },
  { test: (t) => /^-?right(-|$)/.test(t), logical: "end- (inset-inline-end)" },
  { test: (t) => /^text-left$/.test(t), logical: "text-start" },
  { test: (t) => /^text-right$/.test(t), logical: "text-end" },
  { test: (t) => /^border-l(-|$)/.test(t), logical: "border-s (border-inline-start)" },
  { test: (t) => /^border-r(-|$)/.test(t), logical: "border-e (border-inline-end)" },
  { test: (t) => /^rounded-l(-|$)/.test(t), logical: "rounded-s (border-start-*-radius)" },
  { test: (t) => /^rounded-r(-|$)/.test(t), logical: "rounded-e (border-end-*-radius)" },
  {
    test: (t) => /^float-left$/.test(t),
    logical: "an inline-start alignment (float has no bundled logical utility — prefer flex + justify-start/order, or float-start if your Tailwind build supports it)",
  },
  {
    test: (t) => /^float-right$/.test(t),
    logical: "an inline-end alignment (float has no bundled logical utility — prefer flex + justify-end/order, or float-end if your Tailwind build supports it)",
  },
];

/**
 * A Tailwind class token may be prefixed with any number of `variant:`
 * segments (`md:`, `hover:`, `dark:`, `md:hover:`, ...). The utility itself
 * never contains a colon, so the substring after the last colon is always
 * the part we need to test — regardless of how many variants precede it.
 */
function baseUtility(token) {
  const index = token.lastIndexOf(":");
  return index === -1 ? token : token.slice(index + 1);
}

function findViolation(token) {
  const base = baseUtility(token);
  for (const check of CHECKS) {
    if (check.test(base)) return check;
  }
  return null;
}

/**
 * Report every physical-direction token in a class string, anchored at the
 * given node with an offset so the error underlines just that token.
 */
function checkClassValue(context, node, value, valueStartOffset) {
  const tokenPattern = /\S+/g;
  let match;
  while ((match = tokenPattern.exec(value)) !== null) {
    const token = match[0];
    const violation = findViolation(token);
    if (!violation) continue;

    const start = valueStartOffset + match.index;
    const end = start + token.length;
    context.report({
      loc: {
        start: context.sourceCode.getLocFromIndex(start),
        end: context.sourceCode.getLocFromIndex(end),
      },
      messageId: "physicalDirection",
      data: { token, logical: violation.logical },
    });
  }
}

/** @type {import("eslint").Rule.RuleModule} */
const rule = {
  meta: {
    type: "problem",
    docs: {
      description:
        "disallow physical-direction Tailwind utilities (ml-, pr-, text-left, border-r, ...) in favour of RTL-safe logical properties",
    },
    schema: [],
    messages: {
      physicalDirection:
        'Physical-direction utility "{{token}}" hard-codes a side that flips under RTL. Use the logical equivalent instead: {{logical}}.',
    },
  },
  create(context) {
    return {
      JSXAttribute(node) {
        if (node.name.type !== "JSXIdentifier") return;
        if (node.name.name !== "className" && node.name.name !== "class") return;

        const value = node.value;
        if (!value) return;

        if (value.type === "Literal" && typeof value.value === "string") {
          // +1 skips the opening quote of the string literal.
          checkClassValue(context, node, value.value, value.range[0] + 1);
          return;
        }

        if (value.type === "JSXExpressionContainer") {
          const expression = value.expression;
          if (expression.type === "Literal" && typeof expression.value === "string") {
            checkClassValue(context, node, expression.value, expression.range[0] + 1);
          } else if (expression.type === "TemplateLiteral") {
            for (const quasi of expression.quasis) {
              // +1 skips the backtick / `}` delimiter preceding this quasi.
              checkClassValue(context, node, quasi.value.raw, quasi.range[0] + 1);
            }
          }
        }
      },
    };
  },
};

export default rule;
