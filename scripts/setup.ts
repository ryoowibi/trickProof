// npm run setup [-- --lock]
//
// 1. builds the contract (if needed)
// 2. deploys + initializes it in ONE transaction (no front-running of init)
// 3. owner adds the merchant to the allowlist and funds the vault
// 4. creates a function-call key on Budi's account limited to `pay`
//    and writes it to .env as AGENT_FCK_PRIVATE_KEY
// --lock: deletes the contract account's full-access keys afterwards so nobody
//         (including you) can redeploy or drain it outside the contract rules.
//
// Testnet only. Signs real transactions: run it yourself after reading it.
import { execSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { KeyPair, transactions } from "near-api-js";
import {
  accountWithKey,
  balanceOf,
  EXPLORER_TX,
  fromYocto,
  GAS_ADMIN,
  ids,
  NETWORK,
  provider,
  toYocto,
  view,
  type Policy,
} from "../agent/src/near.js";
import { assertRestrictedKey } from "../agent/src/wallet.js";

const WASM = "contract/build/trickproof.wasm";
const MAX_PER_TX = process.env.MAX_PER_TX_NEAR ?? "1";
const MAX_PER_DAY = process.env.MAX_PER_DAY_NEAR ?? "3";
const FUND = process.env.VAULT_FUND_NEAR ?? "4";
const FCK_ALLOWANCE = process.env.AGENT_GAS_ALLOWANCE_NEAR ?? "1";
const lock = process.argv.includes("--lock");

const step = (s: string) => console.log(`\n▶ ${s}`);
const link = (o: { transaction_outcome: { id: string } }) => `  tx: ${EXPLORER_TX}${o.transaction_outcome.id}`;

console.log(`Network: ${NETWORK}`);
for (const [role, id] of Object.entries({ contract: ids.contract, owner: ids.owner, agent: ids.agent, merchant: ids.merchant, attacker: ids.attacker })) {
  try {
    console.log(`  ${role.padEnd(8)} ${id}  (${fromYocto(await balanceOf(id), 3)} NEAR)`);
  } catch {
    throw new Error(`Account ${id} (${role}) does not exist on ${NETWORK}. Create it first (see README → Quick start).`);
  }
}

if (!existsSync(WASM)) {
  step("Building contract");
  execSync("npm --prefix contract run build", { stdio: "inherit" });
}

const contract = await accountWithKey(ids.contract, "CONTRACT_PRIVATE_KEY");
const owner = await accountWithKey(ids.owner, "OWNER_PRIVATE_KEY");

let initialized = false;
let existing: Policy | undefined;
try {
  existing = await view<Policy>("get_policy");
  initialized = true;
} catch {
  /* not deployed or not initialized yet */
}

if (initialized) {
  step("Contract already initialized: redeploying code only (state is kept)");
  const o = await contract.deployContract(readFileSync(WASM));
  console.log(link(o));
} else {
  step(`Deploy + init (max_per_tx ${MAX_PER_TX} NEAR, max_per_day ${MAX_PER_DAY} NEAR)`);
  const o = await contract.signAndSendTransaction({
    receiverId: ids.contract,
    actions: [
      transactions.deployContract(readFileSync(WASM)),
      transactions.functionCall(
        "init",
        { owner: ids.owner, agent: ids.agent, max_per_tx: toYocto(MAX_PER_TX).toString(), max_per_day: toYocto(MAX_PER_DAY).toString() },
        GAS_ADMIN,
        0n,
      ),
    ],
  });
  console.log(link(o));
}

// Everything below is skipped when already done, so re-running setup only upgrades the code.
if (existing?.allowed.includes(ids.merchant)) {
  console.log(`\n✓ ${ids.merchant} already allowlisted`);
} else {
  step(`Owner allowlists merchant ${ids.merchant}`);
  console.log(link(await owner.functionCall({ contractId: ids.contract, methodName: "add_allowed", args: { account: ids.merchant }, gas: GAS_ADMIN })));
}

if (initialized) {
  console.log("✓ vault already funded (top up with `deposit` if needed)");
} else if (Number(FUND) > 0) {
  step(`Owner funds the vault with ${FUND} NEAR`);
  console.log(
    link(await owner.functionCall({ contractId: ids.contract, methodName: "deposit", args: {}, gas: GAS_ADMIN, attachedDeposit: toYocto(FUND) })),
  );
}

let keyOk = false;
if (process.env.AGENT_FCK_PRIVATE_KEY) {
  try {
    await assertRestrictedKey();
    keyOk = true;
    console.log("✓ AGENT_FCK_PRIVATE_KEY is already a pay-only key for this vault");
  } catch {
    /* missing on chain or wrong scope: create a new one */
  }
}

if (!keyOk) {
  step(`Creating Budi's function-call key (receiver ${ids.contract}, methods [pay], gas allowance ${FCK_ALLOWANCE} NEAR)`);
  const agentFull = await accountWithKey(ids.agent, "AGENT_PRIVATE_KEY");
  const fck = KeyPair.fromRandom("ed25519");
  console.log(link(await agentFull.addKey(fck.getPublicKey(), ids.contract, ["pay"], toYocto(FCK_ALLOWANCE))));
  upsertEnv("AGENT_FCK_PRIVATE_KEY", fck.toString());
  console.log(`  public key ${fck.getPublicKey().toString()} → saved private key to .env as AGENT_FCK_PRIVATE_KEY`);
}

if (lock) {
  step("Locking contract account: deleting all its full-access keys");
  const keys = (await provider.query({ request_type: "view_access_key_list", finality: "final", account_id: ids.contract })) as unknown as {
    keys: { public_key: string; access_key: { permission: unknown } }[];
  };
  const full = keys.keys.filter((k) => k.access_key.permission === "FullAccess").map((k) => k.public_key);
  for (const pk of full) console.log(link(await contract.deleteKey(pk)));
  console.log(`  deleted ${full.length} key(s). The code can no longer be changed.`);
}

const p = await view<Policy>("get_policy");
console.log(`\n✔ Ready. Policy: max_per_tx ${fromYocto(p.max_per_tx)} NEAR, max_per_day ${fromYocto(p.max_per_day)} NEAR, allowed [${p.allowed.join(", ")}], vault balance ${fromYocto(p.balance, 3)} NEAR`);
console.log("\nIMPORTANT: remove AGENT_PRIVATE_KEY from .env (if you put it there). Budi only needs AGENT_FCK_PRIVATE_KEY.");
console.log("Next: npm run agent   (dashboard at http://localhost:" + (process.env.PORT ?? "8787") + ")");

function upsertEnv(name: string, value: string) {
  const path = ".env";
  const text = existsSync(path) ? readFileSync(path, "utf8") : "";
  const line = `${name}=${value}`;
  const re = new RegExp(`^${name}=.*$`, "m");
  writeFileSync(path, re.test(text) ? text.replace(re, line) : `${text.replace(/\n?$/, "\n")}${line}\n`);
}
