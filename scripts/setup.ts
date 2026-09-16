import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
const commit = "0258fe875e1d8e207c1eb7175e542ea32356773c";
function run(command: string, args: string[]) {
  const r = spawnSync(command, args, { stdio: "inherit" });
  if (r.status !== 0) throw new Error(`${command} failed`);
}
if (!existsSync("contracts/lib/forge-std/.git")) {
  mkdirSync("contracts/lib", { recursive: true });
  run("git", [
    "clone",
    "https://github.com/foundry-rs/forge-std",
    "contracts/lib/forge-std",
  ]);
}
run("git", ["-C", "contracts/lib/forge-std", "checkout", "--detach", commit]);
run("forge", ["build", "--root", "contracts"]);
console.log("Contract dependencies pinned and compiled.");
