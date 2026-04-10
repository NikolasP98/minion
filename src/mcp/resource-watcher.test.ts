import { describe, it, expect, vi, afterEach } from "vitest";
import {
  DbIssuesAssignedWatcher,
  assignmentBus,
  ASSIGNMENT_EVENT,
  defaultWatcherFactory,
  DB_ISSUES_ASSIGNED_URI,
} from "./resource-watcher.js";

afterEach(() => {
  // Remove all test listeners to prevent cross-test pollution
  assignmentBus.removeAllListeners(ASSIGNMENT_EVENT);
});

describe("DbIssuesAssignedWatcher", () => {
  it("calls onChange('updated') when an assignment event fires", () => {
    const watcher = new DbIssuesAssignedWatcher();
    const handler = vi.fn();
    watcher.start(handler);

    assignmentBus.emit(ASSIGNMENT_EVENT);
    expect(handler).toHaveBeenCalledOnce();
    expect(handler).toHaveBeenCalledWith("updated");

    watcher.stop();
  });

  it("does not call onChange after stop()", () => {
    const watcher = new DbIssuesAssignedWatcher();
    const handler = vi.fn();
    watcher.start(handler);
    watcher.stop();

    assignmentBus.emit(ASSIGNMENT_EVENT);
    expect(handler).not.toHaveBeenCalled();
  });

  it("can be restarted after stop()", () => {
    const watcher = new DbIssuesAssignedWatcher();
    const handler = vi.fn();

    watcher.start(handler);
    watcher.stop();
    watcher.start(handler);

    assignmentBus.emit(ASSIGNMENT_EVENT);
    expect(handler).toHaveBeenCalledOnce();

    watcher.stop();
  });

  it("multiple independent watchers each fire their own handler", () => {
    const w1 = new DbIssuesAssignedWatcher();
    const w2 = new DbIssuesAssignedWatcher();
    const h1 = vi.fn();
    const h2 = vi.fn();

    w1.start(h1);
    w2.start(h2);

    assignmentBus.emit(ASSIGNMENT_EVENT);
    expect(h1).toHaveBeenCalledOnce();
    expect(h2).toHaveBeenCalledOnce();

    w1.stop();
    w2.stop();
  });
});

describe("defaultWatcherFactory", () => {
  it("returns a DbIssuesAssignedWatcher for the canonical URI", () => {
    const watcher = defaultWatcherFactory(DB_ISSUES_ASSIGNED_URI);
    expect(watcher).toBeInstanceOf(DbIssuesAssignedWatcher);
  });

  it("returns null for unknown URIs", () => {
    expect(defaultWatcherFactory("db://other/thing")).toBeNull();
    expect(defaultWatcherFactory("files:///etc/passwd")).toBeNull();
    expect(defaultWatcherFactory("")).toBeNull();
  });
});
