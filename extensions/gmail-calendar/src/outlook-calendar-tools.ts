/**
 * Outlook Calendar tools for the MINION email + calendar module.
 *
 * 9 tools wrapping the Microsoft Graph Calendar API.
 * Authentication reuses outlook-oauth.ts credential store.
 */

import { Type } from "@sinclair/typebox";
import type { MinionPluginApi } from "minion/plugin-sdk";
import { buildApprovalPrompt, createPending } from "./approval-gate.js";
import {
  getValidOutlookCredentials,
  graphFetch,
  type OutlookOAuthConfig,
} from "./outlook-oauth.js";

// ── Helpers ───────────────────────────────────────────────────────────

function txt(text: string) {
  return { content: [{ type: "text" as const, text }], details: { text } };
}

function json(data: unknown) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }],
    details: data,
  };
}

function getCtx(api: MinionPluginApi): { agentId: string; sessionKey: string } | null {
  const rt = api.runtime as unknown as Record<string, unknown>;
  const agentId = rt.agentId as string | undefined;
  const sessionKey = rt.sessionKey as string | undefined;
  if (!agentId || !sessionKey) return null;
  return { agentId, sessionKey };
}

async function getCreds(api: MinionPluginApi, email: string, config: OutlookOAuthConfig) {
  const ctx = getCtx(api);
  if (!ctx) return { error: "Missing agent context." };
  const creds = await getValidOutlookCredentials(ctx.agentId, ctx.sessionKey, email, config);
  if (!creds) return { error: `Not authenticated for ${email}. Use outlook_auth_start.` };
  return creds;
}

/** Build an Outlook event body from common params. */
function buildEventBody(p: Record<string, unknown>): Record<string, unknown> {
  const body: Record<string, unknown> = {
    subject: String(p.title),
    start: {
      dateTime: String(p.start),
      timeZone: String(p.timeZone ?? "UTC"),
    },
    end: {
      dateTime: String(p.end),
      timeZone: String(p.timeZone ?? "UTC"),
    },
  };

  if (p.description) {
    body.body = { contentType: "Text", content: String(p.description) };
  }
  if (p.location) {
    body.location = { displayName: String(p.location) };
  }
  if (p.attendees) {
    body.attendees = String(p.attendees)
      .split(",")
      .map((e) => e.trim())
      .filter(Boolean)
      .map((e) => ({ emailAddress: { address: e }, type: "required" }));
  }
  if (typeof p.isOnlineMeeting === "boolean") {
    body.isOnlineMeeting = p.isOnlineMeeting;
  }
  if (p.isAllDay === true) {
    body.isAllDay = true;
  }
  return body;
}

// ── Schemas ───────────────────────────────────────────────────────────

const EmailParam = Type.Object({
  email: Type.String({ description: "Outlook account email", minLength: 1 }),
});

const OutlookCalListSchema = Type.Object({
  email: Type.String({ description: "Outlook account email", minLength: 1 }),
  calendarId: Type.Optional(
    Type.String({ description: "Calendar ID (default: primary calendar)" }),
  ),
  startDateTime: Type.Optional(
    Type.String({ description: "Start of date range in ISO 8601 (default: now)" }),
  ),
  endDateTime: Type.Optional(
    Type.String({ description: "End of date range in ISO 8601 (default: +7 days)" }),
  ),
  top: Type.Optional(
    Type.Number({ description: "Max events (default: 20)", minimum: 1, maximum: 100 }),
  ),
});

const OutlookCalGetSchema = Type.Object({
  email: Type.String({ description: "Outlook account email", minLength: 1 }),
  eventId: Type.String({ description: "Calendar event ID", minLength: 1 }),
  calendarId: Type.Optional(Type.String({ description: "Calendar ID" })),
});

