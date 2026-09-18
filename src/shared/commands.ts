/**
 * Classifies a Bash command line for the Bash gate, locally and without a network call.
 *
 * This is a pre-filter, not the judgment: a match only means "worth asking Jev", and the
 * `risky_command` check decides. It exists because the hook fires on every Bash call, and a
 * Jev round-trip on `ls` would add latency to the most frequent tool in a session for nothing.
 * So the patterns lean towards precision — a missed exotic command falls back to the model's
 * own judgment, exactly as before this gate existed.
 */

/** One simple command per entry: `a && b; c | d` is four. Quoting is not parsed. */
export function segments(command: string): string[] {
  return command
    .split(/&&|\|\||;|\||\n/)
    .map((s) => s.trim())
    .filter(Boolean);
}

/** Drops leading env assignments and wrappers, so `sudo FOO=1 rm -rf x` reads as `rm -rf x`. */
function words(segment: string): string[] {
  const w = segment.split(/\s+/).filter(Boolean);
  while (w.length && (/^[A-Za-z_][A-Za-z0-9_]*=/.test(w[0] ?? "") || ["sudo", "command", "exec", "time", "nohup"].includes(w[0] ?? ""))) {
    w.shift();
  }
  return w;
}

const RISKY: { why: string; test: (seg: string, w: string[]) => boolean }[] = [
  {
    why: "recursive delete",
    test: (_s, w) => w[0] === "rm" && w.slice(1).some((a) => /^-[a-zA-Z]*[rR]/.test(a) || a === "--recursive"),
  },
  { why: "find -delete", test: (_s, w) => w[0] === "find" && w.includes("-delete") },
  {
    why: "force push",
    test: (_s, w) =>
      w[0] === "git" &&
      w[1] === "push" &&
      w.slice(2).some((a) => a === "-f" || a.startsWith("--force") || /^\+\S/.test(a) || /^-[a-zA-Z]*f/.test(a)),
  },
  { why: "hard reset", test: (_s, w) => w[0] === "git" && w[1] === "reset" && w.includes("--hard") },
  {
    why: "git clean",
    test: (_s, w) => w[0] === "git" && w[1] === "clean" && w.slice(2).some((a) => /^-[a-zA-Z]*f/.test(a) || a === "--force"),
  },
  { why: "discard changes", test: (_s, w) => w[0] === "git" && (w[1] === "checkout" || w[1] === "restore") && w.includes(".") },
  { why: "force-delete branch", test: (_s, w) => w[0] === "git" && w[1] === "branch" && w.slice(2).some((a) => a === "-D" || a === "--delete" && w.includes("--force")) },
  { why: "drop stash", test: (_s, w) => w[0] === "git" && w[1] === "stash" && (w[2] === "drop" || w[2] === "clear") },
  { why: "history rewrite", test: (_s, w) => w[0] === "git" && (w[1] === "filter-branch" || w[1] === "filter-repo") },
  { why: "SQL drop/truncate", test: (s) => /\b(DROP\s+(TABLE|DATABASE|SCHEMA|INDEX|VIEW)|TRUNCATE\s+(TABLE\s+)?\w)/i.test(s) },
  // A DELETE with no WHERE clause empties the table.
  { why: "unfiltered DELETE", test: (s) => /\bDELETE\s+FROM\s+[\w."]+\s*(;|'|"|$)/i.test(s) },
  { why: "terraform apply/destroy", test: (_s, w) => (w[0] === "terraform" || w[0] === "tofu") && (w[1] === "apply" || w[1] === "destroy") },
  { why: "kubernetes delete", test: (_s, w) => w[0] === "kubectl" && (w[1] === "delete" || w[1] === "drain") },
  { why: "helm uninstall", test: (_s, w) => w[0] === "helm" && (w[1] === "uninstall" || w[1] === "delete") },
  {
    why: "docker prune/remove volume",
    test: (_s, w) => w[0] === "docker" && (w.includes("prune") || (w[1] === "volume" && (w[2] === "rm" || w[2] === "prune"))),
  },
  { why: "production deploy", test: (_s, w) => w[0] === "vercel" && w.includes("--prod") },
  { why: "deploy", test: (_s, w) => (w[0] === "fly" || w[0] === "flyctl" || w[0] === "firebase" || w[0] === "netlify") && w[1] === "deploy" },
  { why: "cloud deploy", test: (_s, w) => w[0] === "gcloud" && w.includes("deploy") },
  { why: "bucket delete", test: (_s, w) => w[0] === "aws" && w[1] === "s3" && (w[2] === "rm" || w[2] === "rb") },
  { why: "package publish", test: (_s, w) => ["npm", "pnpm", "yarn"].includes(w[0] ?? "") && w[1] === "publish" },
  { why: "disk write", test: (_s, w) => w[0] === "dd" && w.some((a) => a.startsWith("of=")) },
  { why: "format filesystem", test: (_s, w) => /^mkfs(\.|$)/.test(w[0] ?? "") },
];

