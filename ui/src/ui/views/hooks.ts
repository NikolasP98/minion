import { html, nothing } from "lit";
import { formatRelativeTimestamp } from "../format.ts";
import { icons } from "../icons.ts";
import type { HookEvent } from "../types.ts";
import type { HooksWizardStep } from "../ui-types.ts";

export type HooksProps = {
  connected: boolean;
  loading: boolean;
  events: HookEvent[];
  error: string | null;
  testBusy: boolean;
  testResult: string | null;
  testError: string | null;
  wizardStep: HooksWizardStep;
  /** HTTP base URL of the gateway, e.g. https://gateway.example.com */
  gatewayHttpUrl: string;
  /** hooks.token from gateway config, if available */
  hooksToken: string | null;
  /** hooks.github.secret from gateway config, if available */
  githubSecret: string | null;
  /** hooks.enabled from gateway config */
  hooksEnabled: boolean | null;
  onRefresh: () => void;
  onTest: () => void;
  onWizardStep: (step: HooksWizardStep) => void;
};

function buildWebhookUrl(props: HooksProps): string {
  const base = props.gatewayHttpUrl.replace(/\/$/, "");
  const token = props.hooksToken ?? "";
  return token ? `${base}/api/hooks/github?token=${encodeURIComponent(token)}` : `${base}/api/hooks/github`;
}

async function copyToClipboard(text: string) {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    // Best effort
  }
}

function renderStep1(props: HooksProps) {
  const webhookUrl = buildWebhookUrl(props);
  const hasToken = Boolean(props.hooksToken);

  return html`
    <div class="card">
      <div class="card-title">Step 1 — Webhook URL</div>
      <div class="card-sub">
        This is the endpoint GitHub will call when events occur. Copy it for use in the next step.
      </div>

      ${
        !hasToken
          ? html`<div class="callout danger" style="margin-top: 12px;">
              No webhook token configured. Set <code>hooks.token</code> in your gateway config before exposing this endpoint publicly.
            </div>`
          : nothing
      }

      ${
        props.hooksEnabled === false
          ? html`<div class="callout danger" style="margin-top: 12px;">
              Webhooks are disabled (<code>hooks.enabled: false</code>). Enable them in your gateway config.
            </div>`
          : nothing
      }

      <div class="form-grid" style="margin-top: 16px;">
        <label class="field">
          <span class="field-label">Webhook URL</span>
          <div class="row" style="gap: 6px;">
            <input
              class="input mono"
              type="text"
              readonly
              .value=${webhookUrl}
              style="flex: 1; font-size: 12px;"
            />
            <button
              class="btn"
              title="Copy URL"
              @click=${() => void copyToClipboard(webhookUrl)}
            >
              <span style="display:flex;align-items:center;gap:4px;">${icons.copy} Copy</span>
            </button>
          </div>
        </label>

        ${
          props.githubSecret
            ? html`
              <label class="field">
                <span class="field-label">Webhook Secret (configured)</span>
                <input
                  class="input mono"
                  type="password"
                  readonly
                  .value=${props.githubSecret}
                  style="font-size: 12px;"
                />
              </label>
            `
            : html`
              <div class="field">
                <span class="field-label">Webhook Secret</span>
                <div class="muted" style="font-size: 13px;">
                  Optional. Add <code>hooks.github.secret</code> to your config to validate payload signatures.
                </div>
              </div>
            `
        }
      </div>

      <div class="row" style="margin-top: 16px;">
        <button class="btn btn--primary" @click=${() => props.onWizardStep(2)}>
          Next: Configure GitHub →
        </button>
      </div>
    </div>
  `;
}

function renderStep2(props: HooksProps) {
  const webhookUrl = buildWebhookUrl(props);

  return html`
    <div class="card">
      <div class="card-title">Step 2 — Configure GitHub Webhook</div>
      <div class="card-sub">
        Go to your GitHub repository → Settings → Webhooks → Add webhook.
      </div>

      <div class="status-list" style="margin-top: 16px;">
        <div>
          <span class="label">Payload URL</span>
          <span class="mono" style="font-size: 12px; word-break: break-all;">${webhookUrl}</span>
        </div>
        <div>
          <span class="label">Content type</span>
          <span class="mono">application/json</span>
        </div>
        <div>
          <span class="label">Secret</span>
          <span>${props.githubSecret ? "Use the secret from Step 1" : "Leave blank (or add one to config)"}</span>
        </div>
        <div>
          <span class="label">Events</span>
          <span>push, pull_request, issues (or "Send me everything")</span>
        </div>
        <div>
          <span class="label">Active</span>
          <span>✓ Checked</span>
        </div>
      </div>

      <div class="callout" style="margin-top: 12px;">
        After saving the webhook on GitHub, come back here and click Next to test the connection.
      </div>

      <div class="row" style="margin-top: 16px; gap: 8px;">
        <button class="btn" @click=${() => props.onWizardStep(1)}>← Back</button>
        <button class="btn btn--primary" @click=${() => props.onWizardStep(3)}>
          Next: Test Connection →
        </button>
      </div>
    </div>
  `;
}

