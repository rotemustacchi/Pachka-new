/**
 * `shared/config` — the typed `app_config` reader. ARCHITECTURE.md: "Every
 * configurable number lives in app_config, read through shared/config...
 * No magic numbers in module code."
 */
export { CONFIG_REGISTRY, isConfigKey, type ConfigKey, type ConfigKeyDef, type ConfigValue, type ConfigValueType } from "./registry";
export { getConfig, setConfig, invalidateConfig } from "./reader";
export { CONFIG_CACHE_TTL_MS } from "./cache";

// Environment configuration lives alongside config (both are "how does code
// get a setting"), so it is re-exported from the same public surface.
export { serverEnv, publicEnv, resetEnvCache, type ServerEnv, type PublicEnv } from "./env";
