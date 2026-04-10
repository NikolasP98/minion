/**
 * LiveKit MultimodalAgent — secondary voice mode.
 *
 * Architecture:
 *   User Voice → LiveKit Cloud → OpenAI Realtime API (direct audio) → User
 *
 * Unlike the VoicePipelineAgent (which runs explicit STT → LLM → TTS steps),
 * the MultimodalAgent forwards raw audio directly to the OpenAI Realtime API.
 * OpenAI handles VAD, transcription, generation, and speech synthesis in one
 * pass, significantly reducing end-to-end latency.
 *
 * The agent connects a LiveKit room as the transport layer and bridges audio
 * between the room's audio tracks and the OpenAI Realtime WebSocket.
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

const log = createSubsystemLogger("livekit-multimodal");

// -----------------------------------------------------------------------------
// Types
// -----------------------------------------------------------------------------

export type MultimodalStartOptions = {
  /** Existing Minion conversation context key */
  conversationKey?: string;
  /** OpenAI Realtime API model (default: gpt-4o-realtime-preview) */
  realtimeModel?: string;
  /** System instructions sent to OpenAI Realtime on session init */
  instructions?: string;
  /** OpenAI API key override (falls back to OPENAI_API_KEY) */
  openaiApiKey?: string;
};

export type MultimodalStartResult =
  | {
      ok: true;
      session: AgentSession;
      /** LiveKit room access token for the user-side participant */
      userToken: string;
      roomName: string;
      wsUrl: string;
    }
  | {
      ok: false;
      error: string;
    };

// OpenAI Realtime API session config
type RealtimeSessionConfig = {
  model: string;
  modalities: string[];
  instructions: string;
  voice: string;
  input_audio_format: string;
  output_audio_format: string;
  turn_detection: {
    type: string;
    threshold: number;
    silence_duration_ms: number;
    create_response: boolean;
  };
};

// -----------------------------------------------------------------------------
// MultimodalAgent
// -----------------------------------------------------------------------------

export class MultimodalAgent {
  readonly sessionId: string;

  private readonly livekitConfig: LiveKitConfig;
  private readonly config: VoicePipelineConfig;
  private readonly realtimeModel: string;
  private readonly openaiApiKey: string;
  private session: AgentSession;
  private realtimeWs: import("ws").WebSocket | null = null;

  private constructor(
    sessionId: string,
    config: VoicePipelineConfig,
    livekitConfig: LiveKitConfig,
    openaiApiKey: string,
    realtimeModel: string,
    session: AgentSession,
  ) {
    this.sessionId = sessionId;
    this.config = config;
    this.livekitConfig = livekitConfig;
    this.openaiApiKey = openaiApiKey;
    this.realtimeModel = realtimeModel;
    this.session = session;
  }

  // ---------------------------------------------------------------------------
  // Factory
  // ---------------------------------------------------------------------------

