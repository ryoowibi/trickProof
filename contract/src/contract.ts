// Trickproof: a policy vault for AI agents on NEAR.
//
// The agent account holds only a function-call access key restricted to `pay`
// on this contract. Every rule below is enforced on-chain, so even an agent
// that has been fully prompt-injected cannot move funds outside the policy or
// change the policy itself.
import { NearBindgen, call, view, initialize, near, assert } from "near-sdk-js";

const NS_PER_DAY = 86_400_000_000_000n;
const MAX_LOGS = 100;
// Cost of storage on NEAR: 1e19 yoctoNEAR per byte. Keep that much (plus a
// buffer) locked so a payment can never push the contract below its storage stake.
const STORAGE_BYTE_COST = 10_000_000_000_000_000_000n;
const STORAGE_BUFFER = 50_000_000_000_000_000_000_000n; // 0.05 NEAR

type Status = "approved" | "rejected" | "held";

class LogEntry {
  id: number;
  timestamp: string; // ns, as string (JSON-safe)
  caller: string;
  receiver: string;
  amount: string; // yoctoNEAR
  memo: string;
  status: Status;
  reason: string;
}

class PayResult {
  ok: boolean;
  id: number;
  status: Status;
  reason: string;
}

@NearBindgen({ requireInit: true })
export class Trickproof {
  owner = "";
  agent = "";
  max_per_tx = "0";
  max_per_day = "0";
  spent_today = "0";
  day_index = 0;
  allowed: string[] = [];
  logs: LogEntry[] = [];
  next_id = 0;

  @initialize({})
  init({
    owner,
    agent,
    max_per_tx,
    max_per_day,
  }: {
    owner: string;
    agent: string;
    max_per_tx: string;
    max_per_day: string;
  }): void {
    assert(owner !== agent, "owner and agent must be different accounts");
    this.owner = owner;
    this.agent = agent;
    this.max_per_tx = BigInt(max_per_tx).toString();
    this.max_per_day = BigInt(max_per_day).toString();
    this.day_index = this.currentDay();
  }

  // ---------- owner-only ----------

  @call({})
  set_policy({ max_per_tx, max_per_day }: { max_per_tx: string; max_per_day: string }): void {
    this.assertOwner();
    this.max_per_tx = BigInt(max_per_tx).toString();
    this.max_per_day = BigInt(max_per_day).toString();
  }

  @call({})
  add_allowed({ account }: { account: string }): void {
    this.assertOwner();
    if (!this.allowed.includes(account)) this.allowed.push(account);
  }

  @call({})
  remove_allowed({ account }: { account: string }): void {
    this.assertOwner();
    this.allowed = this.allowed.filter((a) => a !== account);
  }

  @call({})
  withdraw({ amount }: { amount: string }): void {
    this.assertOwner();
    const value = BigInt(amount);
    assert(value <= this.spendableBalance(), "insufficient balance");
    const p = near.promiseBatchCreate(this.owner);
    near.promiseBatchActionTransfer(p, value);
  }

  // Funding: owner may call this with a deposit, or just send a plain transfer.
  @call({ payableFunction: true })
  deposit(): void {}

  // ---------- agent-only ----------

  // Attached deposit must stay 0: function-call access keys cannot attach deposit.
  @call({})
  pay({ receiver, amount, memo }: { receiver: string; amount: string; memo?: string }): PayResult {
    assert(near.predecessorAccountId() === this.agent, "only the agent can call pay");

    const today = this.currentDay();
    if (today !== this.day_index) {
      this.day_index = today;
      this.spent_today = "0";
    }

    const value = BigInt(amount);
    const spent = BigInt(this.spent_today);
    let reason = "";
    if (value <= 0n) reason = "amount must be positive";
    else if (value > BigInt(this.max_per_tx)) reason = "exceeds per-transaction limit";
    else if (spent + value > BigInt(this.max_per_day)) reason = "exceeds daily limit";
    else if (!this.allowed.includes(receiver)) reason = "receiver not allowed";
    else if (value > this.spendableBalance()) reason = "insufficient balance";

    // Never panic on a policy violation: a panic would roll back the log entry,
    // and every attack attempt must stay visible on-chain.
    if (reason !== "") {
      const id = this.record(receiver, value, memo, "rejected", reason);
      near.log(`REJECTED #${id}: ${reason}`);
      return { ok: false, id, status: "rejected", reason };
    }

    this.spent_today = (spent + value).toString();
    const id = this.record(receiver, value, memo, "approved", "");
    const p = near.promiseBatchCreate(receiver);
    near.promiseBatchActionTransfer(p, value);
    near.log(`APPROVED #${id}: ${value} yocto to ${receiver}`);
    return { ok: true, id, status: "approved", reason: "" };
  }

  // ---------- views ----------

  @view({})
  get_policy(): object {
    const today = this.currentDay();
    return {
      owner: this.owner,
      agent: this.agent,
      max_per_tx: this.max_per_tx,
      max_per_day: this.max_per_day,
      spent_today: today === this.day_index ? this.spent_today : "0",
      allowed: this.allowed,
      balance: near.accountBalance().toString(),
    };
  }

  @view({})
  get_logs({ from, limit }: { from?: number; limit?: number }): LogEntry[] {
    const start = from ?? 0;
    const n = limit ?? 50;
    return this.logs.filter((l) => l.id >= start).slice(0, n);
  }

  // ---------- internals ----------

  private assertOwner(): void {
    assert(near.predecessorAccountId() === this.owner, "only the owner can change the policy");
  }

  private currentDay(): number {
    return Number(near.blockTimestamp() / NS_PER_DAY);
  }

  private spendableBalance(): bigint {
    const locked = near.storageUsage() * STORAGE_BYTE_COST + STORAGE_BUFFER;
    const balance = near.accountBalance();
    return balance > locked ? balance - locked : 0n;
  }

  private record(receiver: string, amount: bigint, memo: string | undefined, status: Status, reason: string): number {
    const id = this.next_id++;
    this.logs.push({
      id,
      timestamp: near.blockTimestamp().toString(),
      caller: near.predecessorAccountId(),
      receiver,
      amount: amount.toString(),
      memo: (memo ?? "").slice(0, 200),
      status,
      reason,
    });
    if (this.logs.length > MAX_LOGS) this.logs.splice(0, this.logs.length - MAX_LOGS);
    return id;
  }
}
