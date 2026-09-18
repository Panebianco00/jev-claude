import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { bashFacts } from "../../src/hooks/bash-facts.ts";

const repo = mkdtempSync(join(tmpdir(), "jev-facts-"));
const git = (...a: string[]) =>
  execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", ...a], { cwd: repo, stdio: "ignore" });
git("init", "-q");
writeFileSync(join(repo, ".gitignore"), "dist/\n");
mkdirSync(join(repo, "dist"));
mkdirSync(join(repo, "src"));
writeFileSync(join(repo, "dist", "a.js"), "x");
writeFileSync(join(repo, "src", "a.ts"), "y");
git("add", "-A");
git("commit", "-qm", "init");

afterAll(() => rmSync(repo, { recursive: true, force: true }));

describe("bashFacts", () => {
  it("says whether a delete target is ignored or tracked", () => {
    const facts = bashFacts("rm -rf dist/ src/", repo).join("\n");
    expect(facts).toContain("dist/: gitignored");
    expect(facts).toContain("src/: tracked by git");
    expect(facts).toContain("working tree is clean");
  });

  it("says a reset branch was never pushed and that reflog keeps the commits", () => {
    const facts = bashFacts("git reset --hard HEAD~1", repo).join("\n");
    expect(facts).toContain("has no upstream branch");
    expect(facts).toContain("reflog");
  });

  it("reports uncommitted work", () => {
    writeFileSync(join(repo, "src", "a.ts"), "changed");
    expect(bashFacts("git reset --hard", repo).join("\n")).toContain("1 uncommitted change");
  });

  it("degrades to nothing outside a repository or without a cwd", () => {
    expect(bashFacts("rm -rf x", undefined)).toEqual([]);
    expect(bashFacts("rm -rf x", tmpdir())[0]).toContain("not a git repository");
  });
});
