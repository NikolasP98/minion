/**
 * Google Calendar tools for the MINION email + calendar module.
 *
 * 9+ high-level tools wrapping the gog CLI.
 * Event creation and updates go through an optional confirmation step.
 */

import { Type } from "@sinclair/typebox";
import type { MinionPluginApi } from "minion/plugin-sdk";
import { buildApprovalPrompt, createPending } from "./approval-gate.js";
import { gogResultToContent, runGog, type GogContext } from "./gog-runner.js";

// ── Helpers ───────────────────────────────────────────────────────────

function txt(text: string) {
  return { content: [{ type: "text" as const, text }], details: { text } };
}

function getCtx(api: MinionPluginApi): GogContext | null {
  const rt = api.runtime as unknown as Record<string, unknown>;
  const agentId = rt.agentId as string | undefined;
  const sessionKey = rt.sessionKey as string | undefined;
  if (!agentId || !sessionKey) return null;
  return { agentId, sessionKey };
}

// ── Schemas ───────────────────────────────────────────────────────────

const CalendarListEventsSchema = Type.Object({
  calendarId: Type.Optional(Type.String({ description: 'Calendar ID (default: "primary")' })),
  timeMin: Type.Optional(Type.String({ description: "Start time in ISO 8601 (default: now)" })),
  timeMax: Type.Optional(Type.String({ description: "End time in ISO 8601 (default: +7 days)" })),
  max: Type.Optional(
    Type.Number({ description: "Max events (default: 20)", minimum: 1, maximum: 100 }),
  ),
  query: Type.Optional(
    Type.String({ description: "Free-text search filter on event title/description" }),
  ),
});

const CalendarGetEventSchema = Type.Object({
  eventId: Type.String({ description: "Calendar event ID", minLength: 1 }),
  calendarId: Type.Optional(Type.String({ description: 'Calendar ID (default: "primary")' })),
});

const CalendarCreateEventSchema = Type.Object({
  title: Type.String({ description: "Event title", minLength: 1 }),
  start: Type.String({
    description: "Start date/time in ISO 8601 (e.g. 2026-04-15T14:00:00)",
    minLength: 1,
  }),
  end: Type.String({ description: "End date/time in ISO 8601", minLength: 1 }),
  description: Type.Optional(Type.String({ description: "Event description" })),
  location: Type.Optional(Type.String({ description: "Event location" })),
  attendees: Type.Optional(Type.String({ description: "Comma-separated attendee emails" })),
  calendarId: Type.Optional(Type.String({ description: 'Calendar ID (default: "primary")' })),
  sendNotifications: Type.Optional(
    Type.Boolean({ description: "Send invites to attendees (default: true)" }),
  ),
  approved: Type.Optional(
    Type.Boolean({ description: "Bypass confirmation gate for this event creation" }),
  ),
});

const CalendarUpdateEventSchema = Type.Object({
  eventId: Type.String({ description: "Calendar event ID to update", minLength: 1 }),
  calendarId: Type.Optional(Type.String({ description: 'Calendar ID (default: "primary")' })),
  title: Type.Optional(Type.String({ description: "New title" })),
  start: Type.Optional(Type.String({ description: "New start time in ISO 8601" })),
  end: Type.Optional(Type.String({ description: "New end time in ISO 8601" })),
  description: Type.Optional(Type.String({ description: "New description" })),
  location: Type.Optional(Type.String({ description: "New location" })),
  approved: Type.Optional(Type.Boolean({ description: "Bypass confirmation gate" })),
});

const CalendarDeleteEventSchema = Type.Object({
  eventId: Type.String({ description: "Calendar event ID to delete", minLength: 1 }),
  calendarId: Type.Optional(Type.String({ description: 'Calendar ID (default: "primary")' })),
  sendNotifications: Type.Optional(
    Type.Boolean({ description: "Notify attendees (default: true)" }),
  ),
});