const OutlookCalCreateSchema = Type.Object({
  email: Type.String({ description: "Outlook account email", minLength: 1 }),
  title: Type.String({ description: "Event title", minLength: 1 }),
  start: Type.String({ description: "Start date/time in ISO 8601", minLength: 1 }),
  end: Type.String({ description: "End date/time in ISO 8601", minLength: 1 }),
  timeZone: Type.Optional(Type.String({ description: "IANA time zone (default: UTC)" })),
  description: Type.Optional(Type.String({ description: "Event description" })),
  location: Type.Optional(Type.String({ description: "Event location" })),
  attendees: Type.Optional(Type.String({ description: "Comma-separated attendee emails" })),
  isOnlineMeeting: Type.Optional(
    Type.Boolean({ description: "Create as Teams/online meeting (default: false)" }),
  ),
  isAllDay: Type.Optional(Type.Boolean({ description: "All-day event (default: false)" })),
  calendarId: Type.Optional(Type.String({ description: "Calendar ID (default: primary)" })),
  sendNotifications: Type.Optional(
    Type.Boolean({ description: "Send invites to attendees (default: true)" }),
  ),
  approved: Type.Optional(Type.Boolean({ description: "Bypass confirmation gate" })),
});

const OutlookCalUpdateSchema = Type.Object({
  email: Type.String({ description: "Outlook account email", minLength: 1 }),
  eventId: Type.String({ description: "Event ID to update", minLength: 1 }),
  calendarId: Type.Optional(Type.String({ description: "Calendar ID" })),
  title: Type.Optional(Type.String({ description: "New title" })),
  start: Type.Optional(Type.String({ description: "New start time" })),
  end: Type.Optional(Type.String({ description: "New end time" })),
  timeZone: Type.Optional(Type.String({ description: "Time zone" })),
  description: Type.Optional(Type.String({ description: "New description" })),
  location: Type.Optional(Type.String({ description: "New location" })),
  approved: Type.Optional(Type.Boolean({ description: "Bypass confirmation gate" })),
});

const OutlookCalDeleteSchema = Type.Object({
  email: Type.String({ description: "Outlook account email", minLength: 1 }),
  eventId: Type.String({ description: "Event ID to delete", minLength: 1 }),
  calendarId: Type.Optional(Type.String({ description: "Calendar ID" })),
  sendCancellations: Type.Optional(
    Type.Boolean({ description: "Send cancellation notices (default: true)" }),
  ),
});

const OutlookCalRsvpSchema = Type.Object({
  email: Type.String({ description: "Outlook account email", minLength: 1 }),
  eventId: Type.String({ description: "Event ID", minLength: 1 }),
  response: Type.Union(
    [Type.Literal("accept"), Type.Literal("tentativelyAccept"), Type.Literal("decline")],
    { description: "RSVP response" },
  ),
  comment: Type.Optional(Type.String({ description: "Optional comment to include with RSVP" })),
  sendResponse: Type.Optional(
    Type.Boolean({ description: "Send response to organizer (default: true)" }),
  ),
});

const OutlookCalFreeBusySchema = Type.Object({
  email: Type.String({ description: "Outlook account email", minLength: 1 }),
  startDateTime: Type.String({ description: "Start of search range in ISO 8601", minLength: 1 }),
  endDateTime: Type.String({ description: "End of search range in ISO 8601", minLength: 1 }),
  durationMinutes: Type.Optional(
    Type.Number({ description: "Required slot length in minutes (default: 60)", minimum: 15 }),
  ),
  attendeeEmails: Type.Optional(
    Type.String({
      description: "Comma-separated emails to check availability for (default: current user)",
    }),
  ),
});

const OutlookCalSearchSchema = Type.Object({
  email: Type.String({ description: "Outlook account email", minLength: 1 }),
  query: Type.String({ description: "Search text for event subject or location", minLength: 1 }),
  startDateTime: Type.Optional(Type.String({ description: "Filter start time" })),
  endDateTime: Type.Optional(Type.String({ description: "Filter end time" })),
  top: Type.Optional(
    Type.Number({ description: "Max results (default: 20)", minimum: 1, maximum: 100 }),
  ),
});