function renderStep3(props: HooksProps) {
  return html`
    <div class="card">
      <div class="card-title">Step 3 — Test Connection</div>
      <div class="card-sub">
        Send a test event to confirm the gateway is receiving GitHub webhooks.
      </div>

      <div style="margin-top: 16px;">
        <button
          class="btn btn--primary"
          ?disabled=${props.testBusy || !props.connected}
          @click=${props.onTest}
        >
          ${props.testBusy ? "Sending…" : "Send Test Event"}
        </button>
      </div>

      ${
        props.testResult
          ? html`<div class="callout" style="margin-top: 12px;">
              ${props.testResult}
            </div>`
          : nothing
      }

      ${
        props.testError
          ? html`<div class="callout danger" style="margin-top: 12px;">
              ${props.testError}
            </div>`
          : nothing
      }

      <div class="row" style="margin-top: 16px; gap: 8px;">
        <button class="btn" @click=${() => props.onWizardStep(2)}>← Back</button>
        <button
          class="btn btn--primary"
          ?disabled=${!props.testResult}
          @click=${() => props.onWizardStep(4)}
        >
          Next: Done →
        </button>
      </div>
    </div>
  `;
}

function renderStep4(props: HooksProps) {
  return html`
    <div class="card">
      <div class="card-title">Step 4 — All Set!</div>
      <div class="card-sub">
        Your agent is now listening for GitHub webhook events.
      </div>

      <div class="callout" style="margin-top: 12px;">
        Events from GitHub will appear in the Event Log below. Supported event types:
        <strong>push</strong>, <strong>pull_request</strong>, <strong>issues</strong>.
      </div>

      <div class="row" style="margin-top: 16px; gap: 8px;">
        <button class="btn" @click=${() => props.onWizardStep(3)}>← Back</button>
        <button class="btn btn--primary" @click=${props.onRefresh}>
          Refresh Event Log
        </button>
      </div>
    </div>
  `;
}

function renderStatusBadge(status: HookEvent["status"]) {
  switch (status) {
    case "dispatched":
      return html`<span class="pill ok" style="font-size: 11px;">dispatched</span>`;
    case "skipped":
      return html`<span class="pill" style="font-size: 11px;">skipped</span>`;
    case "error":
      return html`<span class="pill danger" style="font-size: 11px;">error</span>`;
  }
}

function renderEventLog(props: HooksProps) {
  return html`
    <div class="card">
      <div class="card-title">Event Log</div>
      <div class="card-sub">Last 100 incoming webhook events from GitHub.</div>

      <div class="row" style="margin-top: 12px;">
        <button class="btn" ?disabled=${props.loading} @click=${props.onRefresh}>
          ${props.loading ? "Refreshing…" : "Refresh"}
        </button>
        ${props.error ? html`<span class="muted">${props.error}</span>` : nothing}
      </div>

      ${
        props.events.length === 0
          ? html`<div class="muted" style="margin-top: 16px; font-size: 13px;">
              No events received yet. Complete the setup wizard above, then trigger an event from GitHub.
            </div>`
          : html`
            <div class="table-wrap" style="margin-top: 16px;">
              <table class="table">
                <thead>
                  <tr>
                    <th>Time</th>
                    <th>Event</th>
                    <th>Repository</th>
                    <th>Status</th>
                    <th>Detail</th>
                  </tr>
                </thead>
                <tbody>
                  ${props.events.map(
                    (ev) => html`
                      <tr>
                        <td class="mono" style="white-space: nowrap; font-size: 12px;">
                          ${formatRelativeTimestamp(ev.ts)}
                        </td>
                        <td class="mono" style="font-size: 12px;">${ev.eventType}</td>
                        <td style="font-size: 12px;">${ev.repo ?? "—"}</td>
                        <td>${renderStatusBadge(ev.status)}</td>
                        <td class="muted" style="font-size: 12px;">${ev.detail ?? ""}</td>
                      </tr>
                    `,
                  )}
                </tbody>
              </table>
            </div>
          `
      }
    </div>
  `;
}

function renderWizardProgress(step: HooksWizardStep, onStep: (s: HooksWizardStep) => void) {
  const steps: Array<{ n: HooksWizardStep; label: string }> = [
    { n: 1, label: "URL" },
    { n: 2, label: "Configure" },
    { n: 3, label: "Test" },
    { n: 4, label: "Done" },
  ];

  return html`
    <div class="row" style="gap: 0; margin-bottom: 16px; align-items: center;">
      ${steps.map(({ n, label }, i) =>
        html`
          <button
            class="btn ${step === n ? "btn--primary" : ""}"
            style="border-radius: ${i === 0 ? "6px 0 0 6px" : i === steps.length - 1 ? "0 6px 6px 0" : "0"}; border-left: ${i > 0 ? "none" : ""};"
            @click=${() => onStep(n)}
          >
            ${n}. ${label}
          </button>
        `,
      )}
    </div>
  `;
}

export function renderHooks(props: HooksProps) {
  const wizardContent =
    props.wizardStep === 1
      ? renderStep1(props)
      : props.wizardStep === 2
        ? renderStep2(props)
        : props.wizardStep === 3
          ? renderStep3(props)
          : renderStep4(props);

  return html`
    <section class="grid grid-cols-1" style="max-width: 720px;">
      <div class="card">
        <div class="card-title">Setup Wizard</div>
        <div class="card-sub">Follow the steps to connect a GitHub repository to your agent.</div>
        ${renderWizardProgress(props.wizardStep, props.onWizardStep)}
      </div>

      ${wizardContent}

      ${renderEventLog(props)}
    </section>
  `;
}
