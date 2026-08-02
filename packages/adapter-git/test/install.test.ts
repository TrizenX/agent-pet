import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { installGitHooks, uninstallGitHooks } from "../src/install.ts";

const made: string[] = [];
function repo(): string {
  const dir = mkdtempSync(join(tmpdir(), "agent-pet-git-"));
  made.push(dir);
  execFileSync("git", ["init", "-q"], { cwd: dir });
  return dir;
}
afterEach(() => {
  for (const d of made.splice(0)) rmSync(d, { recursive: true, force: true });
});

const ENDPOINT = "http://127.0.0.1:48200/event/git";

describe("installing git hooks", () => {
  it("writes executable hooks that name the endpoint", () => {
    const dir = repo();
    const { written, skipped } = installGitHooks(dir, ENDPOINT);

    expect(written.length).toBeGreaterThan(0);
    expect(skipped).toEqual([]);
    const hook = readFileSync(join(dir, ".git/hooks/post-commit"), "utf8");
    expect(hook).toContain(ENDPOINT);
    expect(hook.startsWith("#!/bin/sh")).toBe(true);
  });

  it("never replaces a hook it did not write", () => {
    // A pre-commit hook is often the only thing between a repository and a bad
    // commit. Replacing one to show a cartoon would be an unforgivable trade.
    const dir = repo();
    const mine = join(dir, ".git/hooks/pre-commit");
    writeFileSync(mine, "#!/bin/sh\nnpm run lint\n");
    chmodSync(mine, 0o755);

    const { written, skipped } = installGitHooks(dir, ENDPOINT);

    expect(skipped).toContain("pre-commit");
    expect(written).not.toContain("pre-commit");
    expect(readFileSync(mine, "utf8")).toBe("#!/bin/sh\nnpm run lint\n");
  });

  it("is idempotent — reinstalling replaces only its own", () => {
    const dir = repo();
    installGitHooks(dir, ENDPOINT);
    const second = installGitHooks(dir, "http://127.0.0.1:49999/event/git");

    expect(second.skipped).toEqual([]);
    expect(readFileSync(join(dir, ".git/hooks/post-commit"), "utf8")).toContain("49999");
  });

  it("removes only what it wrote", () => {
    const dir = repo();
    const mine = join(dir, ".git/hooks/pre-commit");
    writeFileSync(mine, "#!/bin/sh\nnpm run lint\n");
    installGitHooks(dir, ENDPOINT);

    const { removed } = uninstallGitHooks(dir);

    expect(removed).not.toContain("pre-commit");
    expect(readFileSync(mine, "utf8")).toBe("#!/bin/sh\nnpm run lint\n");
    expect(readFileSync(join(dir, ".git/hooks/post-commit"), "utf8")).toBe("");
  });

  it("says so rather than guessing when there is no repository", () => {
    const dir = mkdtempSync(join(tmpdir(), "agent-pet-nonrepo-"));
    made.push(dir);
    mkdirSync(join(dir, "sub"));
    expect(() => installGitHooks(dir, ENDPOINT)).toThrow(/no \.git\/hooks/);
  });
});