// ── Registration ──────────────────────────────────────────────────────

export function registerOutlookCalendarTools(
  api: MinionPluginApi,
  config: OutlookOAuthConfig,
  requireApproval: boolean,
): void {
  // 1. outlook_cal_list_calendars
  api.registerTool({
    name: "outlook_cal_list_calendars",
    label: "Outlook Calendar: List Calendars",
    description: "List all Outlook calendars accessible by the authenticated user.",
    parameters: EmailParam,
    async execute(_id, params) {
      const p = params as Record<string, unknown>;
      const creds = await getCreds(api, String(p.email), config);
      if ("error" in creds) return txt(creds.error);
      const result = await graphFetch(
        "/me/calendars?$select=id,name,color,isDefaultCalendar,canEdit",
        creds,
      );
      return result.ok ? json(result.data) : txt(`Failed: ${result.error}`);
    },
  });

  // 2. outlook_cal_list_events
  api.registerTool({
    name: "outlook_cal_list_events",
    label: "Outlook Calendar: List Events",
    description:
      "List upcoming Outlook calendar events. Defaults to primary calendar, next 7 days.",
    parameters: OutlookCalListSchema,
    async execute(_id, params) {
      const p = params as Record<string, unknown>;
      const creds = await getCreds(api, String(p.email), config);
      if ("error" in creds) return txt(creds.error);

      const now = new Date().toISOString();
      const sevenDays = new Date(Date.now() + 7 * 86400_000).toISOString();
      const startDT = String(p.startDateTime ?? now);
      const endDT = String(p.endDateTime ?? sevenDays);
      const top = Number(p.top ?? 20);

      const calPath = p.calendarId ? `/me/calendars/${String(p.calendarId)}` : "/me";
      const endpoint =
        `${calPath}/calendarView?startDateTime=${encodeURIComponent(startDT)}&endDateTime=${encodeURIComponent(endDT)}` +
        `&$top=${top}&$orderby=start/dateTime&$select=id,subject,start,end,location,organizer,attendees,isOnlineMeeting,onlineMeetingUrl`;

      const result = await graphFetch(endpoint, creds);
      return result.ok ? json(result.data) : txt(`Failed: ${result.error}`);
    },
  });

  // 3. outlook_cal_get_event
  api.registerTool({
    name: "outlook_cal_get_event",
    label: "Outlook Calendar: Get Event",
    description: "Get details of a specific Outlook calendar event.",
    parameters: OutlookCalGetSchema,
    async execute(_id, params) {
      const p = params as Record<string, unknown>;
      const creds = await getCreds(api, String(p.email), config);
      if ("error" in creds) return txt(creds.error);
      const result = await graphFetch(`/me/events/${String(p.eventId)}`, creds);
      return result.ok ? json(result.data) : txt(`Failed: ${result.error}`);
    },
  });

  // 4. outlook_cal_create_event
  api.registerTool({
    name: "outlook_cal_create_event",
    label: "Outlook Calendar: Create Event",
    description:
      "Create a new Outlook calendar event. Shows confirmation prompt unless approved=true. " +
      "Supports Teams online meetings with isOnlineMeeting=true.",
    parameters: OutlookCalCreateSchema,
    async execute(_id, params) {
      const p = params as Record<string, unknown>;

      const needsApproval = requireApproval && !p.approved;
      if (needsApproval) {
        const attendeeNote = p.attendees ? `\nAttendees: ${p.attendees}` : "";
        const summary =
          `Create Outlook event: "${p.title}"\nStart: ${p.start} → End: ${p.end}` +
          (p.location ? `\nLocation: ${p.location}` : "") +
          (p.isOnlineMeeting ? "\nOnline meeting: Yes" : "") +
          attendeeNote;
        const entry = createPending({
          provider: "outlook",
          payload: { ...p, _action: "cal_create", config },
          summary,
        });
        const prompt = buildApprovalPrompt(entry).replace(
          "📧 **Email ready to send**",
          "📅 **Outlook event ready to create**",
        );
        return txt(prompt);
      }

      const creds = await getCreds(api, String(p.email), config);
      if ("error" in creds) return txt(creds.error);
      return await _executeOutlookCalCreate(p, config, api);
    },
  });

  // 5. outlook_cal_update_event
  api.registerTool({
    name: "outlook_cal_update_event",
    label: "Outlook Calendar: Update Event",
    description: "Update an Outlook calendar event. Shows confirmation unless approved=true.",
    parameters: OutlookCalUpdateSchema,
    async execute(_id, params) {
      const p = params as Record<string, unknown>;

      const needsApproval = requireApproval && !p.approved;
      if (needsApproval) {
        const changes: string[] = [];
        if (p.title) changes.push(`title → "${p.title}"`);
        if (p.start) changes.push(`start → ${p.start}`);
        if (p.end) changes.push(`end → ${p.end}`);
        if (p.location) changes.push(`location → ${p.location}`);
        const summary = `Update Outlook event ${p.eventId}:\n${changes.join("\n")}`;
        const entry = createPending({
          provider: "outlook",
          payload: { ...p, _action: "cal_update", config },
          summary,
        });
        const prompt = buildApprovalPrompt(entry).replace(
          "📧 **Email ready to send**",
          "📅 **Outlook event update ready**",
        );
        return txt(prompt);
      }

      const creds = await getCreds(api, String(p.email), config);
      if ("error" in creds) return txt(creds.error);

      const updates: Record<string, unknown> = {};
      if (p.title) updates.subject = String(p.title);
      if (p.start)
        updates.start = { dateTime: String(p.start), timeZone: String(p.timeZone ?? "UTC") };
      if (p.end) updates.end = { dateTime: String(p.end), timeZone: String(p.timeZone ?? "UTC") };
      if (p.description) updates.body = { contentType: "Text", content: String(p.description) };
      if (p.location) updates.location = { displayName: String(p.location) };

      const result = await graphFetch(`/me/events/${String(p.eventId)}`, creds, {
        method: "PATCH",
        body: updates,
      });
      return result.ok ? json(result.data) : txt(`Failed: ${result.error}`);
    },
  });

  // 6. outlook_cal_delete_event
  api.registerTool({
    name: "outlook_cal_delete_event",
    label: "Outlook Calendar: Delete Event",
    description: "Delete an Outlook calendar event.",
    parameters: OutlookCalDeleteSchema,
    async execute(_id, params) {
      const p = params as Record<string, unknown>;
      const creds = await getCreds(api, String(p.email), config);
      if ("error" in creds) return txt(creds.error);
      const result = await graphFetch(`/me/events/${String(p.eventId)}`, creds, {
        method: "DELETE",
      });
      return result.ok ? txt("Event deleted.") : txt(`Failed: ${result.error}`);
    },
  });

  // 7. outlook_cal_rsvp
  api.registerTool({
    name: "outlook_cal_rsvp",
    label: "Outlook Calendar: RSVP",
    description: "Accept, tentatively accept, or decline an Outlook calendar invitation.",
    parameters: OutlookCalRsvpSchema,
    async execute(_id, params) {
      const p = params as Record<string, unknown>;
      const creds = await getCreds(api, String(p.email), config);
      if ("error" in creds) return txt(creds.error);

      const action = String(p.response); // accept | tentativelyAccept | decline
      const result = await graphFetch(`/me/events/${String(p.eventId)}/${action}`, creds, {
        method: "POST",
        body: {
          comment: p.comment ? String(p.comment) : "",
          sendResponse: p.sendResponse !== false,
        },
      });
      return result.ok ? txt(`RSVP "${action}" sent.`) : txt(`Failed: ${result.error}`);
    },
  });

  // 8. outlook_cal_find_free_slots
  api.registerTool({
    name: "outlook_cal_find_free_slots",
    label: "Outlook Calendar: Find Free Slots",
    description:
      "Find available meeting time slots using Microsoft Graph free/busy API. " +
      "Useful for scheduling flows with attendees.",
    parameters: OutlookCalFreeBusySchema,
    async execute(_id, params) {
      const p = params as Record<string, unknown>;
      const creds = await getCreds(api, String(p.email), config);
      if ("error" in creds) return txt(creds.error);

      const durationMinutes = Number(p.durationMinutes ?? 60);
      const attendeeEmails = p.attendeeEmails
        ? String(p.attendeeEmails)
            .split(",")
            .map((e) => ({ type: "required", emailAddress: { address: e.trim() } }))
        : [{ type: "required", emailAddress: { address: creds.email } }];

      const result = await graphFetch("/me/findMeetingTimes", creds, {
        method: "POST",
        body: {
          attendees: attendeeEmails,
          timeConstraint: {
            activityDomain: "work",
            timeSlots: [
              {
                start: { dateTime: String(p.startDateTime), timeZone: "UTC" },
                end: { dateTime: String(p.endDateTime), timeZone: "UTC" },
              },
            ],
          },
          meetingDuration: `PT${durationMinutes}M`,
          returnSuggestionReasons: true,
          minimumAttendeePercentage: 100,
        },
      });
      return result.ok ? json(result.data) : txt(`Failed: ${result.error}`);
    },
  });

  // 9. outlook_cal_search
  api.registerTool({
    name: "outlook_cal_search",
    label: "Outlook Calendar: Search Events",
    description: "Search Outlook calendar events by subject or content.",
    parameters: OutlookCalSearchSchema,
    async execute(_id, params) {
      const p = params as Record<string, unknown>;
      const creds = await getCreds(api, String(p.email), config);
      if ("error" in creds) return txt(creds.error);

      const top = Number(p.top ?? 20);
      const query = encodeURIComponent(String(p.query));
      let endpoint = `/me/events?$search="${query}"&$top=${top}&$select=id,subject,start,end,location,organizer`;

      if (p.startDateTime || p.endDateTime) {
        // Use calendarView for date-bounded search
        const start = String(p.startDateTime ?? new Date(0).toISOString());
        const end = String(p.endDateTime ?? new Date(Date.now() + 365 * 86400_000).toISOString());
        endpoint =
          `/me/calendarView?startDateTime=${encodeURIComponent(start)}&endDateTime=${encodeURIComponent(end)}` +
          `&$search="${query}"&$top=${top}&$select=id,subject,start,end,location,organizer`;
      }

      const result = await graphFetch(endpoint, creds);
      return result.ok ? json(result.data) : txt(`Failed: ${result.error}`);
    },
  });
}

// ── Internal executor ─────────────────────────────────────────────────

export async function _executeOutlookCalCreate(
  p: Record<string, unknown>,
  config: OutlookOAuthConfig,
  api: MinionPluginApi,
): Promise<ReturnType<typeof txt>> {
  const ctx = api.runtime as unknown as Record<string, unknown>;
  const agentId = ctx.agentId as string;
  const sessionKey = ctx.sessionKey as string;
  const creds = await getValidOutlookCredentials(agentId, sessionKey, String(p.email), config);
  if (!creds) return txt(`Outlook credentials not found for ${p.email}.`);

  const eventBody = buildEventBody(p);
  const calPath = p.calendarId ? `/me/calendars/${String(p.calendarId)}/events` : "/me/events";
  const result = await graphFetch(calPath, creds, { method: "POST", body: eventBody });
  return result.ok ? json(result.data) : txt(`Failed: ${result.error}`);
}
