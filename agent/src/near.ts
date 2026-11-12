// Shared NEAR helpers for the agent, setup script and attack suite.
import "dotenv/config";
import { Account, Near, KeyPair, keyStores, providers } from "near-api-js";
import type { KeyPairString } from "@near-js/crypto";
import { homedir } from "node:os";
import { join } from "node:path";

export const NETWORK = process.env.NEAR_NETWORK ?? "testnet";
if (NETWORK === "mainnet") throw new Error("Trickproof is testnet-only. Refusing to run on mainnet.");
export const RPC_URL = process.env.NEAR_RPC_URL ?? "https://test.rpc.fastnear.com";
export const EXPLORER_TX = process.env.NEAR_EXPLORER_TX ?? "https://testnet.nearblocks.io/txns/";

export const GAS_PAY = 50_000_000_000_000n; // 50 Tgas
export const GAS_ADMIN = 100_000_000_000_000n;

export function env(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing ${name} in .env (see .env.example)`);
  return v;
}

export const ids = {
  get contract() { return env("CONTRACT_ID"); },
  get owner() { return env("OWNER_ID"); },
  get agent() { return env("AGENT_ID"); },
  get merchant() { return env("MERCHANT_ID"); },
  get attacker() { return env("ATTACKER_ID"); },
};

const ONE_NEAR = 10n ** 24n;

/** "1.5" NEAR -> yoctoNEAR bigint */
export function toYocto(near: string | number): bigint {
  const [whole, frac = ""] = String(near).trim().split(".");
  if (frac.length > 24) throw new Error(`too many decimals: ${near}`);
  return BigInt(whole || "0") * ONE_NEAR + BigInt(frac.padEnd(24, "0") || "0");
}

/** yoctoNEAR -> "1.5" NEAR */
export function fromYocto(yocto: string | bigint, digits = 4): string {
  const v = BigInt(yocto);
  const whole = v / ONE_NEAR;
  const frac = (v % ONE_NEAR).toString().padStart(24, "0").slice(0, digits).replace(/0+$/, "");
  return frac ? `${whole}.${frac}` : whole.toString();
}

/**
 * Builds an Account that signs with exactly one key.
 * Key source: the given env var (ed25519:...) or, if absent, the legacy
 * near-cli keychain at ~/.near-credentials/<network>/<account>.json.
 */
export async function accountWithKey(accountId: string, keyEnvVar?: string): Promise<Account> {
  const keyStore = new keyStores.InMemoryKeyStore();
  const raw = keyEnvVar ? process.env[keyEnvVar] : undefined;
  if (raw) {
    await keyStore.setKey(NETWORK, accountId, KeyPair.fromString(raw as KeyPairString));
  } else {
    const fsStore = new keyStores.UnencryptedFileSystemKeyStore(join(homedir(), ".near-credentials"));
    const kp = await fsStore.getKey(NETWORK, accountId);
    if (!kp) throw new Error(`No key for ${accountId}: set ${keyEnvVar ?? "a key"} in .env or save it to ~/.near-credentials (near-cli legacy keychain)`);
    await keyStore.setKey(NETWORK, accountId, kp);
  }
  const near = new Near({ networkId: NETWORK, nodeUrl: RPC_URL, keyStore });
  return new Account(near.connection, accountId);
}

export const provider = new providers.JsonRpcProvider({ url: RPC_URL });

export async function view<T>(method: string, args: Record<string, unknown> = {}): Promise<T> {
  const res = (await provider.query({
    request_type: "call_function",
    finality: "optimistic",
    account_id: ids.contract,
    method_name: method,
    args_base64: Buffer.from(JSON.stringify(args)).toString("base64"),
  })) as unknown as { result: number[] };
  return JSON.parse(Buffer.from(res.result).toString());
}

export async function balanceOf(accountId: string): Promise<bigint> {
  const res = (await provider.query({ request_type: "view_account", finality: "final", account_id: accountId })) as unknown as {
    amount: string;
  };
  return BigInt(res.amount);
}

export type Policy = {
  owner: string;
  agent: string;
  max_per_tx: string;
  max_per_day: string;
  spent_today: string;
  allowed: string[];
  balance: string;
};

export type LogEntry = {
  id: number;
  timestamp: string;
  caller: string;
  receiver: string;
  amount: string;
  memo: string;
  status: "approved" | "rejected" | "held";
  reason: string;
};

/** Pulls the tx hash and a readable error out of a near-api-js failure. */
export function describeError(e: unknown): { error: string; txHash?: string } {
  const err = e as { message?: string; type?: string; context?: { transactionHash?: string }; transaction_outcome?: { id?: string } };
  const msg = err?.message ?? String(e);
  // Refused by the access key at the RPC: the transaction never reached the chain, so there is no tx to link.
  if (/isn't allowed by the access key|MethodNameMismatch/i.test(msg)) {
    return { error: "blocked by access key: this key can only call `pay`" };
  }
  const clean = /panicked: (?:assertion failed: )?([^\n]+?)(?:\\n|\n|"|$)/.exec(msg)?.[1] ?? msg.split("\n")[0];
  return { error: clean, txHash: err?.context?.transactionHash ?? err?.transaction_outcome?.id };
}
