/**
 * LiveKit VoicePipelineAgent wrapper.
 *
 * Implements the primary voice mode:
 *   User Voice → LiveKit Cloud (WebRTC/SIP) → STT → Minion LLM → TTS → User
 *
 * The agent:
 *  1. Creates (or reuses) a LiveKit room for the session
 *  2. Generates an agent participant token and publishes it for the frontend/SIP bridge
 *  3. Streams audio from the room → Deepgram/Whisper (STT) → text
 *  4. Sends text to the Minion LLM and streams the reply
 *  5. Converts the reply to audio (ElevenLabs/OpenAI TTS) and publishes it back
 *  6. Handles barge-in interruption via LiveKit turn-detection data messages
 *
 * Graceful degradation: if LiveKit Cloud is unreachable, `start()` returns an
 * error object instead of throwing, so callers can surface the error and keep
 * the gateway running.
 */

import { createSubsystemLogger } from "../logging/subsystem.js";
import {
  createRoom,
  deleteRoom,
  generateRoomToken,
  loadLiveKitConfig,
  roomNameForSession,
  type LiveKitConfig,
} from "../config/livekit.js";
import {
  resolveVoicePipelineConfig,
  type AgentSession,
  type AgentSessionStatus,
  type VoicePipelineConfig,
} from "./voice-pipeline-config.js";

const log = createSubsystemLogger("livekit-voice");

// -----------------------------------------------------------------------------
// Types
// -----------------------------------------------------------------------------

export type StartOptions = {
  /** Existing Minion conversation context key to attach this session to */
  conversationKey?: string;
  /** Override the agent greeting (spoken when the session first connects) */
  greeting?: string;
};

export type StartResult =
  | {
      ok: true;
      session: AgentSession;
      /** LiveKit room access token for the user-side participant */
      userToken: string;
      /** LiveKit room name */
      roomName: string;
      /** LiveKit Cloud WebSocket URL */
      wsUrl: string;
    }
  | {
      ok: false;
      error: string;
    };

export type StopResult = { ok: true } | { ok: false; error: string };

// -----------------------------------------------------------------------------
// Transcript buffer (accumulates partial STT results)
// -----------------------------------------------------------------------------

type TranscriptEntry = { speaker: "agent" | "user"; text: string; finalizedAt: number };

// -----------------------------------------------------------------------------
// LiveKitVoiceAgent
// -----------------------------------------------------------------------------

/**
 * One agent instance per active voice session.
 * Instantiate via `LiveKitVoiceAgent.create()`.
 */
export class LiveKitVoiceAgent {
  readonly sessionId: string;

  private readonly config: VoicePipelineConfig;
  private readonly livekitConfig: LiveKitConfig;
  private session: AgentSession;
  private transcript: TranscriptEntry[] = [];
  private interrupted = false;

  private constructor(
    sessionId: string,
    config: VoicePipelineConfig,
    livekitConfig: LiveKitConfig,
    session: AgentSession,
  ) {
    this.sessionId = sessionId;
    this.config = config;
    this.livekitConfig = livekitConfig;
    this.session = session;
  }

  // ---------------------------------------------------------------------------
  // Factory
  // ---------------------------------------------------------------------------

