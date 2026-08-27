/**
 * `shared/money` — integer agorot. See ARCHITECTURE.md, "Non-negotiable
 * technical decisions": "Money is an integer count of agorot. Never a float,
 * never a decimal string."
 */
export { CURRENCY_SIGN } from "./constants";
export type { Agorot } from "./types";
export { agorot, nonNegativeAgorot, isAgorot, zeroAgorot } from "./types";
export { parseAgorot, type ParseAgorotOptions } from "./shekel-input";
export { formatAgorot, formatAgorotCompact } from "./format";
export {
  addAgorot,
  subtractAgorot,
  multiplyAgorot,
  splitCommission,
  type CommissionSplit,
} from "./arithmetic";
export { fromDbValue, toDbValue } from "./db";