const CalendarSearchSchema = Type.Object({
  query: Type.String({ description: "Search text for event title or description", minLength: 1 }),
  calendarId: Type.Optional(Type.String({ description: 'Calendar ID (default: "primary")' })),
  timeMin: Type.Optional(Type.String({ description: "Start time filter in ISO 8601" })),
  timeMax: Type.Optional(Type.String({ description: "End time filter in ISO 8601" })),
  max: Type.Optional(
    Type.Number({ description: "Max results (default: 20)", minimum: 1, maximum: 100 }),
  ),
});

const CalendarRsvpSchema = Type.Object({
  eventId: Type.String({ description: "Calendar event ID", minLength: 1 }),
  calendarId: Type.Optional(Type.String({ description: 'Calendar ID (default: "primary")' })),
  status: Type.Union(
    [Type.Literal("accepted"), Type.Literal("declined"), Type.Literal("tentative")],
    { description: "RSVP response" },
  ),
});

const CalendarFreeSlotsSchema = Type.Object({
  timeMin: Type.String({ description: "Search start in ISO 8601", minLength: 1 }),
  timeMax: Type.String({ description: "Search end in ISO 8601", minLength: 1 }),
  durationMinutes: Type.Optional(
    Type.Number({ description: "Required slot duration in minutes (default: 60)", minimum: 15 }),
  ),
  calendarIds: Type.Optional(
    Type.String({ description: "Comma-separated calendar IDs to check (default: primary)" }),
  ),
});

const CalendarConfirmSchema = Type.Object({
  token: Type.String({
    description: "Confirmation token from calendar_create or calendar_update",
    minLength: 1,
  }),
});

// ── Registration ──────────────────────────────────────────────────────