  static async create(
    sessionId: string,
    rawConfig: VoicePipelineConfig,
    opts: MultimodalStartOptions = {},
  ): Promise<MultimodalStartResult> {
    const config = resolveVoicePipelineConfig(rawConfig);

    // Resolve OpenAI API key
    const openaiApiKey =
      opts.openaiApiKey ??
      process.env.OPENAI_API_KEY;
    if (!openaiApiKey) {
      return { ok: false, error: "OPENAI_API_KEY is not set (required for multimodal mode)" };
    }

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

    const realtimeModel = opts.realtimeModel ?? "gpt-4o-realtime-preview";
    const roomName = roomNameForSession(sessionId);
    const session: AgentSession = {
      sessionId,
      roomName,
      mode: "multimodal",
      status: "connecting",
      conversationKey: opts.conversationKey ?? null,
      startedAt: Date.now(),
      endedAt: null,
    };

    // Create LiveKit room
    try {
      await createRoom(livekitConfig, roomName, {
        maxParticipants: 2,
        emptyTimeoutSec: 60,
      });
      log.info(`Multimodal room created: ${roomName}`);
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

    const agent = new MultimodalAgent(
      sessionId,
      config,
      livekitConfig,
      openaiApiKey,
      realtimeModel,
      session,
    );

    // Establish the OpenAI Realtime WebSocket
    const wsConnected = await agent.connectRealtimeApi(
      opts.instructions ??
        "You are a helpful voice assistant. Keep responses concise and conversational.",
    );
    if (!wsConnected.ok) {
      await deleteRoom(livekitConfig, roomName).catch(() => undefined);
      return { ok: false, error: wsConnected.error };
    }

    agent.setStatus("listening");
    log.info(`Multimodal session ${sessionId} ready in room ${roomName}`);

    return {
      ok: true,
      session: agent.session,
      userToken,
      roomName,
      wsUrl: livekitConfig.wsUrl,
    };
  }

  // ---------------------------------------------------------------------------
  // Public API
  // ---------------------------------------------------------------------------

  getSession(): Readonly<AgentSession> {
    return this.session;
  }

  /**
   * Forward raw PCM audio bytes from the LiveKit room to the OpenAI Realtime
   * WebSocket.  The Realtime API handles VAD and will emit response audio back
   * via the WebSocket, which is then published to the room.
   *
   * @param audioBuffer - Raw PCM audio (16kHz, 16-bit mono, base64-encoded
   *                      before transmission to the Realtime API)
   */
  sendAudio(audioBuffer: Buffer): void {
    if (!this.realtimeWs || this.session.status === "closed") {
      return;
    }

    const base64Audio = audioBuffer.toString("base64");
    this.realtimeWs.send(
      JSON.stringify({
        type: "input_audio_buffer.append",
        audio: base64Audio,
      }),
    );
  }

  /**
   * Close the Realtime WebSocket and delete the LiveKit room.
   */
  async stop(): Promise<{ ok: true } | { ok: false; error: string }> {
    if (this.session.status === "closed") {
      return { ok: true };
    }

    this.setStatus("closed");
    this.session = { ...this.session, endedAt: Date.now() };

    if (this.realtimeWs) {
      try {
        this.realtimeWs.close();
      } catch {
        // ignore close errors
      }
      this.realtimeWs = null;
    }

    try {
      await deleteRoom(this.livekitConfig, this.session.roomName);
      log.info(`Multimodal session ${this.sessionId} stopped`);
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
   * Open a WebSocket connection to the OpenAI Realtime API and configure the
   * session with VAD, voice, and turn-detection parameters.
   */
  private async connectRealtimeApi(
    instructions: string,
  ): Promise<{ ok: true } | { ok: false; error: string }> {
    const { WebSocket } = await import("ws");

    const url = `wss://api.openai.com/v1/realtime?model=${encodeURIComponent(this.realtimeModel)}`;

    return new Promise((resolve) => {
      let settled = false;
      const settle = (result: { ok: true } | { ok: false; error: string }) => {
        if (!settled) {
          settled = true;
          resolve(result);
        }
      };

      const ws = new WebSocket(url, {
        headers: {
          Authorization: `Bearer ${this.openaiApiKey}`,
          "OpenAI-Beta": "realtime=v1",
        },
      });

      const connectTimeout = setTimeout(() => {
        ws.close();
        settle({ ok: false, error: "Timed out connecting to OpenAI Realtime API" });
      }, 10_000);

      ws.on("open", () => {
        clearTimeout(connectTimeout);

        const sessionConfig: RealtimeSessionConfig = {
          model: this.realtimeModel,
          modalities: ["text", "audio"],
          instructions,
          voice: "alloy",
          input_audio_format: "pcm16",
          output_audio_format: "pcm16",
          turn_detection: {
            type: "server_vad",
            threshold: 0.5,
            silence_duration_ms: this.config.interruption.enabled ? 300 : 800,
            create_response: true,
          },
        };

        ws.send(
          JSON.stringify({ type: "session.update", session: sessionConfig }),
        );

        this.realtimeWs = ws;
        log.debug(`Realtime WebSocket connected for session ${this.sessionId}`);
        settle({ ok: true });
      });

      ws.on("message", (data: Buffer) => {
        this.handleRealtimeMessage(data);
      });

      ws.on("error", (err) => {
        const msg = `OpenAI Realtime WebSocket error: ${err.message}`;
        log.error(msg);
        clearTimeout(connectTimeout);
        if (this.session.status !== "closed") {
          this.setStatus("error");
        }
        settle({ ok: false, error: msg });
      });

      ws.on("close", () => {
        if (this.session.status !== "closed" && this.session.status !== "error") {
          log.info(`Realtime WebSocket closed for session ${this.sessionId}`);
          this.setStatus("closed");
        }
        this.realtimeWs = null;
      });
    });
  }

  /**
   * Handle inbound messages from the OpenAI Realtime API.
   *
   * Key events:
   * - `response.audio.delta`      — chunk of audio to play back
   * - `response.audio.done`       — audio playback complete
   * - `input_audio_buffer.speech_started` — user started speaking (barge-in)
   * - `response.done`             — full response finished
   */
  private handleRealtimeMessage(data: Buffer): void {
    let event: Record<string, unknown>;
    try {
      event = JSON.parse(data.toString()) as Record<string, unknown>;
    } catch {
      log.warn(`Unparseable Realtime message for session ${this.sessionId}`);
      return;
    }

    const type = event["type"];

    switch (type) {
      case "input_audio_buffer.speech_started":
        // User started speaking — signal interruption if agent is speaking
        if (this.session.status === "speaking") {
          this.setStatus("interrupted");
          log.debug(`Session ${this.sessionId}: speech_started barge-in`);
        }
        break;

      case "response.audio.delta":
        // Incremental audio chunk — route to room publication
        this.setStatus("speaking");
        // In a real deployment: publish base64 audio delta to LiveKit room track
        // event.delta contains base64 PCM bytes
        break;

      case "response.audio.done":
        if (this.session.status === "speaking") {
          this.setStatus("listening");
        }
        break;

      case "response.done":
        log.debug(`Session ${this.sessionId}: response done`);
        break;

      case "error":
        log.error(
          `Realtime API error [${this.sessionId}]: ${JSON.stringify(event["error"])}`,
        );
        break;

      default:
        break;
    }
  }
}
