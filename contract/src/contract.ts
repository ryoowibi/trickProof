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
const MAX_HELD = 20;

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
  // Payments to receivers outside the allowlist wait here for the owner.
  // Added after v1: state written by v1 has no `held`, so always read it via heldList().
  held: LogEntry[] = [];

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

  // Release a held payment. The owner is the human authority, so the agent's
  // limits do not apply here, only the balance check.
  @call({})
  approve({ id }: { id: number }): PayResult {
    this.assertOwner();
    const entry = this.takeHeld(id);
    const value = BigInt(entry.amount);
    if (value > this.spendableBalance()) {
      this.resolve(entry, "rejected", "insufficient balance at approval");
      return { ok: false, id, status: "rejected", reason: "insufficient balance at approval" };
    }
    this.resolve(entry, "approved", "approved by owner");
    const p = near.promiseBatchCreate(entry.receiver);
    near.promiseBatchActionTransfer(p, value);
    near.log(`APPROVED held #${id}: ${value} yocto to ${entry.receiver}`);
    return { ok: true, id, status: "approved", reason: "approved by owner" };
  }

  @call({})
  reject({ id }: { id: number }): PayResult {
    this.assertOwner();
    const entry = this.takeHeld(id);
    this.resolve(entry, "rejected", "rejected by owner");
    near.log(`REJECTED held #${id}`);
    return { ok: false, id, status: "rejected", reason: "rejected by owner" };
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
    else if (value > this.spendableBalance()) reason = "insufficient balance";
    else if (!this.allowed.includes(receiver) && this.heldList().length >= MAX_HELD) reason = "receiver not allowed and approval queue is full";

    // Never panic on a policy violation: a panic would roll back the log entry,
    // and every attack attempt must stay visible on-chain.
    if (reason !== "") {
      const id = this.record(receiver, value, memo, "rejected", reason);
      near.log(`REJECTED #${id}: ${reason}`);
      return { ok: false, id, status: "rejected", reason };
    }

    // Unknown receiver: nothing moves until the owner decides. Held amounts do
    // not count toward the daily limit; the owner's approval is the authority.
    if (!this.allowed.includes(receiver)) {
      const reason = "receiver not allowed: held for owner approval";
      const id = this.record(receiver, value, memo, "held", reason);
      this.heldList().push(this.logs[this.logs.length - 1]);
      near.log(`HELD #${id}: ${value} yocto to ${receiver}`);
      return { ok: false, id, status: "held", reason };
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

  @view({})
  get_held(): LogEntry[] {
    return this.held ?? [];
  }

  // ---------- internals ----------

  private heldList(): LogEntry[] {
    if (!this.held) this.held = [];
    return this.held;
  }

  private takeHeld(id: number): LogEntry {
    const list = this.heldList();
    const i = list.findIndex((e) => e.id === id);
    assert(i >= 0, `no held payment with id ${id}`);
    return list.splice(i, 1)[0];
  }

  // Updates the held entry and its copy in the log (if it is still in the last MAX_LOGS).
  private resolve(entry: LogEntry, status: Status, reason: string): void {
    entry.status = status;
    entry.reason = reason;
    const logged = this.logs.find((l) => l.id === entry.id);
    if (logged) {
      logged.status = status;
      logged.reason = reason;
    }
  }

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
