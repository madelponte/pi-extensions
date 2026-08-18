/**
 * Tests for the safety guard command analysis (pure functions in guard.ts).
 *
 * Run with: node safety-guard/test.ts
 * (Node >= 22.18 runs .ts directly; on older Node 20/22 use
 * `node --experimental-strip-types safety-guard/test.ts`.)
 */
import assert from "node:assert/strict";
import { approvalReason } from "./guard.ts";

let passed = 0;

const GIT = (subcommand: string) => `Git command may change repository state: git ${subcommand}`;

function shouldFlag(command: string, expectedReason?: string) {
	const reason = approvalReason(command);
	assert.ok(reason, `expected to be flagged: ${JSON.stringify(command)}`);
	if (expectedReason) assert.equal(reason, expectedReason, `wrong reason for ${JSON.stringify(command)}: ${reason}`);
	passed++;
}

function shouldAllow(command: string) {
	const reason = approvalReason(command);
	assert.equal(reason, undefined, `expected to be allowed: ${JSON.stringify(command)} -> ${reason}`);
	passed++;
}

// Exact-reason checks also guard the regex group structure (args must be group 1).
shouldFlag("git push", GIT("push"));
shouldFlag("git reset --hard HEAD~1", GIT("reset"));
shouldFlag("git -c user.name=x push origin main", GIT("push"));
shouldFlag("sudo -u deploy git push origin main", GIT("push"));
shouldFlag("rm -rf /tmp/x", "file deletion");
shouldFlag("echo done\nrm -rf /home/user", "file deletion");

// --- rm / rmdir: direct and at command boundaries --------------------------
shouldFlag("sudo rm -rf /var/data");
shouldFlag("sudo -u deploy rm -rf /home/user");
shouldFlag("echo 1 && rm -rf /x");
shouldFlag("echo 1; rm -rf /x");
shouldFlag("$(rm -rf /tmp/important)"); // command substitution
shouldFlag("`rm -rf /tmp/important`"); // backticks
shouldFlag("sh -c 'rm -rf /home/user/data'");
shouldFlag("bash -c \"rm -rf /data\"");
shouldFlag("echo y | rm -rf /x");

// rm look-alikes that must NOT be flagged
shouldAllow("echo $rm"); // variable expansion
shouldAllow("ls /bin/rm");
shouldAllow("npm run rm-thing");
shouldAllow("touch rm.txt");
shouldAllow("echo \"keeping rm -n in mind\"");
shouldAllow("git log --grep=rm -p");

// --- find-based deletion ----------------------------------------------------
shouldFlag("find . -name '*.tmp' -delete");
shouldFlag("find /var/log -mtime +30 -delete");
shouldFlag("find . -name '*.log' -exec rm -f {} \\;");
shouldAllow("find . -name '*.tmp' -print");
shouldAllow("find . -exec grep foo {} \\;");

// --- disk / process / container / k8s / db (regression) ---------------------
shouldFlag("shred /dev/sda1");
shouldFlag("mkfs.ext4 /dev/sdb1");
shouldFlag("dd if=/dev/zero of=/dev/sda");
shouldFlag("echo hi\ndd if=/dev/zero of=/dev/sdb");
shouldFlag("pkill -f evil");
shouldFlag("kill 12345");
shouldFlag("docker system prune --volumes");
shouldFlag("podman volume rm data");
shouldFlag("docker container rm foo");
shouldFlag("kubectl delete pod web-1");
shouldFlag("dropdb mydb");
shouldFlag("psql -c \"DROP TABLE logs\"");
shouldFlag("TRUNCATE TABLE events;");
shouldAllow("echo shredded");
shouldAllow("docker ps");
shouldAllow("ps aux");

// --- git: mutating invocations ----------------------------------------------
shouldFlag("git push origin main", GIT("push"));
shouldFlag("git merge feature", GIT("merge"));
shouldFlag("git rebase main", GIT("rebase"));
shouldFlag("git checkout -b feature", GIT("checkout"));
shouldFlag("git -C subdir push", GIT("push"));
shouldFlag("git stash push", GIT("stash"));
shouldFlag("git remote add origin https://example.com/repo.git", GIT("remote"));
shouldFlag("git branch --delete feature", GIT("branch"));
shouldFlag("git config user.name bob", GIT("config"));
shouldFlag("git tag v1.0", GIT("tag"));
shouldFlag("git worktree add ../wt main", GIT("worktree"));

// git: wrappers and separators that used to bypass detection
shouldFlag("bash -c \"git push origin main\"", GIT("push"));
shouldFlag("sh -c 'git push origin main'", GIT("push"));
shouldFlag("env FOO=bar git push origin main", GIT("push"));
shouldFlag("env -i git push origin main", GIT("push"));
shouldFlag("sudo git push", GIT("push"));
shouldFlag("command git push", GIT("push"));
shouldFlag("GIT_DIR=/x git push origin main", GIT("push"));
shouldFlag("A=1 B=2 git push origin main", GIT("push"));
shouldFlag("echo 1 && echo 2\ngit push origin main", GIT("push"));
shouldFlag("echo 1; git push origin main", GIT("push"));
shouldFlag("$(git push origin main)", GIT("push"));
shouldFlag("git log && git push", GIT("push"));
// conservative false positive: `command -v git` looks like a git invocation
shouldFlag("command -v git", "Git invocation with no identifiable read-only subcommand");

// --- git: read-only invocations ----------------------------------------------
shouldAllow("git status");
shouldAllow("git log --oneline -20");
shouldAllow("git diff HEAD~1");
shouldAllow("git show --stat HEAD");
shouldAllow("git branch --show-current");
shouldAllow("git branch -a --sort=-committerdate --format=%(refname)");
shouldAllow("git tag --list");
shouldAllow("git tag -l");
shouldAllow("git remote -v");
shouldAllow("git remote show origin");
shouldAllow("git remote get-url origin");
shouldAllow("git stash list");
shouldAllow("git stash show");
shouldAllow("git worktree list");
shouldAllow("git config --global --list");
shouldAllow("git config --get user.email");
shouldAllow("git -C subdir status");
shouldAllow("GIT_DIR=/x git status");

// git look-alikes that must NOT be flagged
shouldAllow("ls | grep git");
shouldAllow("echo git push");
shouldAllow("cat .git/config");
shouldAllow("ssh git@github.com");
shouldAllow("git-lfs push");
shouldAllow("git log --format=%(git)");
shouldAllow("git log --grep=git");

// --- plain commands -----------------------------------------------------------
shouldAllow("ls -la");
shouldAllow("echo hello world");
shouldAllow("npm install");

console.log(`safety-guard: ${passed} cases passed`);
