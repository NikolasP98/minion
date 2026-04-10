/**
 * SIP Bridge — Twilio SIP trunk → LiveKit SIP gateway adapter.
 *
 * Architecture:
 *   Phone call → Twilio SIP trunk → LiveKit SIP gateway → VoicePipelineAgent
 *
 * This module handles:
 *  1. Twilio TwiML webhook responses for inbound/outbound SIP calls
 *  2. Generating LiveKit SIP participant credentials for Twilio trunk
 *  3. Routing Twilio call events to the correct VoicePipelineAgent session
 *
 * Twilio SIP → LiveKit flow:
 *  - Twilio receives incoming call on a DID/SIP trunk
 *  - Twilio webhook (handled here) responds with TwiML `<Dial><Sip>` pointing
 *    at the LiveKit SIP gateway URL with a signed auth token
 *  - LiveKit SIP gateway adds the caller as a room participant
 *  - The VoicePipelineAgent already running in the room handles the call
 */

import { createSubsystemLogger } from "../logging/subsystem.js";
import {
  generateRoomToken,
  loadLiveKitConfig,
  roomNameForSession,
  type LiveKitConfig,
} from "../config/livekit.js";
import { type TwilioSipConfig } from "./voice-pipeline-config.js";

const log = createSubsystemLogger("livekit-sip");

// -----------------------------------------------------------------------------
// Types
// -----------------------------------------------------------------------------

export type SipCallDirection = "inbound" | "outbound";

export type SipCallInfo = {
  callSid: string;
  direction: SipCallDirection;
  from: string;
  to: string;
  sessionId: string;
  roomName: string;
};

export type TwimlResponse = {
  /** TwiML XML string to send back to Twilio */
  twiml: string;
  /** HTTP status code (default 200) */
  statusCode?: number;
};

export type SipBridgeOptions = {
  config: TwilioSipConfig;
  /**
   * LiveKit SIP gateway hostname.
   * Defaults to LIVEKIT_SIP_HOST env var or "sip.livekit.io".
   */
  livekitSipHost?: string;
};

// -----------------------------------------------------------------------------
// Twilio request validation
// -----------------------------------------------------------------------------

/**
 * Validate that an inbound webhook request genuinely came from Twilio by
 * verifying the X-Twilio-Signature header against the auth token.
 *
 * Note: signature validation requires the full public URL of the webhook
 * endpoint plus the sorted POST body parameters.
 */
export async function validateTwilioSignature(
  authToken: string,
  signature: string,
  url: string,
  params: Record<string, string>,
): Promise<boolean> {
  // Build the validation string: URL + sorted params concatenated
  const sortedKeys = Object.keys(params).sort();
  const paramString = sortedKeys.map((k) => `${k}${params[k]}`).join("");
  const validationString = url + paramString;

  // HMAC-SHA1 using Web Crypto
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(authToken),
    { name: "HMAC", hash: "SHA-1" },
    false,
    ["sign"],
  );

  const signatureBytes = await crypto.subtle.sign(
    "HMAC",
    key,
    encoder.encode(validationString),
  );

  const expectedSignature = Buffer.from(signatureBytes).toString("base64");
  return expectedSignature === signature;
}

// -----------------------------------------------------------------------------
// SipBridge
// -----------------------------------------------------------------------------

export class SipBridge {
  private readonly config: TwilioSipConfig;
  private readonly livekitSipHost: string;
  private livekitConfig: LiveKitConfig | null = null;

  constructor(opts: SipBridgeOptions) {
    this.config = opts.config;
    this.livekitSipHost =
      opts.livekitSipHost ??
      process.env.LIVEKIT_SIP_HOST ??
      "sip.livekit.io";
  }

  // ---------------------------------------------------------------------------
  // Inbound call handling
  // ---------------------------------------------------------------------------