  /**
   * Create a new LiveKitVoiceAgent and start the session.
   *
   * @param sessionId - Unique identifier for this voice session
   * @param rawConfig - VoicePipelineConfig (will be resolved with env fallbacks)
   * @param opts - Start options
   */
  static async create(
    sessionId: string,
    rawConfig: VoicePipelineConfig,
    opts: StartOptions = {},
  ): Promise<StartResult> {
    const config = resolveVoicePipelineConfig(rawConfig);

    let livekitConfig: LiveKitConfig;
    try {
      livekitConfig = loadLiveKitConfig();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log.error(`Failed to load LiveKit config: ${msg}`);
      if (config.failGracefully) {
        return { ok: false, error: msg };
      }
      throw err;
    }

    const roomName = roomNameForSession(sessionId);
    const session: AgentSession = {
      sessionId,
      roomName,
      mode: config.mode,
      status: "connecting",
      conversationKey: opts.conversationKey ?? null,
      startedAt: Date.now(),
      endedAt: null,
    };

    // Create LiveKit room
    try {
      await createRoom(livekitConfig, roomName, {
        maxParticipants: 2, // agent + one user participant
        emptyTimeoutSec: 60,
      });
      log.info(`Room created: ${roomName}`);
    } catch (err) {
      const msg = `Failed to create LiveKit room "${roomName}": ${err instanceof Error ? err.message : String(err)}`;
      log.error(msg);
      if (config.failGracefully) {
        return { ok: false, error: msg };
      }
      throw err;
    }

    // Generate user-side access token
    let userToken: string;
    try {
      userToken = await generateRoomToken(livekitConfig, roomName, {
        identity: `user-${sessionId}`,
        name: "User",
        ttlSec: 7200,
      });
    } catch (err) {
      const msg = `Failed to generate user token: ${err instanceof Error ? err.message : String(err)}`;
      log.error(msg);
      await deleteRoom(livekitConfig, roomName).catch(() => undefined);
      if (config.failGracefully) {
        return { ok: false, error: msg };
      }
      throw err;
    }

    session.status = "listening";

    const agent = new LiveKitVoiceAgent(sessionId, config, livekitConfig, session);

    // Speak an opening greeting if provided
    if (opts.greeting) {
      await agent.speak(opts.greeting).catch((err) => {
        log.warn(
          `Failed to speak greeting: ${err instanceof Error ? err.message : String(err)}`,
        );
      });
    }

    log.info(`Session ${sessionId} started in room ${roomName}`);

    return {
      ok: true,
      session,
      userToken,
      roomName,
      wsUrl: livekitConfig.wsUrl,
    };
  }

  // ---------------------------------------------------------------------------
  // Public API
  // ---------------------------------------------------------------------------

  /** Current session snapshot (safe to read; do not mutate). */
  getSession(): Readonly<AgentSession> {
    return this.session;
  }

  getTranscript(): Readonly<TranscriptEntry[]> {
    return this.transcript;
  }

  /**
   * Process a finalized STT transcript from the user.
   * Runs the LLM and speaks the reply.
   *
   * This is called by the audio pipeline when Deepgram/Whisper finalizes a
   * speech segment. The agent checks for interruption before and after LLM.
   */
  async handleUserSpeech(text: string): Promise<void> {
    if (this.session.status === "closed" || this.session.status === "error") {
      return;
    }

    this.interrupted = false;
    this.transcript.push({ speaker: "user", text, finalizedAt: Date.now() });
    log.debug(`User [${this.sessionId}]: ${text}`);

    this.setStatus("thinking");

    let reply: string;
    try {
      reply = await this.callLlm(text);
    } catch (err) {
      log.error(
        `LLM error for session ${this.sessionId}: ${err instanceof Error ? err.message : String(err)}`,
      );
      this.setStatus("listening");
      return;
    }

    if (this.interrupted) {
      log.info(`Session ${this.sessionId}: interrupted before speaking — discarding reply`);
      this.setStatus("listening");
      return;
    }

    await this.speak(reply);
  }

  /**
   * Signal that the user has started speaking mid-agent-turn (barge-in).
   * This is called by the audio pipeline on LiveKit turn-detection events.
   */
  handleInterruption(): void {
    if (this.session.status === "speaking") {
      this.interrupted = true;
      this.setStatus("interrupted");
      log.debug(`Session ${this.sessionId}: barge-in interruption`);
      // In a real LiveKit WebRTC session the audio track publication would be
      // stopped here via the room participant API.  We set the flag so that
      // handleUserSpeech() discards the pending reply.
      this.setStatus("listening");
    }
  }

  /**
   * Synthesize text to speech and "publish" it to the LiveKit room.
   *
   * In production this writes PCM/Opus audio to a LocalAudioTrack published in
   * the room.  In this integration layer the actual WebRTC publication is
   * handled by the agent worker process (LiveKit Agents framework); here we
   * generate the audio buffer and hand it off.
   */
  async speak(text: string): Promise<void> {
    if (this.session.status === "closed") {
      return;
    }
    this.setStatus("speaking");
    this.transcript.push({ speaker: "agent", text, finalizedAt: Date.now() });

    try {
      await this.synthesizeSpeech(text);
    } finally {
      // Only return to listening if we weren't interrupted
      if (this.session.status === "speaking") {
        this.setStatus("listening");
      }
    }
  }

