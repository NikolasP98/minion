import type {
  WeixinGetUpdatesResponse,
  WeixinSendRequest,
  WeixinSendResult,
} from "./types.js";

/**
 * Generate a random UIN-style anti-replay nonce for the X-WECHAT-UIN header.
 * The iLink API requires a base64-encoded random uint32 per request.
 */
function generateWechatUin(): string {
  const buf = new Uint8Array(4);
  crypto.getRandomValues(buf);
  return btoa(String.fromCharCode(...buf));
}

/**
 * Make an authenticated request to the iLink Bot API.
 */
async function ilinkRequest<T>(params: {
  baseUrl: string;
  botToken: string;
  path: string;
  method?: "GET" | "POST";
  body?: unknown;
  timeoutMs?: number;
}): Promise<T> {
  const { baseUrl, botToken, path, method = "POST", body, timeoutMs = 60_000 } = params;
  const url = `${baseUrl}${path}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(url, {
      method,
      headers: {
        "Content-Type": "application/json",
        AuthorizationType: "ilink_bot_token",
        Authorization: `Bearer ${botToken}`,
        "X-WECHAT-UIN": generateWechatUin(),
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: controller.signal,
    });

    if (!response.ok) {
      throw new Error(`iLink API ${path} returned ${response.status}: ${response.statusText}`);
    }

    return (await response.json()) as T;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Long-poll for new messages via iLink getupdates endpoint.
 * Holds connection for up to pollTimeoutSec (default 35s).
 */
export async function weixinGetUpdates(params: {
  baseUrl: string;
  botToken: string;
  cursor?: string;
  pollTimeoutSec?: number;
}): Promise<WeixinGetUpdatesResponse> {
  const { baseUrl, botToken, cursor, pollTimeoutSec = 35 } = params;
  const timeoutMs = (pollTimeoutSec + 10) * 1000; // extra buffer for network

  return ilinkRequest<WeixinGetUpdatesResponse>({
    baseUrl,
    botToken,
    path: "/ilink/bot/getupdates",
    body: {
      timeout: pollTimeoutSec,
      ...(cursor ? { get_updates_buf: cursor } : {}),
    },
    timeoutMs,
  });
}

/**
 * Send a message via iLink Bot API.
 */
export async function weixinSendMessage(params: {
  baseUrl: string;
  botToken: string;
  request: WeixinSendRequest;
}): Promise<WeixinSendResult> {
  const { baseUrl, botToken, request } = params;

  const result = await ilinkRequest<{ errcode?: number; errmsg?: string }>({
    baseUrl,
    botToken,
    path: "/ilink/bot/sendmessage",
    body: request,
  });

  if (result.errcode && result.errcode !== 0) {
    return { ok: false, error: result.errmsg ?? `errcode ${result.errcode}` };
  }
  return { ok: true };
}

/**
 * Health check: verify bot token is valid by attempting a lightweight API call.
 */
export async function weixinCheck(params: {
  baseUrl: string;
  botToken: string;
  timeoutMs?: number;
}): Promise<{ ok: boolean; error?: string; botUin?: string; botNickname?: string }> {
  const { baseUrl, botToken, timeoutMs = 10_000 } = params;

  try {
    const result = await ilinkRequest<{
      errcode?: number;
      errmsg?: string;
      bot_uin?: string;
      bot_nickname?: string;
    }>({
      baseUrl,
      botToken,
      path: "/ilink/bot/getbotinfo",
      timeoutMs,
    });

    if (result.errcode && result.errcode !== 0) {
      return { ok: false, error: result.errmsg ?? `errcode ${result.errcode}` };
    }

    return {
      ok: true,
      botUin: result.bot_uin,
      botNickname: result.bot_nickname,
    };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

/**
 * Initiate QR code login flow.
 * Returns base64-encoded QR code image data.
 */
export async function weixinGetLoginQrCode(params: {
  baseUrl: string;
}): Promise<{ qrcode?: string; error?: string }> {
  const { baseUrl } = params;

  try {
    const result = await ilinkRequest<{
      errcode?: number;
      errmsg?: string;
      qrcode?: string;
    }>({
      baseUrl,
      botToken: "",
      path: "/ilink/bot/get_bot_qrcode?bot_type=3",
      method: "GET",
    });

    if (result.errcode && result.errcode !== 0) {
      return { error: result.errmsg ?? `errcode ${result.errcode}` };
    }

    return { qrcode: result.qrcode };
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * Poll QR code status until login is confirmed.
 */
export async function weixinGetQrCodeStatus(params: {
  baseUrl: string;
  qrcode: string;
}): Promise<{
  confirmed: boolean;
  botToken?: string;
  baseurl?: string;
  error?: string;
}> {
  const { baseUrl, qrcode } = params;

  try {
    const result = await ilinkRequest<{
      errcode?: number;
      errmsg?: string;
      status?: string;
      bot_token?: string;
      baseurl?: string;
    }>({
      baseUrl,
      botToken: "",
      path: `/ilink/bot/get_qrcode_status?qrcode=${encodeURIComponent(qrcode)}`,
      method: "GET",
    });

    if (result.status === "confirmed" && result.bot_token) {
      return {
        confirmed: true,
        botToken: result.bot_token,
        baseurl: result.baseurl,
      };
    }

    return { confirmed: false };
  } catch (err) {
    return { confirmed: false, error: err instanceof Error ? err.message : String(err) };
  }
}
