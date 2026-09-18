import { describe, expect, it } from "vitest";
import { dependencyAdds, riskyReason } from "../../src/shared/commands.ts";

describe("riskyReason", () => {
  it.each([
    "rm -rf build/",
    "rm -r old",
    "sudo rm -Rf /var/tmp/x",
    "find . -name '*.log' -delete",
    "git push --force origin main",
    "git push -f",
    "git push origin +main",
    "git push --force-with-lease origin feature",
    "git reset --hard HEAD~1",
    "git clean -fdx",
    "git checkout -- .",
    "git branch -D old-feature",
    "git stash clear",
    "psql $DB -c 'DROP TABLE users;'",
    "psql -c \"truncate table events\"",
    "sqlite3 app.db 'DELETE FROM sessions;'",
    "terraform destroy -auto-approve",
    "kubectl delete deployment api",
    "docker system prune -af",
    "vercel deploy --prod",
    "fly deploy",
    "aws s3 rm s3://bucket --recursive",
    "npm publish",
    "cd app && npm test && git push --force",
  ])("flags %s", (cmd) => {
    expect(riskyReason(cmd)).toBeDefined();
  });

  it.each([
    "ls -la",
    "git status",
    "git push origin feature",
    "git reset HEAD file.ts",
    "rm file.txt",
    "npm test",
    "psql -c 'SELECT * FROM users'",
    "sqlite3 app.db \"DELETE FROM sessions WHERE expires < now()\"",
    "terraform plan",
    "kubectl get pods",
    "vercel deploy",
    "grep -r 'DROP' docs/",
  ])("leaves %s alone", (cmd) => {
    expect(riskyReason(cmd)).toBeUndefined();
  });
});

describe("dependencyAdds", () => {
  it.each([
    ["npm install zod", ["zod"]],
    ["npm i -D vitest @types/node", ["vitest", "@types/node"]],
    ["pnpm add --filter web react-query", ["react-query"]],
    ["yarn add lodash@4", ["lodash@4"]],
    ["pip install requests", ["requests"]],
    ["uv add httpx", ["httpx"]],
    ["cargo add serde --features derive", ["serde"]],
    ["go get github.com/stretchr/testify", ["github.com/stretchr/testify"]],
    ["cd web && npm install left-pad", ["left-pad"]],
  ])("finds the packages %s adds", (cmd, pkgs) => {
    expect(dependencyAdds(cmd)).toEqual(pkgs);
  });

  it.each([
    "npm install",
    "npm ci",
    "yarn install --frozen-lockfile",
    "pip install -r requirements.txt",
    "pip install -e .",
    "npm install ./packages/local",
    "npm run build",
  ])("does not count %s, which adds nothing new", (cmd) => {
    expect(dependencyAdds(cmd)).toEqual([]);
  });
});
