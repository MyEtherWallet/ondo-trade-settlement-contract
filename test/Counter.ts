import assert from "node:assert/strict";
import { before, describe, it } from "node:test";

import { network } from "hardhat";

describe("Counter", async () => {
  const { viem } = await network.getOrCreate();

  let owner: Awaited<ReturnType<typeof viem.getWalletClients>>[number];
  let other: Awaited<ReturnType<typeof viem.getWalletClients>>[number];

  before(async () => {
    [owner, other] = await viem.getWalletClients();
  });

  it("starts at zero and records the deployer as owner", async () => {
    const counter = await viem.deployContract("Counter");

    assert.equal(await counter.read.count(), 0n);
    assert.equal(
      (await counter.read.owner()).toLowerCase(),
      owner.account.address.toLowerCase(),
    );
  });

  it("increments by one", async () => {
    const counter = await viem.deployContract("Counter");

    await viem.assertions.emitWithArgs(
      counter.write.increment(),
      counter,
      "Incremented",
      [owner.account.address, 1n],
    );

    assert.equal(await counter.read.count(), 1n);
  });

  it("increments by an arbitrary amount", async () => {
    const counter = await viem.deployContract("Counter");

    await counter.write.incrementBy([5n]);
    await counter.write.incrementBy([7n]);

    assert.equal(await counter.read.count(), 12n);
  });

  it("rejects an increment of zero", async () => {
    const counter = await viem.deployContract("Counter");

    await viem.assertions.revertWithCustomError(
      counter.write.incrementBy([0n]),
      counter,
      "InvalidAmount",
    );
  });

  it("lets only the owner reset the count", async () => {
    const counter = await viem.deployContract("Counter");
    await counter.write.increment();

    await viem.assertions.revertWithCustomError(
      counter.write.reset({ account: other.account }),
      counter,
      "NotOwner",
    );

    await counter.write.reset();
    assert.equal(await counter.read.count(), 0n);
  });
});