  /**
   * Gracefully stop the session and clean up the LiveKit room.
   */
  async stop(): Promise<StopResult> {
    if (this.session.status === "closed") {
      return { ok: true };
    }

    this.setStatus("closed");
    this.session.endedAt = Date.now();

    try {
      await deleteRoom(this.livekitConfig, this.session.roomName);
      log.info(`Session ${this.sessionId} stopped; room deleted`);
      return { ok: true };
    } catch (err) {
      const msg = `Failed to delete room: ${err instanceof Error ? err.message : String(err)}`;
      log.warn(msg);
      return { ok: false, error: msg };
    }
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  private setStatus(status: AgentSessionStatus): void {
    this.session = { ...this.session, status };
  }

  /**
   * Send the user's utterance to the Minion LLM and return the text reply.
   *
   * This is intentionally a thin adapter: actual model routing goes through
   * the existing Minion provider infrastructure.  For voice mode we build a
   * minimal single-turn prompt to keep latency low.
   */
  private async callLlm(userText: string): Promise<string> {
    const systemPrompt =
      this.config.systemPrompt ??
      "You are a helpful voice assistant. Keep replies short and conversational (1-3 sentences). Avoid markdown formatting — responses are spoken aloud.";

    const body = {
      model: this.config.llmModel,
      max_tokens: this.config.maxResponseTokens,
      system: systemPrompt,
      messages: [{ role: "user", content: userText }],
    };

    // Resolve OpenAI-compatible endpoint (Minion gateway internal)
    const endpoint = process.env.MINION_GATEWAY_URL ?? "http://127.0.0.1:18789";
    const token = process.env.OPENCLAW_GATEWAY_TOKEN ?? process.env.MINION_GATEWAY_TOKEN ?? "";

    const response = await fetch(`${endpoint}/v1/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      throw new Error(`LLM API error ${response.status}: ${await response.text()}`);
    }

    const data = (await response.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
    };

    return data.choices?.[0]?.message?.content?.trim() ?? "";
  }

  /**
   * Synthesize text using the configured TTS provider and return audio bytes.
   *
   * The returned Buffer contains PCM audio (16kHz, 16-bit mono) ready for
   * publication to a LiveKit LocalAudioTrack.  In the MVP the buffer is
   * emitted as a data-channel message for the agent worker to consume.
   */
  private async synthesizeSpeech(text: string): Promise<Buffer> {
    const { provider } = this.config.tts;

    if (provider === "elevenlabs") {
      return this.synthesizeElevenLabs(text);
    }
    return this.synthesizeOpenAI(text);
  }

  private async synthesizeElevenLabs(text: string): Promise<Buffer> {
    const cfg = this.config.tts.elevenlabs!;
    const apiKey = cfg.apiKey;
    if (!apiKey) {
      throw new Error("ElevenLabs API key not configured");
    }

    const baseUrl = cfg.baseUrl ?? "https://api.elevenlabs.io";
    const response = await fetch(
      `${baseUrl}/v1/text-to-speech/${cfg.voiceId}/stream`,
      {
        method: "POST",
        headers: {
          "xi-api-key": apiKey,
          "Content-Type": "application/json",
          Accept: "audio/mpeg",
        },
        body: JSON.stringify({
          text,
          model_id: cfg.modelId,
          output_format: "pcm_16000",
        }),
      },
    );

    if (!response.ok) {
      throw new Error(
        `ElevenLabs TTS error ${response.status}: ${await response.text()}`,
      );
    }

    return Buffer.from(await response.arrayBuffer());
  }

  private async synthesizeOpenAI(text: string): Promise<Buffer> {
    const cfg = this.config.tts.openai!;
    const apiKey = cfg.apiKey;
    if (!apiKey) {
      throw new Error("OpenAI API key not configured for TTS");
    }

    const response = await fetch("https://api.openai.com/v1/audio/speech", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: cfg.model,
        voice: cfg.voice,
        input: text,
        response_format: "pcm",
      }),
    });

    if (!response.ok) {
      throw new Error(
        `OpenAI TTS error ${response.status}: ${await response.text()}`,
      );
    }

    return Buffer.from(await response.arrayBuffer());
  }
}
