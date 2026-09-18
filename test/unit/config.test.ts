import { afterAll, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  BUDGETS,
  DEFAULT_CONFIG,
  isInteractive,
  loadConfig,
  resolveApiKey,
  resolveStateDir,
} from "../../src/shared/config.ts";
import { DEFAULT_THRESHOLDS } from "../../src/shared/policy.ts";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const TMP_ROOT = join(ROOT, "test", ".tmp");
mkdirSync(TMP_ROOT, { recursive: true });

const created: string[] = [];

function tmp(prefix: string): string {
  const dir = mkdtempSync(join(TMP_ROOT, `${prefix}-`));
  created.push(dir);
  return dir;
}

/** A state dir with an optional config.json and credentials.json already in it. */
function stateDir(files: { config?: unknown; credentials?: unknown | string } = {}): string {
  const dir = tmp("state");
  if (files.config !== undefined) {
    writeFileSync(
      join(dir, "config.json"),
      typeof files.config === "string" ? files.config : JSON.stringify(files.config),
    );
  }
  if (files.credentials !== undefined) {
    writeFileSync(
      join(dir, "credentials.json"),
      typeof files.credentials === "string" ? files.credentials : JSON.stringify(files.credentials),
    );
  }
  return dir;
}

function projectDir(jev?: unknown): string {
  const dir = tmp("project");
  if (jev !== undefined) {
    writeFileSync(join(dir, ".jev.json"), typeof jev === "string" ? jev : JSON.stringify(jev));
  }
  return dir;
}

afterAll(() => {
  for (const dir of created) rmSync(dir, { recursive: true, force: true });
});

describe("DEFAULT_CONFIG", () => {
  it("matches the documented defaults", () => {
    expect(DEFAULT_CONFIG).toMatchObject({
      enforcement: "standard",
      authority: "autonomous",
      fail: "open",
      confAxis: "confidence",
      model: undefined,
      baseUrl: undefined,
      stateDir: undefined,
      retainDays: 7,
      debug: false,
      timeoutMs: 6000,
      planReview: true,
      planMaxDenies: 2,
      router: "stated",
      routerMaxPerTurn: 1,
      mutationGate: false,
      stopBackstop: false,
      bashGate: true,
      dependencyGate: true,
      subagentSkip: ["statusline-setup", "output-style-setup", "claude-code-guide"],
    });
    expect(DEFAULT_CONFIG.thresholds).toBe(DEFAULT_THRESHOLDS);
  });
});

describe("loadConfig precedence", () => {
  it("returns the defaults when nothing is configured", () => {
    const cfg = loadConfig({ cwd: projectDir(), env: { JEV_STATE_DIR: stateDir() } });
    expect(cfg).toEqual({ ...DEFAULT_CONFIG, stateDir: expect.any(String) });
  });

  it("applies the user file over the defaults", () => {
    const dir = stateDir({ config: { enforcement: "soft", retainDays: 30, debug: true } });
    const cfg = loadConfig({ cwd: projectDir(), env: { JEV_STATE_DIR: dir } });
    expect(cfg.enforcement).toBe("soft");
    expect(cfg.retainDays).toBe(30);
    expect(cfg.debug).toBe(true);
    expect(cfg.authority).toBe("autonomous");
  });

  it("applies the project file over the user file", () => {
    const dir = stateDir({ config: { enforcement: "soft", authority: "advisory" } });
    const cwd = projectDir({ enforcement: "strict" });
    const cfg = loadConfig({ cwd, env: { JEV_STATE_DIR: dir } });
    expect(cfg.enforcement).toBe("strict");
    expect(cfg.authority).toBe("advisory");
  });

  it("applies CLAUDE_PLUGIN_OPTION_* over the project file", () => {
    const cwd = projectDir({ enforcement: "soft", router: "off" });
    const cfg = loadConfig({
      cwd,
      env: { JEV_STATE_DIR: stateDir(), CLAUDE_PLUGIN_OPTION_ENFORCEMENT: "standard" },
    });
    expect(cfg.enforcement).toBe("standard");
    expect(cfg.router).toBe("off");
  });

  it("applies JEV_*/TYPESAFE_* over CLAUDE_PLUGIN_OPTION_*", () => {
    const cfg = loadConfig({
      cwd: projectDir(),
      env: {
        JEV_STATE_DIR: stateDir(),
        CLAUDE_PLUGIN_OPTION_ENFORCEMENT: "soft",
        CLAUDE_PLUGIN_OPTION_MODEL: "option-model",
        JEV_ENFORCEMENT: "strict",
        TYPESAFE_DEFAULT_MODEL: "env-model",
        TYPESAFE_BASE_URL: "http://127.0.0.1:9999",
      },
    });
    expect(cfg.enforcement).toBe("strict");
    expect(cfg.model).toBe("env-model");
    expect(cfg.baseUrl).toBe("http://127.0.0.1:9999");
  });

  it("never reads an api key out of a config file", () => {
    const dir = stateDir({ config: { apiKey: "sk-from-user-file" } });
    const cwd = projectDir({ apiKey: "sk-from-project-file" });
    const cfg = loadConfig({ cwd, env: { JEV_STATE_DIR: dir } });
    expect(JSON.stringify(cfg)).not.toContain("sk-from");
    expect(resolveApiKey(cfg, { JEV_STATE_DIR: dir }).source).toBe("none");
  });
});

