// Budi's wallet: the only key it ever holds is a function-call access key
// limited to `pay` on the Trickproof contract.
import { providers, type Account } from "near-api-js";
import { KeyPair } from "near-api-js";
import type { KeyPairString } from "@near-js/crypto";
import { accountWithKey, describeError, env, GAS_PAY, ids, provider, toYocto, EXPLORER_TX } from "./near.js";

export type ActionResult = {
  action: string;
  args: Record<string, unknown>;
  ok: boolean;
  status: "approved" | "rejected" | "held" | "failed";
  reason: string;
  txHash?: string;
  explorer?: string;
};

let cached: Account | undefined;

async function agentAccount(): Promise<Account> {
  if (!cached) cached = await accountWithKey(ids.agent, "AGENT_FCK_PRIVATE_KEY");
  return cached;
}

/**
 * Refuses to run unless the configured key is a function-call key scoped to
 * the vault contract and the single method `pay`. A full-access key in the
 * agent runtime would defeat the whole design.
 */
export async function assertRestrictedKey(): Promise<{ publicKey: string; methods: string[]; receiver: string }> {
  const kp = KeyPair.fromString(env("AGENT_FCK_PRIVATE_KEY") as KeyPairString);
  const publicKey = kp.getPublicKey().toString();
  const res = (await provider.query({
    request_type: "view_access_key",
    finality: "final",
    account_id: ids.agent,
    public_key: publicKey,
  })) as unknown as { permission: "FullAccess" | { FunctionCall: { receiver_id: string; method_names: string[] } } };
  if (res.permission === "FullAccess") {
    throw new Error("AGENT_FCK_PRIVATE_KEY is a FULL ACCESS key. Budi must only hold the function-call key created by `npm run setup`.");
  }
  const fc = res.permission.FunctionCall;
  if (fc.receiver_id !== ids.contract || fc.method_names.length !== 1 || fc.method_names[0] !== "pay") {
    throw new Error(`Agent key scope is wrong: ${JSON.stringify(fc)}. Expected receiver ${ids.contract}, methods ["pay"].`);
  }
  return { publicKey, methods: fc.method_names, receiver: fc.receiver_id };
}

async function callAsAgent(method: string, args: Record<string, unknown>): Promise<ActionResult> {
  const account = await agentAccount();
  try {
    const outcome = await account.functionCall({ contractId: ids.contract, methodName: method, args, gas: GAS_PAY });
    const txHash = outcome.transaction_outcome.id;
    const ret = providers.getTransactionLastResult(outcome) as { ok?: boolean; status?: ActionResult["status"]; reason?: string } | "";
    const r = typeof ret === "object" && ret ? ret : {};
    return {
      action: method,
      args,
      ok: r.ok ?? true,
      status: r.status ?? "approved",
      reason: r.reason ?? "",
      txHash,
      explorer: EXPLORER_TX + txHash,
    };
  } catch (e) {
    const { error, txHash } = describeError(e);
    return { action: method, args, ok: false, status: "failed", reason: error, txHash, explorer: txHash ? EXPLORER_TX + txHash : undefined };
  }
}

export function pay(receiver: string, amountNear: string | number, memo = ""): Promise<ActionResult> {
  return callAsAgent("pay", { receiver, amount: toYocto(amountNear).toString(), memo });
}

// Budi is *allowed to try* these. The access key and the contract both stop him.
export function setPolicy(maxPerTxNear: string | number, maxPerDayNear: string | number): Promise<ActionResult> {
  return callAsAgent("set_policy", { max_per_tx: toYocto(maxPerTxNear).toString(), max_per_day: toYocto(maxPerDayNear).toString() });
}

export function addAllowed(account: string): Promise<ActionResult> {
  return callAsAgent("add_allowed", { account });
}
