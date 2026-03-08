/**
 * Auth providers configuration types.
 * Defines the new top-level `auth` config section for OAuth providers.
 *
 * SYNC: Fields here must also be added to:
 *  - AuthProvidersConfigSchema in src/config/zod-schema.auth-providers.ts
 */

/** OAuth callback server configuration (shared across all providers) */
export type AuthServerConfig = {
  /** Whether OAuth callback server is enabled (default: true) */
  enabled?: boolean;
  /** Port to bind OAuth callback server (default: DEFAULT_OAUTH_CALLBACK_PORT from port-defaults.ts) */
  port?: number;
  /** Host to bind OAuth callback server (default: "127.0.0.1") */
  bind?: string;
  /** OAuth callback endpoint path (default: "/oauth-callback") */
  callbackPath?: string;
  /** Timeout in minutes for pending OAuth flows (default: 5) */
  timeoutMinutes?: number;
};

/** Google OAuth provider configuration */
export type GoogleProviderConfig = {
  /**
   * Path to Google OAuth client credentials JSON file (downloaded from Google Cloud Console).
   * Supports both "installed" and "web" application types.
   */
  clientCredentialsFile?: string;
  /** Public redirect URI (e.g. Tailscale Funnel URL) for headless/remote OAuth flows */
  externalRedirectUri?: string;
};

/** Auth providers top-level configuration */
export type AuthProvidersConfig = {
  /** OAuth callback server settings (shared across providers) */
  server?: AuthServerConfig;
  /** Per-provider configuration */
  providers?: {
    /** Google OAuth provider settings */
    google?: GoogleProviderConfig;
  };
};