describe("loadConfig robustness", () => {
  it("ignores a malformed user file", () => {
    const dir = stateDir({ config: "{ not json" });
    const cfg = loadConfig({ cwd: projectDir(), env: { JEV_STATE_DIR: dir } });
    expect(cfg.enforcement).toBe("standard");
  });

  it("ignores a malformed project file", () => {
    const cwd = projectDir("[[[");
    const cfg = loadConfig({ cwd, env: { JEV_STATE_DIR: stateDir() } });
    expect(cfg.enforcement).toBe("standard");
  });

  it("ignores a non-object project file", () => {
    const cwd = projectDir("42");
    expect(() => loadConfig({ cwd, env: { JEV_STATE_DIR: stateDir() } })).not.toThrow();
  });

  it("ignores an invalid enum and keeps the previous layer", () => {
    const dir = stateDir({ config: { enforcement: "soft", authority: "advisory" } });
    const cfg = loadConfig({
      cwd: projectDir(),
      env: { JEV_STATE_DIR: dir, JEV_ENFORCEMENT: "banana", JEV_AUTHORITY: "" },
    });
    expect(cfg.enforcement).toBe("soft");
    expect(cfg.authority).toBe("advisory");
  });

  it("ignores a non-numeric number", () => {
    const cfg = loadConfig({
      cwd: projectDir(),
      env: { JEV_STATE_DIR: stateDir(), JEV_TIMEOUT_MS: "soon" },
    });
    expect(cfg.timeoutMs).toBe(6000);
  });

  it("accepts booleans in every documented spelling", () => {
    const env = { JEV_STATE_DIR: stateDir() };
    const cwd = projectDir();
    for (const [raw, expected] of [
      ["1", true],
      ["TRUE", true],
      ["Yes", true],
      ["0", false],
      ["false", false],
      ["NO", false],
    ] as const) {
      expect(loadConfig({ cwd, env: { ...env, JEV_DEBUG: raw } }).debug).toBe(expected);
    }
    expect(loadConfig({ cwd, env: { ...env, JEV_DEBUG: "maybe" } }).debug).toBe(false);
  });

  it("reads JEV_SUBAGENT_SKIP as a comma list", () => {
    const cfg = loadConfig({
      cwd: projectDir(),
      env: { JEV_STATE_DIR: stateDir(), JEV_SUBAGENT_SKIP: "explore, plan ,  " },
    });
    expect(cfg.subagentSkip).toEqual(["explore", "plan"]);
  });
});

describe("thresholds", () => {
  it("deep-merges JEV_THRESHOLDS and leaves untouched sub-keys alone", () => {
    const cfg = loadConfig({
      cwd: projectDir(),
      env: {
        JEV_STATE_DIR: stateDir(),
        JEV_THRESHOLDS: JSON.stringify({ choice: { high: { proceed: 0.95 } }, injection: 0.5 }),
      },
    });
    expect(cfg.thresholds.choice.high.proceed).toBe(0.95);
    expect(cfg.thresholds.choice.high.confirm).toBe(DEFAULT_THRESHOLDS.choice.high.confirm);
    expect(cfg.thresholds.choice.low).toEqual(DEFAULT_THRESHOLDS.choice.low);
    expect(cfg.thresholds.injection).toBe(0.5);
    expect(cfg.thresholds.noul).toEqual(DEFAULT_THRESHOLDS.noul);
  });

  it("ignores malformed JEV_THRESHOLDS and non-numeric leaves", () => {
    const cfg = loadConfig({
      cwd: projectDir(),
      env: { JEV_STATE_DIR: stateDir(), JEV_THRESHOLDS: "{nope" },
    });
    expect(cfg.thresholds).toEqual(DEFAULT_THRESHOLDS);

    const cfg2 = loadConfig({
      cwd: projectDir(),
      env: { JEV_STATE_DIR: stateDir(), JEV_THRESHOLDS: JSON.stringify({ injection: "high" }) },
    });
    expect(cfg2.thresholds.injection).toBe(DEFAULT_THRESHOLDS.injection);
  });

  it("merges thresholds from a config file too, without mutating the defaults", () => {
    const dir = stateDir({ config: { thresholds: { router: { stated: 0.6 } } } });
    const cfg = loadConfig({ cwd: projectDir(), env: { JEV_STATE_DIR: dir } });
    expect(cfg.thresholds.router.stated).toBe(0.6);
    expect(cfg.thresholds.router.answer).toBe(DEFAULT_THRESHOLDS.router.answer);
    expect(DEFAULT_THRESHOLDS.router.stated).toBe(0.8);
  });
});

