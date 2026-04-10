/**
 * Validation Harness Hook Handler
 *
 * Fires on message:sent events. Runs quality assertions on the agent's output,
 * writes JSON + Markdown artifacts to the workspace, and appends the Markdown
 * summary to event.messages so it is included in the response.
 *
 * Per QA Spec MIN-170 (spec Sections 6.2 and 7).
 */

import os from "node:os";
import path from "node:path";
import { resolveAgentWorkspaceDir } from "../../../agents/agent-scope.js";
import type { MinionConfig } from "../../../config/config.js";
import { resolveStateDir } from "../../../config/paths.js";
import { createSubsystemLogger } from "../../../logging/subsystem.js";
import { resolveAgentIdFromSessionKey } from "../../../routing/session-key.js";
import { formatMarkdownSummary } from "../../../validation-harness/artifacts.js";
import { runValidationHarness } from "../../../validation-harness/runner.js";
import type { HookHandler } from "../../hooks.js";

const log = createSubsystemLogger("hooks/validation-harness");

const validationHarnessHandler: HookHandler = async (event) => {
  // Only handle message:sent events for successful sends
  if (event.type !== "message" || event.action !== "sent") {
    return;
  }
  const context = event.context || {};
  if (!(context.success as boolean)) {
    return;
  }

  const content = (context.content as string) || "";
  if (!content.trim()) {
    return;
  }

  try {
    const cfg = context.cfg as MinionConfig | undefined;
    const agentId = resolveAgentIdFromSessionKey(event.sessionKey) ?? "unknown";
    const workspaceDir = cfg
      ? resolveAgentWorkspaceDir(cfg, agentId)
      : path.join(
          resolveStateDir(process.env, () => os.homedir()),
          "workspace",
        );
    const validationDir = path.join(workspaceDir, "memory", "validation");

    // Use runId from context if available, else fall back to sessionKey + timestamp
    const taskId = (context.runId as string) || `${event.sessionKey}-${event.timestamp.getTime()}`;

    const taskMetadata = (context.taskMetadata as Record<string, unknown>) || {};

    const result = await runValidationHarness({
      taskId,
      agentId,
      content,
      taskMetadata,
      outputDir: validationDir,
    });

    // Append Markdown summary to event.messages so it is delivered as a response comment
    event.messages.push(formatMarkdownSummary(result));

    log.info("Validation harness complete", {
      taskId,
      grade: result.summary.grade,
      score: result.summary.score.toFixed(3),
    });
  } catch (err) {
    log.error("Validation harness failed", { error: String(err) });
  }
};

export default validationHarnessHandler;
