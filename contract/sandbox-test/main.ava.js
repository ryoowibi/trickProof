import anyTest from "ava";
import { Worker, KeyPair } from "near-workspaces";
import { functionCallAccessKey } from "near-api-js/lib/transaction.js";

const test = anyTest;
const GAS = 100_000_000_000_000n;
// NEAR amount (decimal string) -> yoctoNEAR string
const N = (near) => {
  const [whole, frac = ""] = String(near).split(".");
  return (BigInt(whole) * 10n ** 24n + BigInt(frac.padEnd(24, "0"))).toString();
};

test.beforeEach(async (t) => {
  const worker = (t.context.worker = await Worker.init());
  const root = worker.rootAccount;

  const owner = await root.createSubAccount("owner", { initialBalance: N("50") });
  const budi = await root.createSubAccount("budi", { initialBalance: N("5") });
  const toko = await root.createSubAccount("toko", { initialBalance: N("1") });
  const penyerang = await root.createSubAccount("penyerang", { initialBalance: N("1") });
  const vault = await root.createSubAccount("vault", { initialBalance: N("20") });
  await vault.deploy(process.argv[2]);

  await owner.call(vault, "init", {
    owner: owner.accountId,
    agent: budi.accountId,
    max_per_tx: N("2"),
    max_per_day: N("5"),
  });
  await owner.call(vault, "add_allowed", { account: toko.accountId });

  t.context.accounts = { root, owner, budi, toko, penyerang, vault };
});

test.afterEach.always(async (t) => {
  await t.context.worker.tearDown().catch((e) => console.log("Failed to stop the Sandbox:", e));
});

const pay = (budi, vault, receiver, near, memo = "") =>
  budi.call(vault, "pay", { receiver: receiver.accountId ?? receiver, amount: N(near), memo }, { gas: GAS });

const total = async (acc) => BigInt((await acc.balance()).total.toString());

test("payment within policy is approved and funds arrive", async (t) => {
  const { budi, toko, vault } = t.context.accounts;
  const before = await total(toko);
  const res = await pay(budi, vault, toko, "1", "coffee beans");
  t.is(res.status, "approved");
  t.true(res.ok);
  t.is((await total(toko)) - before, BigInt(N("1")));
  const logs = await vault.view("get_logs", {});
  t.is(logs.length, 1);
  t.is(logs[0].status, "approved");
  t.is(logs[0].memo, "coffee beans");
});

test("over per-tx limit is rejected, logged, balance unchanged", async (t) => {
  const { budi, toko, vault } = t.context.accounts;
  const before = await total(toko);
  const res = await pay(budi, vault, toko, "3");
  t.false(res.ok);
  t.is(res.reason, "exceeds per-transaction limit");
  t.is(await total(toko), before);
  const logs = await vault.view("get_logs", {});
  t.is(logs[0].status, "rejected");
});

test("splitting into small payments cannot break the daily limit", async (t) => {
  const { budi, toko, vault } = t.context.accounts;
  const results = [];
  for (let i = 0; i < 4; i++) results.push(await pay(budi, vault, toko, "2"));
  t.deepEqual(
    results.map((r) => r.status),
    ["approved", "approved", "rejected", "rejected"],
  );
  t.is(results[2].reason, "exceeds daily limit");
  const policy = await vault.view("get_policy", {});
  t.is(policy.spent_today, N("4"));
});

test("receiver outside allowlist is held, no funds move", async (t) => {
  const { budi, penyerang, vault } = t.context.accounts;
  const before = await total(penyerang);
  const res = await pay(budi, vault, penyerang, "1");
  t.is(res.status, "held");
  t.false(res.ok);
  t.is(await total(penyerang), before);
  const held = await vault.view("get_held", {});
  t.is(held.length, 1);
  t.is(held[0].id, res.id);
  const policy = await vault.view("get_policy", {});
  t.is(policy.spent_today, "0");
});

test("owner approves a held payment, funds arrive, log updated", async (t) => {
  const { owner, budi, penyerang, vault } = t.context.accounts;
  const res = await pay(budi, vault, penyerang, "1", "new supplier");
  const before = await total(penyerang);
  const out = await owner.call(vault, "approve", { id: res.id }, { gas: GAS });
  t.is(out.status, "approved");
  t.is((await total(penyerang)) - before, BigInt(N("1")));
  t.deepEqual(await vault.view("get_held", {}), []);
  const log = (await vault.view("get_logs", {})).find((l) => l.id === res.id);
  t.is(log.status, "approved");
  t.is(log.reason, "approved by owner");
});

