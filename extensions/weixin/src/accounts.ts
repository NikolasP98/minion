import type { MinionbotConfig } from "minion/plugin-sdk";
import { DEFAULT_ACCOUNT_ID, normalizeAccountId } from "minion/plugin-sdk/account-id";
import type {
  WeixinConfig,
  WeixinAccountConfig,
  ResolvedWeixinAccount,
} from "./types.js";

const DEFAULT_BASE_URL = "https://ilinkai.weixin.qq.com";
const DEFAULT_POLL_TIMEOUT_SEC = 35;

/**
 * List all configured account IDs from the accounts field.
 */
function listConfiguredAccountIds(cfg: MinionbotConfig): string[] {
  const accounts = (cfg.channels?.weixin as WeixinConfig)?.accounts;
  if (!accounts || typeof accounts !== "object") {
    return [];
  }
  return Object.keys(accounts).filter(Boolean);
}

/**
 * List all Weixin account IDs.
 * Returns [DEFAULT_ACCOUNT_ID] if no named accounts are configured.
 */
export function listWeixinAccountIds(cfg: MinionbotConfig): string[] {
  const ids = listConfiguredAccountIds(cfg);
  if (ids.length === 0) {
    return [DEFAULT_ACCOUNT_ID];
  }
  return [...ids].toSorted((a, b) => a.localeCompare(b));
}

/**
 * Resolve the default account ID.
 */
export function resolveDefaultWeixinAccountId(cfg: MinionbotConfig): string {
  const ids = listWeixinAccountIds(cfg);
  if (ids.includes(DEFAULT_ACCOUNT_ID)) {
    return DEFAULT_ACCOUNT_ID;
  }
  return ids[0] ?? DEFAULT_ACCOUNT_ID;
}

/**
 * Get the raw account-specific config.
 */
function resolveAccountConfig(
  cfg: MinionbotConfig,
  accountId: string,
): WeixinAccountConfig | undefined {
  const accounts = (cfg.channels?.weixin as WeixinConfig)?.accounts;
  if (!accounts || typeof accounts !== "object") {
    return undefined;
  }
  return accounts[accountId];
}

/**
 * Merge top-level config with account-specific overrides.
 */
function mergeWeixinAccountConfig(cfg: MinionbotConfig, accountId: string): WeixinConfig {
  const weixinCfg = cfg.channels?.weixin as WeixinConfig | undefined;
  const { accounts: _ignored, ...base } = weixinCfg ?? {};
  const account = resolveAccountConfig(cfg, accountId) ?? {};
  return { ...base, ...account } as WeixinConfig;
}

/**
 * Resolve a complete Weixin account with merged config.
 */
export function resolveWeixinAccount(params: {
  cfg: MinionbotConfig;
  accountId?: string | null;
}): ResolvedWeixinAccount {
  const accountId = normalizeAccountId(params.accountId);
  const weixinCfg = params.cfg.channels?.weixin as WeixinConfig | undefined;

  const baseEnabled = weixinCfg?.enabled !== false;
  const merged = mergeWeixinAccountConfig(params.cfg, accountId);
  const accountEnabled = merged.enabled !== false;
  const enabled = baseEnabled && accountEnabled;

  const botToken = merged.botToken?.trim() || undefined;

  return {
    accountId,
    enabled,
    configured: Boolean(botToken),
    name: (merged as WeixinAccountConfig).name?.trim() || undefined,
    botToken,
    baseUrl: merged.baseUrl?.trim() || DEFAULT_BASE_URL,
    pollTimeoutSec: merged.pollTimeoutSec ?? DEFAULT_POLL_TIMEOUT_SEC,
    config: merged,
  };
}

/**
 * List all enabled and configured accounts.
 */
export function listEnabledWeixinAccounts(cfg: MinionbotConfig): ResolvedWeixinAccount[] {
  return listWeixinAccountIds(cfg)
    .map((accountId) => resolveWeixinAccount({ cfg, accountId }))
    .filter((account) => account.enabled && account.configured);
}