/** Why the command is worth a risky_command check, or undefined when it is not. */
export function riskyReason(command: string): string | undefined {
  for (const seg of segments(command)) {
    const w = words(seg);
    for (const r of RISKY) if (r.test(seg, w)) return r.why;
  }
  return undefined;
}

const INSTALLERS: { manager: string; match: (w: string[]) => string[] | undefined }[] = [
  {
    manager: "npm",
    match: (w) =>
      ["npm", "pnpm", "yarn", "bun"].includes(w[0] ?? "") && ["add", "install", "i"].includes(w[1] ?? "")
        ? packages(w.slice(2))
        : undefined,
  },
  {
    manager: "pip",
    match: (w) => {
      const args = (w[0] === "pip" || w[0] === "pip3") && w[1] === "install"
        ? w.slice(2)
        : w[0] === "uv" && w[1] === "pip" && w[2] === "install"
          ? w.slice(3)
          : (w[0] === "uv" || w[0] === "poetry" || w[0] === "pdm") && w[1] === "add"
            ? w.slice(2)
            : undefined;
      if (!args) return undefined;
      // `-r requirements.txt` and `-e .` install what is already declared: not a new choice.
      if (args.some((a) => a === "-r" || a === "--requirement" || a === "-e" || a === "--editable")) return [];
      return packages(args);
    },
  },
  { manager: "cargo", match: (w) => (w[0] === "cargo" && w[1] === "add" ? packages(w.slice(2)) : undefined) },
  { manager: "go", match: (w) => (w[0] === "go" && w[1] === "get" ? packages(w.slice(2)) : undefined) },
  { manager: "gem", match: (w) => (w[0] === "gem" && w[1] === "install" ? packages(w.slice(2)) : undefined) },
  { manager: "composer", match: (w) => (w[0] === "composer" && w[1] === "require" ? packages(w.slice(2)) : undefined) },
];

/** Positional arguments, minus flags and the value a flag like `--registry x` consumes. */
function packages(args: string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i] ?? "";
    if (a.startsWith("-")) {
      if (["--registry", "--index-url", "-i", "--prefix", "--target", "--filter", "--workspace", "--features", "-F", "--rename"].includes(a)) i++;
      continue;
    }
    // Paths and the current directory install local code, which is not a library choice.
    if (a === "." || a.startsWith("./") || a.startsWith("../") || a.startsWith("/")) continue;
    out.push(a);
  }
  return out;
}

/**
 * The packages a command adds, or an empty list when it installs nothing new. `npm install`
 * with no package restores the lockfile; `pip install -r requirements.txt` restores a
 * declared set. Neither is a library decision, and neither is gated.
 */
export function dependencyAdds(command: string): string[] {
  const out: string[] = [];
  for (const seg of segments(command)) {
    const w = words(seg);
    for (const inst of INSTALLERS) {
      const pk = inst.match(w);
      if (pk) out.push(...pk);
    }
  }
  return out;
}