describe("strict-only gates", () => {
  it("leaves both gates off outside strict", () => {
    const cfg = loadConfig({ cwd: projectDir(), env: { JEV_STATE_DIR: stateDir() } });
    expect(cfg.mutationGate).toBe(false);
    expect(cfg.stopBackstop).toBe(false);
  });

  it("turns both on when the resolved enforcement is strict", () => {
    const dir = stateDir({ config: { enforcement: "strict" } });
    const cfg = loadConfig({ cwd: projectDir(), env: { JEV_STATE_DIR: dir } });
    expect(cfg.mutationGate).toBe(true);
    expect(cfg.stopBackstop).toBe(true);
  });

  it("lets the env force either way under strict", () => {
    const cfg = loadConfig({
      cwd: projectDir(),
      env: {
        JEV_STATE_DIR: stateDir(),
        JEV_ENFORCEMENT: "strict",
        JEV_MUTATION_GATE: "0",
        JEV_STOP_BACKSTOP: "no",
      },
    });
    expect(cfg.mutationGate).toBe(false);
    expect(cfg.stopBackstop).toBe(false);
  });

  it("lets the env force them on outside strict", () => {
    const cfg = loadConfig({
      cwd: projectDir(),
      env: { JEV_STATE_DIR: stateDir(), JEV_MUTATION_GATE: "true" },
    });
    expect(cfg.mutationGate).toBe(true);
    expect(cfg.stopBackstop).toBe(false);
  });
});

describe("resolveStateDir", () => {
  it("prefers the config value", () => {
    const cfg = { ...DEFAULT_CONFIG, stateDir: "/from/config" };
    expect(resolveStateDir(cfg, { JEV_STATE_DIR: "/from/env", CLAUDE_PLUGIN_DATA: "/from/plugin" })).toBe(
      "/from/config",
    );
  });

  it("falls back to JEV_STATE_DIR, then the home dir", () => {
    expect(resolveStateDir(DEFAULT_CONFIG, { JEV_STATE_DIR: "/from/env" })).toBe("/from/env");
    expect(resolveStateDir(DEFAULT_CONFIG, {})).toBe(join(homedir(), ".claude", "jev"));
  });

  it("ignores CLAUDE_PLUGIN_DATA, which only some of the surfaces are given", () => {
    // Honouring it split the plugin in half: hooks and the server wrote to the plugin data
    // dir while jev-doctor read ~/.claude/jev and reported "0 sessions, hooks not running".
    // Its value also carries the install id, so installing orphaned the existing ledger.
    expect(resolveStateDir(DEFAULT_CONFIG, { CLAUDE_PLUGIN_DATA: "/from/plugin" })).toBe(
      join(homedir(), ".claude", "jev"),
    );
    expect(
      resolveStateDir(DEFAULT_CONFIG, { JEV_STATE_DIR: "/from/env", CLAUDE_PLUGIN_DATA: "/from/plugin" }),
    ).toBe("/from/env");
  });

  it("treats a blank or unexpanded value as unset", () => {
    expect(resolveStateDir({ ...DEFAULT_CONFIG, stateDir: "   " }, { JEV_STATE_DIR: "/from/env" })).toBe(
      "/from/env",
    );
    expect(resolveStateDir(DEFAULT_CONFIG, { JEV_STATE_DIR: "${user_config.state_dir}" })).toBe(
      join(homedir(), ".claude", "jev"),
    );
  });
});