export function registerCalendarTools(api: MinionPluginApi, requireApproval: boolean): void {
  // 1. calendar_list_calendars — list all calendars
  api.registerTool({
    name: "calendar_list_calendars",
    label: "Calendar: List Calendars",
    description: "List all Google Calendars accessible by the authenticated user.",
    parameters: Type.Object({}),
    async execute(_id, _params) {
      const ctx = getCtx(api);
      if (!ctx) return txt("Missing agent context.");
      return gogResultToContent(await runGog("calendar calendars", ctx, { service: "calendar" }));
    },
  });

  // 2. calendar_list_events — list upcoming events
  api.registerTool({
    name: "calendar_list_events",
    label: "Calendar: List Events",
    description:
      "List upcoming Google Calendar events. Defaults to the next 7 days on the primary calendar.",
    parameters: CalendarListEventsSchema,
    async execute(_id, params) {
      const p = params as Record<string, unknown>;
      const ctx = getCtx(api);
      if (!ctx) return txt("Missing agent context.");
      const calId = String(p.calendarId ?? "primary");
      let cmd = `calendar list --calendar ${calId}`;
      if (p.timeMin) cmd += ` --time-min "${String(p.timeMin)}"`;
      if (p.timeMax) cmd += ` --time-max "${String(p.timeMax)}"`;
      if (p.max) cmd += ` --max ${Number(p.max)}`;
      if (p.query) cmd += ` --query "${String(p.query).replace(/"/g, '\\"')}"`;
      return gogResultToContent(await runGog(cmd, ctx, { service: "calendar" }));
    },
  });

  // 3. calendar_get_event — get single event
  api.registerTool({
    name: "calendar_get_event",
    label: "Calendar: Get Event",
    description: "Get details of a specific Google Calendar event by ID.",
    parameters: CalendarGetEventSchema,
    async execute(_id, params) {
      const p = params as Record<string, unknown>;
      const ctx = getCtx(api);
      if (!ctx) return txt("Missing agent context.");
      const calId = String(p.calendarId ?? "primary");
      return gogResultToContent(
        await runGog(`calendar get ${String(p.eventId)} --calendar ${calId}`, ctx, {
          service: "calendar",
        }),
      );
    },
  });

  // 4. calendar_create_event — create event (with confirmation)
  api.registerTool({
    name: "calendar_create_event",
    label: "Calendar: Create Event",
    description:
      "Create a new Google Calendar event. When requireApproval is enabled, shows a confirmation prompt before creating. " +
      "Use approved=true for automated booking flows.",
    parameters: CalendarCreateEventSchema,
    async execute(_id, params) {
      const p = params as Record<string, unknown>;
      const ctx = getCtx(api);
      if (!ctx) return txt("Missing agent context.");

      const payload = { ...p, ctx };
      const needsApproval = requireApproval && !p.approved;

      if (needsApproval) {
        const attendeeNote = p.attendees ? `\nAttendees: ${p.attendees}` : "";
        const summary =
          `Create event: "${p.title}"\nStart: ${p.start} → End: ${p.end}` +
          (p.location ? `\nLocation: ${p.location}` : "") +
          attendeeNote;
        const entry = createPending({ provider: "gmail", payload, summary });
        const prompt = buildApprovalPrompt(entry).replace(
          "📧 **Email ready to send**",
          "📅 **Calendar event ready to create**",
        );
        return txt(prompt);
      }

      return await _executeCalendarCreate(p, ctx);
    },
  });

  // 5. calendar_update_event — update event
  api.registerTool({
    name: "calendar_update_event",
    label: "Calendar: Update Event",
    description:
      "Update an existing Google Calendar event. Shows confirmation when requireApproval=true.",
    parameters: CalendarUpdateEventSchema,
    async execute(_id, params) {
      const p = params as Record<string, unknown>;
      const ctx = getCtx(api);
      if (!ctx) return txt("Missing agent context.");

      const needsApproval = requireApproval && !p.approved;
      if (needsApproval) {
        const changes: string[] = [];
        if (p.title) changes.push(`title → "${p.title}"`);
        if (p.start) changes.push(`start → ${p.start}`);
        if (p.end) changes.push(`end → ${p.end}`);
        if (p.location) changes.push(`location → ${p.location}`);
        const summary = `Update event ${p.eventId}:\n${changes.join("\n")}`;
        const entry = createPending({
          provider: "gmail",
          payload: { ...p, ctx, _action: "update" },
          summary,
        });
        const prompt = buildApprovalPrompt(entry).replace(
          "📧 **Email ready to send**",
          "📅 **Calendar update ready**",
        );
        return txt(prompt);
      }

      return await _executeCalendarUpdate(p, ctx);
    },
  });

  // 6. calendar_delete_event — delete event
  api.registerTool({
    name: "calendar_delete_event",
    label: "Calendar: Delete Event",
    description: "Delete a Google Calendar event.",
    parameters: CalendarDeleteEventSchema,
    async execute(_id, params) {
      const p = params as Record<string, unknown>;
      const ctx = getCtx(api);
      if (!ctx) return txt("Missing agent context.");
      const calId = String(p.calendarId ?? "primary");
      const notify = p.sendNotifications !== false ? " --notify" : "";
      return gogResultToContent(
        await runGog(`calendar delete ${String(p.eventId)} --calendar ${calId}${notify}`, ctx, {
          service: "calendar",
        }),
      );
    },
  });

  // 7. calendar_search — search events
  api.registerTool({
    name: "calendar_search",
    label: "Calendar: Search Events",
    description: "Search Google Calendar events by text across title and description.",
    parameters: CalendarSearchSchema,
    async execute(_id, params) {
      const p = params as Record<string, unknown>;
      const ctx = getCtx(api);
      if (!ctx) return txt("Missing agent context.");
      const calId = String(p.calendarId ?? "primary");
      let cmd = `calendar search "${String(p.query).replace(/"/g, '\\"')}" --calendar ${calId}`;
      if (p.timeMin) cmd += ` --time-min "${String(p.timeMin)}"`;
      if (p.timeMax) cmd += ` --time-max "${String(p.timeMax)}"`;
      if (p.max) cmd += ` --max ${Number(p.max)}`;
      return gogResultToContent(await runGog(cmd, ctx, { service: "calendar" }));
    },
  });

  // 8. calendar_rsvp — accept/decline event
  api.registerTool({
    name: "calendar_rsvp",
    label: "Calendar: RSVP to Event",
    description: "Accept, decline, or tentatively accept a Google Calendar event invitation.",
    parameters: CalendarRsvpSchema,
    async execute(_id, params) {
      const p = params as Record<string, unknown>;
      const ctx = getCtx(api);
      if (!ctx) return txt("Missing agent context.");
      const calId = String(p.calendarId ?? "primary");
      return gogResultToContent(
        await runGog(
          `calendar rsvp ${String(p.eventId)} --calendar ${calId} --status ${String(p.status)}`,
          ctx,
          { service: "calendar" },
        ),
      );
    },
  });

  // 9. calendar_find_free_slots — find free time
  api.registerTool({
    name: "calendar_find_free_slots",
    label: "Calendar: Find Free Time Slots",
    description:
      "Find available time slots within a time range. Useful for scheduling and booking flows.",
    parameters: CalendarFreeSlotsSchema,
    async execute(_id, params) {
      const p = params as Record<string, unknown>;
      const ctx = getCtx(api);
      if (!ctx) return txt("Missing agent context.");
      const duration = Number(p.durationMinutes ?? 60);
      const calIds = p.calendarIds
        ? String(p.calendarIds)
            .split(",")
            .map((s) => s.trim())
        : ["primary"];
      let cmd = `calendar free-busy --time-min "${String(p.timeMin)}" --time-max "${String(p.timeMax)}" --duration ${duration}`;
      for (const cal of calIds) {
        cmd += ` --calendar ${cal}`;
      }
      return gogResultToContent(await runGog(cmd, ctx, { service: "calendar" }));
    },
  });

  // Confirmation tool for calendar events (shared with email_send_confirm but calendar-branded)
  api.registerTool({
    name: "calendar_confirm",
    label: "Calendar: Confirm Event",
    description:
      "Confirm a pending calendar event creation or update. Use the token returned by calendar_create_event or calendar_update_event.",
    parameters: CalendarConfirmSchema,
    async execute(_id, params) {
      const p = params as Record<string, unknown>;
      const { consumePending } = await import("./approval-gate.js");
      const entry = consumePending(String(p.token));
      if (!entry) {
        return txt(
          `No pending calendar action found for token "${p.token}". It may have expired or already been confirmed.`,
        );
      }

      const ctx = getCtx(api);
      if (!ctx) return txt("Missing agent context.");

      const payload = entry.payload as Record<string, unknown>;
      if (payload._action === "update") {
        return await _executeCalendarUpdate(payload, ctx);
      }
      return await _executeCalendarCreate(payload, ctx);
    },
  });
}

