// npm run attack-suite
// Runs every scenario against the deployed testnet vault and prints a summary.
import { mkdirSync, writeFileSync } from "node:fs";
import { scenarios, type ScenarioResult } from "../agent/src/scenarios.js";
import { assertRestrictedKey } from "../agent/src/wallet.js";
import { brain } from "../agent/src/budi.js";
import { balanceOf, fromYocto, ids, view, type Policy } from "../agent/src/near.js";

const key = await assertRestrictedKey();
console.log(`Vault ${ids.contract} | agent ${ids.agent} | key scope ${key.receiver}:${key.methods.join(",")} | brain ${brain}\n`);

const policy = await view<Policy>("get_policy");
const attackerBefore = await balanceOf(ids.attacker);
const vaultBefore = BigInt(policy.balance);

const results: ScenarioResult[] = [];
for (const s of scenarios) {
  process.stdout.write(`… ${s.title}\n`);
  try {
    const res = await s.run();
    results.push(res);
    console.log(`  ${res.kind === "control" ? (res.blocked ? "✅ passed" : "⚠️  failed") : res.blocked ? "🛡  blocked" : "💥 NOT BLOCKED"}  ${res.summary}`);
    for (const a of res.actions) if (a.explorer) console.log(`     ${a.action} ${a.status}: ${a.explorer}`);
  } catch (e) {
    console.log(`  ⚠️  error: ${(e as Error).message}`);
    results.push({ id: s.id, title: s.title, kind: s.kind, blocked: false, summary: `error: ${(e as Error).message}`, actions: [] });
  }
}

// The attacker signs nothing during the suite, so any balance increase came from the vault.
const attackerAfter = await balanceOf(ids.attacker);
const vaultAfter = BigInt((await view<Policy>("get_policy")).balance);
const lost = attackerAfter > attackerBefore ? attackerAfter - attackerBefore : 0n;

const attacks = results.filter((r) => r.kind === "attack");
const controls = results.filter((r) => r.kind === "control");
const summary = {
  timestamp: new Date().toISOString(),
  network: "testnet",
  contract: ids.contract,
  brain,
  attacks: attacks.length,
  blocked: attacks.filter((r) => r.blocked).length,
  near_lost_to_attacker: fromYocto(lost, 6),
  normal_payments_passed: `${controls.filter((r) => r.blocked).length}/${controls.length}`,
  vault_balance_change: fromYocto(vaultBefore - vaultAfter, 6),
  results,
};

console.log("\n=== Trickproof attack suite ===");
console.table(
  results.map((r) => ({ scenario: r.id, kind: r.kind, result: r.kind === "control" ? (r.blocked ? "passed" : "FAILED") : r.blocked ? "blocked" : "NOT BLOCKED" })),
);
console.log(`Attacks: ${summary.attacks} | Blocked: ${summary.blocked} | NEAR lost to attacker: ${summary.near_lost_to_attacker} | Normal payments passed: ${summary.normal_payments_passed}`);

mkdirSync("results", { recursive: true });
writeFileSync("results/attack-suite.json", JSON.stringify(summary, null, 2));
console.log("Saved results/attack-suite.json");
