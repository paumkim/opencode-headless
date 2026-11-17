import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import path from "node:path"
import os from "node:os"

// Publishes this directory as the standalone https://github.com/paumkim/opencode-headless repository.
// The monorepo copy is the source of truth; this script copies it, rewrites the repository metadata, and commits.

const here = path.dirname(path.dirname(new URL(import.meta.url).pathname))
const args = process.argv.slice(2)
const target = path.resolve(args.find((arg) => !arg.startsWith("-")) ?? path.join(here, "..", "..", "..", "..", "opencode-headless"))
const push = args.includes("--push")
const remote = "https://github.com/paumkim/opencode-headless.git"

const files = ["index.ts", "src", "test", "package.json", "tsconfig.json", "README.md", "ADR.md", "script/standalone.ts"]
const copied = files.filter((file) => existsSync(path.join(here, file)))
if (copied.length !== files.length) {
  const missing = files.filter((file) => !copied.includes(file))
  throw new Error(`Missing files: ${missing.join(", ")}`)
}

// Keep .git so a sync never rewrites history or drops the remote.
mkdirSync(target, { recursive: true })
for (const directory of ["src", "test", "script"]) rmSync(path.join(target, directory), { recursive: true, force: true })
for (const file of files) cpSync(path.join(here, file), path.join(target, file), { recursive: true })

const manifest = JSON.parse(readFileSync(path.join(target, "package.json"), "utf8"))
manifest.repository = { type: "git", url: `git+${remote}` }
manifest.homepage = remote.replace(/\.git$/u, "#readme")
manifest.bugs = { url: `${remote.replace(/\.git$/u, "")}/issues` }
writeFileSync(path.join(target, "package.json"), JSON.stringify(manifest, null, 2) + "\n")

const license = path.join(here, "..", "..", "..", "LICENSE")
if (existsSync(license)) cpSync(license, path.join(target, "LICENSE"))
writeFileSync(path.join(target, ".gitignore"), "node_modules\nbun.lock\nbun.lockb\n")

function git(argv: string[]) {
  const result = Bun.spawnSync({ cmd: ["git", ...argv], cwd: target, stdout: "pipe", stderr: "pipe" })
  if (result.exitCode !== 0) throw new Error(`git ${argv.join(" ")} failed: ${result.stderr.toString()}`)
  return result.stdout.toString().trim()
}

if (!existsSync(path.join(target, ".git"))) git(["-c", "init.defaultBranch=main", "init"])
git(["add", "-A"])
const dirty = Bun.spawnSync({ cmd: ["git", "status", "--porcelain"], cwd: target, stdout: "pipe" }).stdout.toString()
if (dirty.trim() === "") {
  console.log(`No changes in ${target}`)
} else {
  git(["-c", "user.name=" + (process.env.GIT_AUTHOR_NAME ?? "opencode"), "-c", "user.email=" + (process.env.GIT_AUTHOR_EMAIL ?? "opencode@opencode.ai"), "commit", "-m", "feat: sync headless driver plugin"])
  console.log(`Committed in ${target}: ${git(["rev-parse", "--short", "HEAD"])} on ${git(["rev-parse", "--abbrev-ref", "HEAD"])}`)
}

const remotes = Bun.spawnSync({ cmd: ["git", "remote"], cwd: target, stdout: "pipe" }).stdout.toString()
if (!remotes.split("\n").includes("origin")) git(["remote", "add", "origin", remote])
if (push) {
  git(["push", "-u", "origin", "HEAD:main"])
  console.log(`Pushed ${remote}`)
} else {
  console.log(`Next: git -C ${target} push -u origin HEAD`)
}