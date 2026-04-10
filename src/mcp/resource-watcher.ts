/**
 * ResourceWatcher implementations for MCP 1.1 resource subscriptions.
 *
 * DbIssuesAssignedWatcher — watches `db://issues/assigned` and notifies
 * subscribers when a new session run starts (i.e., a new task is assigned
 * to an agent).  Driven by the `assignmentBus` EventEmitter that server-core
 * emits into when `addChatRun` fires.
 */

import { EventEmitter } from "node:events";
import type { ResourceChangeHandler, ResourceWatcher } from "./subscription-registry.js";

/**
 * Shared in-process event bus for session assignment events.
 * server-core/server-runtime-state wires `addChatRun` to emit on this bus.
 */
export const assignmentBus: EventEmitter = new EventEmitter();
assignmentBus.setMaxListeners(256);

export const ASSIGNMENT_EVENT = "session:assigned";

/** URI handled by DbIssuesAssignedWatcher */
export const DB_ISSUES_ASSIGNED_URI = "db://issues/assigned";

/**
 * Watches `db://issues/assigned`.
 * Calls onChange("updated") each time the assignment bus fires.
 */
export class DbIssuesAssignedWatcher implements ResourceWatcher {
  private listener: (() => void) | null = null;

  start(onChange: ResourceChangeHandler): void {
    this.listener = () => onChange("updated");
    assignmentBus.on(ASSIGNMENT_EVENT, this.listener);
  }

  stop(): void {
    if (this.listener) {
      assignmentBus.off(ASSIGNMENT_EVENT, this.listener);
      this.listener = null;
    }
  }
}

/**
 * Default watcher factory. Returns a watcher for known db:// URIs, null otherwise.
 */
export function defaultWatcherFactory(uri: string): ResourceWatcher | null {
  if (uri === DB_ISSUES_ASSIGNED_URI) {
    return new DbIssuesAssignedWatcher();
  }
  return null;
}
