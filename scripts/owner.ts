// npm run owner -- held | approve <id> | reject <id>
//
// The owner's tool, deliberately a separate process: the owner key is never
// loaded by the agent or the dashboard server.
import { providers } from "near-api-js";
import { accountWithKey, EXPLORER_TX, fromYocto, GAS_ADMIN, ids, view, type LogEntry } from "../agent/src/near.js";

const [cmd, arg] = process.argv.slice(2);

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
} else {
  console.log("usage: npm run owner -- held | approve <id> | reject <id>");
}
