// npm run owner -- held | approve <id> | reject <id> | policy <max_per_tx_near> <max_per_day_near>
//
// The owner's tool, deliberately a separate process: the owner key is never
// loaded by the agent or the dashboard server.
import { providers } from "near-api-js";
import { accountWithKey, EXPLORER_TX, fromYocto, GAS_ADMIN, ids, toYocto, view, type LogEntry, type Policy } from "../agent/src/near.js";

const [cmd, arg, arg2] = process.argv.slice(2);

if (cmd === "held" || !cmd) {
  const held = await view<LogEntry[]>("get_held");
  if (!held.length) console.log("No payments waiting for approval.");
  for (const h of held) console.log(`#${h.id}  ${fromYocto(h.amount)} NEAR → ${h.receiver}  memo: ${h.memo || "-"}`);
  if (held.length) console.log("\nnpm run owner -- approve <id>   |   npm run owner -- reject <id>");
} else if (cmd === "approve" || cmd === "reject") {
  const id = Number(arg);
  if (!Number.isInteger(id)) throw new Error(`usage: npm run owner -- ${cmd} <id>`);
  const owner = await accountWithKey(ids.owner, "OWNER_PRIVATE_KEY");
  const outcome = await owner.functionCall({ contractId: ids.contract, methodName: cmd, args: { id }, gas: GAS_ADMIN });
  const res = providers.getTransactionLastResult(outcome) as { status: string; reason: string };
  console.log(`#${id} → ${res.status} (${res.reason})\ntx: ${EXPLORER_TX}${outcome.transaction_outcome.id}`);
} else if (cmd === "policy") {
  if (!arg || !arg2) throw new Error("usage: npm run owner -- policy <max_per_tx_near> <max_per_day_near>");
  const owner = await accountWithKey(ids.owner, "OWNER_PRIVATE_KEY");
  const outcome = await owner.functionCall({
    contractId: ids.contract,
    methodName: "set_policy",
    args: { max_per_tx: toYocto(arg).toString(), max_per_day: toYocto(arg2).toString() },
    gas: GAS_ADMIN,
  });
  const p = await view<Policy>("get_policy");
  console.log(`policy → max_per_tx ${fromYocto(p.max_per_tx)} NEAR, max_per_day ${fromYocto(p.max_per_day)} NEAR (spent today ${fromYocto(p.spent_today)})\ntx: ${EXPLORER_TX}${outcome.transaction_outcome.id}`);
} else {
  console.log("usage: npm run owner -- held | approve <id> | reject <id> | policy <max_per_tx_near> <max_per_day_near>");
}