// ── Internal executors (called by both direct and confirmation paths) ──

async function _executeCalendarCreate(p: Record<string, unknown>, ctx: GogContext) {
  const calId = String(p.calendarId ?? "primary");
  let cmd = `calendar create --title "${String(p.title).replace(/"/g, '\\"')}" --start "${String(p.start)}" --end "${String(p.end)}" --calendar ${calId}`;
  if (p.description) cmd += ` --description "${String(p.description).replace(/"/g, '\\"')}"`;
  if (p.location) cmd += ` --location "${String(p.location).replace(/"/g, '\\"')}"`;
  if (p.attendees) cmd += ` --attendees "${String(p.attendees)}"`;
  if (p.sendNotifications !== false) cmd += " --notify";
  return gogResultToContent(await runGog(cmd, ctx, { service: "calendar" }));
}

async function _executeCalendarUpdate(p: Record<string, unknown>, ctx: GogContext) {
  const calId = String(p.calendarId ?? "primary");
  let cmd = `calendar update ${String(p.eventId)} --calendar ${calId}`;
  if (p.title) cmd += ` --title "${String(p.title).replace(/"/g, '\\"')}"`;
  if (p.start) cmd += ` --start "${String(p.start)}"`;
  if (p.end) cmd += ` --end "${String(p.end)}"`;
  if (p.description) cmd += ` --description "${String(p.description).replace(/"/g, '\\"')}"`;
  if (p.location) cmd += ` --location "${String(p.location).replace(/"/g, '\\"')}"`;
  return gogResultToContent(await runGog(cmd, ctx, { service: "calendar" }));
}

export { _executeCalendarCreate, _executeCalendarUpdate };