test("owner rejects a held payment, nothing moves", async (t) => {
  const { owner, budi, penyerang, vault } = t.context.accounts;
  const res = await pay(budi, vault, penyerang, "1");
  const before = await total(penyerang);
  const out = await owner.call(vault, "reject", { id: res.id }, { gas: GAS });
  t.is(out.status, "rejected");
  t.is(await total(penyerang), before);
  t.deepEqual(await vault.view("get_held", {}), []);
  await t.throwsAsync(owner.call(vault, "approve", { id: res.id }), { message: /no held payment/ });
});

test("agent cannot approve its own held payment", async (t) => {
  const { budi, penyerang, vault } = t.context.accounts;
  const res = await pay(budi, vault, penyerang, "1");
  await t.throwsAsync(budi.call(vault, "approve", { id: res.id }), { message: /only the owner/ });
  t.is((await vault.view("get_held", {})).length, 1);
});

test("over-limit payment to unknown receiver is rejected, not held", async (t) => {
  const { budi, penyerang, vault } = t.context.accounts;
  const res = await pay(budi, vault, penyerang, "50");
  t.is(res.status, "rejected");
  t.is(res.reason, "exceeds per-transaction limit");
  t.deepEqual(await vault.view("get_held", {}), []);
});

test("upgrade from v1 state keeps policy and logs, held works", async (t) => {
  const v1 = process.env.TRICKPROOF_V1_WASM;
  if (!v1) return t.pass("TRICKPROOF_V1_WASM not set, skipped");
  const { root, owner, budi, toko, penyerang } = t.context.accounts;
  const old = await root.createSubAccount("old", { initialBalance: N("20") });
  await old.deploy(v1);
  await owner.call(old, "init", { owner: owner.accountId, agent: budi.accountId, max_per_tx: N("2"), max_per_day: N("5") });
  await owner.call(old, "add_allowed", { account: toko.accountId });
  await pay(budi, old, toko, "1");
  await old.deploy(process.argv[2]);
  const policy = await old.view("get_policy", {});
  t.is(policy.spent_today, N("1"));
  t.is((await old.view("get_logs", {})).length, 1);
  t.deepEqual(await old.view("get_held", {}), []);
  const res = await pay(budi, old, penyerang, "1");
  t.is(res.status, "held");
});

test("agent cannot change policy or allowlist", async (t) => {
  const { budi, penyerang, vault } = t.context.accounts;
  await t.throwsAsync(
    budi.call(vault, "set_policy", { max_per_tx: N("1000"), max_per_day: N("1000") }),
    { message: /only the owner/ },
  );
  await t.throwsAsync(budi.call(vault, "add_allowed", { account: penyerang.accountId }), { message: /only the owner/ });
  const policy = await vault.view("get_policy", {});
  t.is(policy.max_per_tx, N("2"));
  t.deepEqual(policy.allowed, ["toko.test.near"]);
  await t.throwsAsync(budi.call(vault, "approve", { id: 0 }), { message: /only the owner/ });
});

test("non-agent cannot call pay", async (t) => {
  const { penyerang, toko, vault } = t.context.accounts;
  await t.throwsAsync(pay(penyerang, vault, toko, "1"), { message: /only the agent/ });
});

test("owner can change policy", async (t) => {
  const { owner, budi, toko, vault } = t.context.accounts;
  await owner.call(vault, "set_policy", { max_per_tx: N("4"), max_per_day: N("5") });
  const res = await pay(budi, vault, toko, "3");
  t.is(res.status, "approved");
});

test("function-call key limited to pay cannot call set_policy at all", async (t) => {
  const { budi, toko, vault } = t.context.accounts;
  const fck = KeyPair.fromRandom("ed25519");
  await budi
    .batch(budi)
    .addKey(fck.getPublicKey(), functionCallAccessKey(vault.accountId, ["pay"], BigInt(N("0.25"))))
    .transact();

  // pay works with the restricted key
  const ok = await budi.call(vault, "pay", { receiver: toko.accountId, amount: N("1") }, { gas: GAS, signWithKey: fck });
  t.is(ok.status, "approved");

  // set_policy is refused by the protocol before the contract even runs
  const err = await t.throwsAsync(
    budi.call(vault, "set_policy", { max_per_tx: "1", max_per_day: "1" }, { gas: GAS, signWithKey: fck }),
  );
  t.regex(err.message, /MethodNameMismatch|isn.t allowed by the access key/i);
});