  /**
   * Handle an inbound Twilio SIP/PSTN webhook.
   *
   * Twilio calls this URL when a call arrives on the configured SIP trunk.
   * Returns TwiML that bridges the caller into the LiveKit room.
   *
   * @param callSid - Twilio CallSid from the webhook
   * @param from - Caller phone number or SIP URI
   * @param to - Dialled number or SIP URI
   * @param sessionId - The Minion session ID to route this call to
   */
  async handleInboundCall(
    callSid: string,
    from: string,
    to: string,
    sessionId: string,
  ): Promise<TwimlResponse> {
    log.info(`Inbound SIP call ${callSid}: ${from} → ${to}`);

    const lk = await this.getLiveKitConfig();
    const roomName = roomNameForSession(sessionId);

    // Generate a short-lived token for the SIP participant
    let sipToken: string;
    try {
      sipToken = await generateRoomToken(lk, roomName, {
        identity: `sip-${callSid}`,
        name: from,
        ttlSec: 3600,
      });
    } catch (err) {
      log.error(
        `Failed to generate SIP token for ${callSid}: ${err instanceof Error ? err.message : String(err)}`,
      );
      return {
        twiml: this.buildTwimlError("Service temporarily unavailable"),
        statusCode: 503,
      };
    }

    // Build the LiveKit SIP URI: sip:<room>@<host>?access_token=<token>
    const sipUri = `sip:${encodeURIComponent(roomName)}@${this.livekitSipHost}?access_token=${encodeURIComponent(sipToken)}`;

    const twiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Dial>
    <Sip>${sipUri}</Sip>
  </Dial>
</Response>`;

    log.info(`Routing call ${callSid} to LiveKit room ${roomName}`);
    return { twiml };
  }

  // ---------------------------------------------------------------------------
  // Outbound call handling
  // ---------------------------------------------------------------------------

  /**
   * Initiate an outbound call from the LiveKit SIP gateway to a phone number.
   *
   * Uses the Twilio REST API to place the call, instructing Twilio to connect
   * the answered call to the LiveKit SIP gateway.
   *
   * @param toNumber - E.164 destination phone number
   * @param sessionId - Minion session that will handle the call
   * @param webhookUrl - Public URL for Twilio status callback
   */
  async initiateOutboundCall(
    toNumber: string,
    sessionId: string,
    webhookUrl: string,
  ): Promise<{ callSid: string } | { error: string }> {
    const { accountSid, authToken, fromNumber } = this.resolveTwilioCredentials();
    if (!accountSid || !authToken) {
      return { error: "Twilio credentials not configured" };
    }
    if (!fromNumber) {
      return { error: "Twilio fromNumber not configured" };
    }

    const lk = await this.getLiveKitConfig();
    const roomName = roomNameForSession(sessionId);
    let sipToken: string;
    try {
      sipToken = await generateRoomToken(lk, roomName, {
        identity: `sip-out-${sessionId}`,
        name: toNumber,
        ttlSec: 3600,
      });
    } catch (err) {
      return {
        error: `Failed to generate SIP token: ${err instanceof Error ? err.message : String(err)}`,
      };
    }

    const sipUri = `sip:${encodeURIComponent(roomName)}@${this.livekitSipHost}?access_token=${encodeURIComponent(sipToken)}`;

    // TwiML that Twilio executes when the call is answered
    const twiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Dial>
    <Sip>${sipUri}</Sip>
  </Dial>
</Response>`;

    // Encode TwiML as a data URI for the Twilio call API
    const twimlBase64 = Buffer.from(twiml).toString("base64");
    const twimlParam = `data:text/xml;base64,${twimlBase64}`;

    const body = new URLSearchParams({
      To: toNumber,
      From: fromNumber,
      Twiml: twimlParam,
      StatusCallback: webhookUrl,
      StatusCallbackMethod: "POST",
    });

    const response = await fetch(
      `https://api.twilio.com/2010-04-01/Accounts/${accountSid}/Calls.json`,
      {
        method: "POST",
        headers: {
          Authorization: `Basic ${Buffer.from(`${accountSid}:${authToken}`).toString("base64")}`,
          "Content-Type": "application/x-www-form-urlencoded",
        },
        body: body.toString(),
      },
    );

    if (!response.ok) {
      const text = await response.text();
      log.error(`Twilio outbound call failed ${response.status}: ${text}`);
      return { error: `Twilio API error ${response.status}` };
    }

    const data = (await response.json()) as { sid?: string };
    if (!data.sid) {
      return { error: "Twilio API did not return a CallSid" };
    }

    log.info(`Outbound call placed: ${data.sid} → ${toNumber} → room ${roomName}`);
    return { callSid: data.sid };
  }

  // ---------------------------------------------------------------------------
  // Status callback
  // ---------------------------------------------------------------------------

  /**
   * Handle a Twilio call status webhook (call progress events).
   * Returns the call info extracted from the payload.
   */
  handleStatusCallback(params: Record<string, string>): Partial<SipCallInfo> {
    const callSid = params["CallSid"] ?? "";
    const status = params["CallStatus"] ?? "";
    log.debug(`Status callback for ${callSid}: ${status}`);
    return { callSid };
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  private async getLiveKitConfig(): Promise<LiveKitConfig> {
    if (!this.livekitConfig) {
      this.livekitConfig = loadLiveKitConfig();
    }
    return this.livekitConfig;
  }

  private resolveTwilioCredentials(): {
    accountSid: string | undefined;
    authToken: string | undefined;
    fromNumber: string | undefined;
  } {
    return {
      accountSid: this.config.accountSid ?? process.env.TWILIO_ACCOUNT_SID,
      authToken: this.config.authToken ?? process.env.TWILIO_AUTH_TOKEN,
      fromNumber: this.config.fromNumber ?? process.env.TWILIO_FROM_NUMBER,
    };
  }

  private buildTwimlError(message: string): string {
    return `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say>${message}</Say>
  <Hangup/>
</Response>`;
  }
}