describe("resolveApiKey", () => {
  it("prefers TYPESAFE_API_KEY", () => {
    const dir = stateDir({ credentials: { apiKey: "sk-file" } });
    expect(
      resolveApiKey(DEFAULT_CONFIG, {
        JEV_STATE_DIR: dir,
        TYPESAFE_API_KEY: "sk-env",
        CLAUDE_PLUGIN_OPTION_API_KEY: "sk-option",
      }),
    ).toEqual({ key: "sk-env", source: "env" });
  });

  it("falls back to the plugin option, then the userConfig var", () => {
    expect(resolveApiKey(DEFAULT_CONFIG, { CLAUDE_PLUGIN_OPTION_API_KEY: "sk-option" })).toEqual({
      key: "sk-option",
      source: "plugin_option",
    });
    expect(resolveApiKey(DEFAULT_CONFIG, { JEV_USERCONFIG_API_KEY: "sk-uc" })).toEqual({
      key: "sk-uc",
      source: "plugin_option",
    });
  });

  it("reads credentials.json from the resolved state dir", () => {
    const dir = stateDir({ credentials: { apiKey: " sk-file " } });
    expect(resolveApiKey(DEFAULT_CONFIG, { JEV_STATE_DIR: dir })).toEqual({
      key: "sk-file",
      source: "credentials",
    });
    expect(resolveApiKey({ ...DEFAULT_CONFIG, stateDir: dir }, {})).toEqual({
      key: "sk-file",
      source: "credentials",
    });
  });

  it("reports none for an unexpanded placeholder, an empty value or whitespace", () => {
    const dir = stateDir();
    for (const raw of ["${user_config.api_key}", "  ${user_config.api_key}  ", "", "   "]) {
      expect(resolveApiKey(DEFAULT_CONFIG, { JEV_STATE_DIR: dir, TYPESAFE_API_KEY: raw })).toEqual({
        source: "none",
      });
      expect(
        resolveApiKey(DEFAULT_CONFIG, { JEV_STATE_DIR: dir, CLAUDE_PLUGIN_OPTION_API_KEY: raw }),
      ).toEqual({ source: "none" });
    }
  });

  it("falls through a placeholder to a real key further down", () => {
    const dir = stateDir({ credentials: { apiKey: "sk-file" } });
    expect(
      resolveApiKey(DEFAULT_CONFIG, { JEV_STATE_DIR: dir, TYPESAFE_API_KEY: "${user_config.api_key}" }),
    ).toEqual({ key: "sk-file", source: "credentials" });
  });

  it("never throws on a missing, malformed or keyless credentials file", () => {
    expect(resolveApiKey(DEFAULT_CONFIG, { JEV_STATE_DIR: stateDir() })).toEqual({ source: "none" });
    expect(resolveApiKey(DEFAULT_CONFIG, { JEV_STATE_DIR: stateDir({ credentials: "{oops" }) })).toEqual({
      source: "none",
    });
    expect(
      resolveApiKey(DEFAULT_CONFIG, { JEV_STATE_DIR: stateDir({ credentials: { apiKey: 42 } }) }),
    ).toEqual({ source: "none" });
    expect(
      resolveApiKey(DEFAULT_CONFIG, { JEV_STATE_DIR: join(TMP_ROOT, "does-not-exist") }),
    ).toEqual({ source: "none" });
  });
});

describe("isInteractive", () => {
  it("is false for non-human entrypoints", () => {
    for (const entrypoint of ["sdk-ts", "cli-print", "print", "headless", "cron", "SDK"]) {
      expect(isInteractive({ CLAUDE_CODE_ENTRYPOINT: entrypoint })).toBe(false);
    }
  });

  it("is true otherwise, including when the entrypoint is absent", () => {
    expect(isInteractive({})).toBe(true);
    expect(isInteractive({ CLAUDE_CODE_ENTRYPOINT: "cli" })).toBe(true);
    expect(isInteractive({ CLAUDE_CODE_ENTRYPOINT: "vscode" })).toBe(true);
  });
});

describe("BUDGETS", () => {
  it("stays at least 2s under every matching hook timeout", async () => {
    const hooks = JSON.parse(
      await import("node:fs/promises").then((fs) => fs.readFile(join(ROOT, "hooks", "hooks.json"), "utf8")),
    ) as { hooks: Record<string, { matcher?: string; hooks: { args?: string[]; timeout?: number }[] }[]> };

    const timeouts = new Map<string, number>();
    for (const entries of Object.values(hooks.hooks)) {
      for (const entry of entries) {
        for (const h of entry.hooks) {
          const name = h.args?.[1];
          if (name !== undefined && h.timeout !== undefined) timeouts.set(name, h.timeout * 1000);
        }
      }
    }

    const surfaces: [keyof typeof BUDGETS, string][] = [
      ["planGate", "plan-gate"],
      ["router", "question-router"],
      ["mutationGate", "mutation-gate"],
      ["stopBackstop", "stop-backstop"],
    ];
    for (const [surface, hook] of surfaces) {
      const timeout = timeouts.get(hook);
      expect(timeout, `no timeout registered for ${hook}`).toBeDefined();
      expect(BUDGETS[surface]).toBeLessThanOrEqual((timeout ?? 0) - 2000);
    }
    expect(BUDGETS.server).toBe(6000);
  });
});
