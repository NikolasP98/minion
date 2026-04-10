import { z } from "zod";

// -----------------------------------------------------------------------------
// STT Providers
// -----------------------------------------------------------------------------

export const DeepgramConfigSchema = z
  .object({
    /** Deepgram API key (falls back to DEEPGRAM_API_KEY env var) */
    apiKey: z.string().min(1).optional(),
    /** Deepgram model (e.g. "nova-3", "nova-2-general") */
    model: z.string().min(1).default("nova-3"),
    /** Language code for transcription (e.g. "en-US") */
    language: z.string().min(1).default("en-US"),
    /** Enable smart formatting (punctuation, capitalization) */
    smartFormat: z.boolean().default(true),
    /** Enable endpointing for turn detection (ms of silence = end of utterance) */
    endpointingMs: z.number().int().positive().default(300),
  })
  .strict();
export type DeepgramConfig = z.infer<typeof DeepgramConfigSchema>;

export const WhisperConfigSchema = z
  .object({
    /** OpenAI API key for Whisper (falls back to OPENAI_API_KEY env var) */
    apiKey: z.string().min(1).optional(),
    /** Whisper model to use */
    model: z.string().min(1).default("whisper-1"),
    /** Language hint for transcription */
    language: z.string().min(1).optional(),
  })
  .strict();
export type WhisperConfig = z.infer<typeof WhisperConfigSchema>;

export const SttProviderSchema = z.enum(["deepgram", "whisper"]);
export type SttProvider = z.infer<typeof SttProviderSchema>;

export const SttConfigSchema = z
  .object({
    provider: SttProviderSchema.default("deepgram"),
    deepgram: DeepgramConfigSchema.optional(),
    whisper: WhisperConfigSchema.optional(),
  })
  .strict()
  .default({ provider: "deepgram" });
export type SttConfig = z.infer<typeof SttConfigSchema>;

// -----------------------------------------------------------------------------
// TTS Providers
// -----------------------------------------------------------------------------

export const ElevenLabsVoiceConfigSchema = z
  .object({
    /** ElevenLabs API key (falls back to ELEVENLABS_API_KEY env var) */
    apiKey: z.string().min(1).optional(),
    /** ElevenLabs base URL */
    baseUrl: z.string().url().optional(),
    /** Voice ID to use */
    voiceId: z.string().min(1).default("pMsXgVXv3BLzUgSXRplE"),
    /** ElevenLabs model (e.g. "eleven_turbo_v2_5" for low latency) */
    modelId: z.string().min(1).default("eleven_turbo_v2_5"),
  })
  .strict();
export type ElevenLabsVoiceConfig = z.infer<typeof ElevenLabsVoiceConfigSchema>;

export const OpenAITtsConfigSchema = z
  .object({
    /** OpenAI API key (falls back to OPENAI_API_KEY env var) */
    apiKey: z.string().min(1).optional(),
    /** TTS model (e.g. "gpt-4o-mini-tts") */
    model: z.string().min(1).default("gpt-4o-mini-tts"),
    /** Voice to use */
    voice: z
      .enum(["alloy", "echo", "fable", "onyx", "nova", "shimmer", "coral"])
      .default("alloy"),
  })
  .strict();
export type OpenAITtsConfig = z.infer<typeof OpenAITtsConfigSchema>;

export const TtsProviderSchema = z.enum(["elevenlabs", "openai"]);
export type TtsProvider = z.infer<typeof TtsProviderSchema>;

export const TtsConfigSchema = z
  .object({
    provider: TtsProviderSchema.default("openai"),
    elevenlabs: ElevenLabsVoiceConfigSchema.optional(),
    openai: OpenAITtsConfigSchema.optional(),
  })
  .strict()
  .default({ provider: "openai" });
export type TtsConfig = z.infer<typeof TtsConfigSchema>;

// -----------------------------------------------------------------------------
// SIP Trunk (Twilio)
// -----------------------------------------------------------------------------

export const TwilioSipConfigSchema = z
  .object({
    /** Twilio Account SID (falls back to TWILIO_ACCOUNT_SID env var) */
    accountSid: z.string().min(1).optional(),
    /** Twilio Auth Token (falls back to TWILIO_AUTH_TOKEN env var) */
    authToken: z.string().min(1).optional(),
    /**
     * Twilio SIP domain for outbound calls.
     * Format: <domain>.sip.twilio.com
     */
    sipDomain: z.string().min(1).optional(),
    /** Phone number for outbound SIP calls (E.164 format) */
    fromNumber: z
      .string()
      .regex(/^\+[1-9]\d{1,14}$/, "Expected E.164 format")
      .optional(),
  })
  .strict();
export type TwilioSipConfig = z.infer<typeof TwilioSipConfigSchema>;

// -----------------------------------------------------------------------------
// Agent Mode
// -----------------------------------------------------------------------------

