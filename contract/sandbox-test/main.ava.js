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

test("receiver outside allowlist is rejected", async (t) => {
  const { budi, penyerang, vault } = t.context.accounts;
  const before = await total(penyerang);
  const res = await pay(budi, vault, penyerang, "1");
  t.is(res.reason, "receiver not allowed");
  t.is(await total(penyerang), before);
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
