import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  expandHomePrefix,
  resolveEffectiveHomeDir,
  resolveIsInDocker,
  resolveRequiredHomeDir,
} from "./home-dir.js";

// Helper: simulate a non-Docker environment for tests that run inside Docker CI.
const notInDocker = () => false;
const inDocker = () => true;

describe("resolveIsInDocker", () => {
  it("returns true when MINION_IN_DOCKER=1", () => {
    expect(resolveIsInDocker({ MINION_IN_DOCKER: "1" } as NodeJS.ProcessEnv, notInDocker)).toBe(
      true,
    );
  });

  it("returns true when /.dockerenv exists", () => {
    expect(resolveIsInDocker({} as NodeJS.ProcessEnv, inDocker)).toBe(true);
  });

  it("returns false when neither MINION_IN_DOCKER nor /.dockerenv is set", () => {
    expect(resolveIsInDocker({} as NodeJS.ProcessEnv, notInDocker)).toBe(false);
  });

  it("returns false when existsSync throws", () => {
    const throws = () => {
      throw new Error("permission denied");
    };
    expect(resolveIsInDocker({} as NodeJS.ProcessEnv, throws)).toBe(false);
  });
});

describe("resolveEffectiveHomeDir", () => {
  it("prefers MINION_HOME over HOME and USERPROFILE", () => {
    const env = {
      MINION_HOME: "/srv/minion-home",
      HOME: "/home/other",
      USERPROFILE: "C:/Users/other",
    } as NodeJS.ProcessEnv;

    expect(resolveEffectiveHomeDir(env, () => "/fallback", notInDocker)).toBe(
      path.resolve("/srv/minion-home"),
    );
  });

  it("falls back to HOME then USERPROFILE then homedir (non-Docker)", () => {
    expect(
      resolveEffectiveHomeDir({ HOME: "/home/alice" } as NodeJS.ProcessEnv, () => "", notInDocker),
    ).toBe(path.resolve("/home/alice"));
    expect(
      resolveEffectiveHomeDir(
        { USERPROFILE: "C:/Users/alice" } as NodeJS.ProcessEnv,
        () => "",
        notInDocker,
      ),
    ).toBe(path.resolve("C:/Users/alice"));
    expect(
      resolveEffectiveHomeDir({} as NodeJS.ProcessEnv, () => "/fallback", notInDocker),
    ).toBe(path.resolve("/fallback"));
  });

  it("expands MINION_HOME when set to ~", () => {
    const env = {
      MINION_HOME: "~/svc",
      HOME: "/home/alice",
    } as NodeJS.ProcessEnv;

    expect(resolveEffectiveHomeDir(env, () => "", notInDocker)).toBe(
      path.resolve("/home/alice/svc"),
    );
  });

  describe("Docker mode", () => {
    it("redirects /root to /home/node when HOME is absent inside Docker", () => {
      expect(
        resolveEffectiveHomeDir({} as NodeJS.ProcessEnv, () => "/root", inDocker),
      ).toBe(path.resolve("/home/node"));
    });

    it("redirects /root to /home/node when HOME=/root inside Docker", () => {
      expect(
        resolveEffectiveHomeDir({ HOME: "/root" } as NodeJS.ProcessEnv, () => "", inDocker),
      ).toBe(path.resolve("/home/node"));
    });

    it("respects explicit HOME=/home/node inside Docker", () => {
      expect(
        resolveEffectiveHomeDir({ HOME: "/home/node" } as NodeJS.ProcessEnv, () => "", inDocker),
      ).toBe(path.resolve("/home/node"));
    });

    it("respects custom HOME (non-root) inside Docker", () => {
      expect(
        resolveEffectiveHomeDir(
          { HOME: "/data/custom" } as NodeJS.ProcessEnv,
          () => "",
          inDocker,
        ),
      ).toBe(path.resolve("/data/custom"));
    });

    it("respects MINION_HOME over Docker default", () => {
      expect(
        resolveEffectiveHomeDir(
          { MINION_HOME: "/srv/override" } as NodeJS.ProcessEnv,
          () => "",
          inDocker,
        ),
      ).toBe(path.resolve("/srv/override"));
    });
  });
});

describe("resolveRequiredHomeDir", () => {
  it("returns cwd when no home source is available", () => {
    expect(
      resolveRequiredHomeDir(
        {} as NodeJS.ProcessEnv,
        () => {
          throw new Error("no home");
        },
        notInDocker,
      ),
    ).toBe(process.cwd());
  });

  it("returns a fully resolved path for MINION_HOME", () => {
    const result = resolveRequiredHomeDir(
      { MINION_HOME: "/custom/home" } as NodeJS.ProcessEnv,
      () => "/fallback",
      notInDocker,
    );
    expect(result).toBe(path.resolve("/custom/home"));
  });

  it("returns cwd when MINION_HOME is tilde-only and no fallback home exists", () => {
    expect(
      resolveRequiredHomeDir(
        { MINION_HOME: "~" } as NodeJS.ProcessEnv,
        () => {
          throw new Error("no home");
        },
        notInDocker,
      ),
    ).toBe(process.cwd());
  });

  it("returns /home/node inside Docker when HOME is absent", () => {
    expect(
      resolveRequiredHomeDir(
        {} as NodeJS.ProcessEnv,
        () => {
          throw new Error("no home");
        },
        inDocker,
      ),
    ).toBe(path.resolve("/home/node"));
  });
});

describe("expandHomePrefix", () => {
  it("expands tilde using effective home", () => {
    const value = expandHomePrefix("~/x", {
      env: { MINION_HOME: "/srv/minion-home" } as NodeJS.ProcessEnv,
    });
    expect(value).toBe(`${path.resolve("/srv/minion-home")}/x`);
  });

  it("keeps non-tilde values unchanged", () => {
    expect(expandHomePrefix("/tmp/x")).toBe("/tmp/x");
  });
});