/**
 * VoicePipelineAgent: STT → Minion LLM → TTS pipeline (primary)
 * MultimodalAgent: direct audio via OpenAI Realtime API (secondary)
 */
export const AgentModeSchema = z.enum(["pipeline", "multimodal"]);
export type AgentMode = z.infer<typeof AgentModeSchema>;

// -----------------------------------------------------------------------------
// Interruption Handling
// -----------------------------------------------------------------------------

export const InterruptionConfigSchema = z
  .object({
    /** Enable barge-in / mid-speech interruption */
    enabled: z.boolean().default(true),
    /** Minimum words spoken before interruption is considered valid */
    minWordsThreshold: z.number().int().nonnegative().default(3),
  })
  .strict()
  .default({ enabled: true, minWordsThreshold: 3 });
export type InterruptionConfig = z.infer<typeof InterruptionConfigSchema>;

// -----------------------------------------------------------------------------
// Full Voice Pipeline Config
// -----------------------------------------------------------------------------

export const VoicePipelineConfigSchema = z
  .object({
    /** Active agent mode */
    mode: AgentModeSchema.default("pipeline"),

    /** STT configuration (used for pipeline mode) */
    stt: SttConfigSchema,

    /** TTS configuration (used for pipeline mode) */
    tts: TtsConfigSchema,

    /** Model for LLM processing (e.g. "openai/gpt-4o", "anthropic/claude-sonnet-4-6") */
    llmModel: z.string().min(1).default("openai/gpt-4o"),

    /** System prompt for voice-mode LLM responses */
    systemPrompt: z.string().optional(),

    /** Max LLM response tokens in voice mode (keep short for low latency) */
    maxResponseTokens: z.number().int().positive().default(256),

    /** Interruption handling */
    interruption: InterruptionConfigSchema,

    /** Twilio SIP trunk config for phone-call ingress */
    sip: TwilioSipConfigSchema.optional(),

    /** Graceful-degradation: return error instead of crashing when LiveKit unreachable */
    failGracefully: z.boolean().default(true),
  })
  .strict();
export type VoicePipelineConfig = z.infer<typeof VoicePipelineConfigSchema>;

// -----------------------------------------------------------------------------
// Agent Session
// -----------------------------------------------------------------------------

export type AgentSessionStatus =
  | "idle"
  | "connecting"
  | "listening"
  | "thinking"
  | "speaking"
  | "interrupted"
  | "error"
  | "closed";

export type AgentSession = {
  sessionId: string;
  roomName: string;
  mode: AgentMode;
  status: AgentSessionStatus;
  conversationKey: string | null;
  startedAt: number;
  endedAt: number | null;
};

// -----------------------------------------------------------------------------
// Config Resolution (env var fallbacks)
// -----------------------------------------------------------------------------

export function resolveVoicePipelineConfig(
  config: VoicePipelineConfig,
): VoicePipelineConfig {
  const resolved = structuredClone(config);

  if (resolved.stt.provider === "deepgram") {
    resolved.stt.deepgram = resolved.stt.deepgram ?? DeepgramConfigSchema.parse({});
    resolved.stt.deepgram.apiKey =
      resolved.stt.deepgram.apiKey ?? process.env.DEEPGRAM_API_KEY;
  }

  if (resolved.stt.provider === "whisper") {
    resolved.stt.whisper = resolved.stt.whisper ?? WhisperConfigSchema.parse({});
    resolved.stt.whisper.apiKey =
      resolved.stt.whisper.apiKey ?? process.env.OPENAI_API_KEY;
  }

  if (resolved.tts.provider === "elevenlabs") {
    resolved.tts.elevenlabs = resolved.tts.elevenlabs ?? ElevenLabsVoiceConfigSchema.parse({});
    resolved.tts.elevenlabs.apiKey =
      resolved.tts.elevenlabs.apiKey ??
      process.env.ELEVENLABS_API_KEY ??
      process.env.XI_API_KEY;
  }

  if (resolved.tts.provider === "openai") {
    resolved.tts.openai = resolved.tts.openai ?? OpenAITtsConfigSchema.parse({});
    resolved.tts.openai.apiKey =
      resolved.tts.openai.apiKey ?? process.env.OPENAI_API_KEY;
  }

  if (resolved.sip) {
    resolved.sip.accountSid =
      resolved.sip.accountSid ?? process.env.TWILIO_ACCOUNT_SID;
    resolved.sip.authToken =
      resolved.sip.authToken ?? process.env.TWILIO_AUTH_TOKEN;
    resolved.sip.sipDomain =
      resolved.sip.sipDomain ?? process.env.TWILIO_SIP_DOMAIN;
    resolved.sip.fromNumber =
      resolved.sip.fromNumber ?? process.env.TWILIO_FROM_NUMBER;
  }

  return resolved;
}
