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
shouldAllow("rm -rf /tmp/x");
shouldFlag("echo done\nrm -rf /home/user", "file deletion");

// --- rm / rmdir: direct and at command boundaries --------------------------
shouldAllow("rm -f /tmp/result.txt");
shouldAllow("rm -rf /tmp/one /tmp/two");
shouldAllow("rm -rf /tmp/*");
shouldAllow("rm -rf '/tmp/path with spaces'");
shouldAllow("echo 1 && rm -rf /tmp/x");
shouldAllow("$(rm -rf /tmp/important)"); // command substitution
shouldAllow("`rm -rf /tmp/important`"); // backticks
shouldAllow("sh -c 'rm -rf /tmp/generated'");
shouldAllow("rm -f /tmp/result.txt 2>/dev/null");
shouldAllow("rmdir /tmp/empty");
shouldFlag("rm -rf /tmp"); // do not allow removal of the temp directory itself
shouldFlag("rm -rf /tmpfile");
shouldFlag("rm -rf /tmp/x /home/user");
shouldFlag("rm -rf /tmp/../home/user");
shouldFlag("rm -rf /tmp/$DYNAMIC_PATH");
shouldFlag("rm -rf /tmp/x && rm -rf /home/user");
shouldFlag("rmdir -p /tmp/one/two"); // -p can remove /tmp too
shouldFlag("rmdir -vp /tmp/one/two");
shouldFlag("find /tmp -name '*.tmp' -delete"); // exemption is limited to rm/rmdir
shouldFlag("sudo rm -rf /tmp/x", "privilege escalation");
shouldFlag("sudo rm -rf /var/data");
shouldFlag("sudo -u deploy rm -rf /home/user");
shouldFlag("echo 1 && rm -rf /x");
shouldFlag("echo 1; rm -rf /x");
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

// --- alternate deletion forms ----------------------------------------------
shouldFlag("unlink /home/user/data.txt", "file deletion");
shouldFlag("unlink /tmp/generated.txt", "file deletion");
shouldFlag("/bin/rm -rf /home/user/data", "file deletion");
shouldFlag("/bin/rm -rf /tmp/generated", "file deletion");
shouldFlag("command rm -rf /home/user/data", "file deletion");
shouldFlag("command unlink /home/user/data", "file deletion");
shouldFlag("env FOO=bar rm -rf /home/user/data", "file deletion");
shouldFlag("env -u TMPDIR rm -rf /home/user/data", "file deletion");
shouldFlag("FOO=bar rm -rf /home/user/data", "file deletion");
shouldFlag("A=1 B=2 /bin/rm -rf /home/user/data", "file deletion");
shouldFlag("if true; then rm -rf /home/user/data; fi", "file deletion");
shouldFlag("for path in /home/user/data; do rm -rf \"$path\"; done", "file deletion");
shouldFlag("xargs -0 rm -f < files.txt", "xargs file deletion");
shouldFlag("find . -name '*.tmp' -execdir rm -f {} \\;", "find file deletion");
shouldFlag("rsync -a --delete src/ dest/", "rsync deletion");
shouldFlag("rsync -a --delete-excluded src/ dest/", "rsync deletion");
shouldAllow("xargs -0 echo < files.txt");
shouldAllow("rsync -a src/ dest/");

// --- privilege escalation ---------------------------------------------------
shouldFlag("sudo apt update", "privilege escalation");
shouldFlag("/usr/bin/sudo systemctl restart nginx", "privilege escalation");
shouldFlag("sudoedit /etc/hosts", "privilege escalation");
shouldFlag("doas apk add curl", "privilege escalation");
shouldFlag("command sudo apt update", "privilege escalation");
shouldFlag("env -i sudo apt update", "privilege escalation");
shouldFlag("su -c 'whoami'", "privilege escalation");
shouldFlag("su deploy --command='id'", "privilege escalation");
shouldAllow("echo sudo apt update");
shouldAllow("env FOO=bar echo sudo apt update");
shouldAllow("su deploy");

// --- recursive permissions and ACLs ----------------------------------------
shouldFlag("chmod -R 755 ./build", "recursive permission/ownership change");
shouldFlag("chmod -Rv 755 ./build", "recursive permission/ownership change");
shouldFlag("chown --recursive user:group ./data", "recursive permission/ownership change");
shouldFlag("/bin/chown -vR user:group ./data", "recursive permission/ownership change");
shouldFlag("command chmod -R 755 ./build", "recursive permission/ownership change");
shouldFlag("setfacl -m u:deploy:rwx ./data", "ACL change");
shouldFlag("/usr/bin/setfacl -b ./data", "ACL change");
shouldFlag("env FOO=bar setfacl -b ./data", "ACL change");
shouldAllow("chmod +x ./script.sh");
shouldAllow("chown user:group ./file.txt");
shouldAllow("getfacl ./data");

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
shouldFlag("git reflog expire --expire=now --all", GIT("reflog"));
shouldFlag("git reflog delete HEAD@{0}", GIT("reflog"));
shouldFlag("git remote -v remove origin", GIT("remote"));
shouldFlag("git config --show-origin core.hooksPath /tmp/hooks", GIT("config"));
shouldFlag("/usr/bin/git reset --hard HEAD", GIT("reset"));
shouldFlag("FOO=bar /usr/bin/git push origin main", GIT("push"));

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
shouldAllow("git reflog");
shouldAllow("git reflog show HEAD");
shouldAllow("git remote --verbose");
shouldAllow("git remote -v show origin");
shouldAllow("git config --show-origin core.hooksPath");

// --- plain commands -----------------------------------------------------------
shouldAllow("ls -la");
shouldAllow("echo hello world");
shouldAllow("npm install");

console.log(`safety-guard: ${passed} cases passed`);
