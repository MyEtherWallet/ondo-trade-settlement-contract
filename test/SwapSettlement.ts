import assert from "node:assert/strict";
import { before, beforeEach, describe, it } from "node:test";

import { network } from "hardhat";
import { getAddress, parseUnits, type Address } from "viem";

const { viem } = await network.getOrCreate();

const SELL_DECIMALS = 18;
const BUY_DECIMALS = 6;

type SwapOrder = {
  user: Address;
  fromToken: Address;
  toToken: Address;
  fromAmount: bigint;
  minToAmount: bigint;
  nonce: bigint;
  deadline: bigint;
};

const ORDER_TYPES = {
  SwapOrder: [
    { name: "user", type: "address" },
    { name: "fromToken", type: "address" },
    { name: "toToken", type: "address" },
    { name: "fromAmount", type: "uint256" },
    { name: "minToAmount", type: "uint256" },
    { name: "nonce", type: "uint256" },
    { name: "deadline", type: "uint256" },
  ],
} as const;

describe("SwapSettlement", async () => {
  const publicClient = await viem.getPublicClient();
  const [deployer, user, solverOperator] = await viem.getWalletClients();

  let settlement: Awaited<ReturnType<typeof viem.deployContract<"SwapSettlement">>>;
  let sellToken: Awaited<ReturnType<typeof viem.deployContract<"MockERC20">>>;
  let buyToken: Awaited<ReturnType<typeof viem.deployContract<"MockERC20">>>;
  let solver: Awaited<ReturnType<typeof viem.deployContract<"MockSolver">>>;

  const SELL_AMOUNT = parseUnits("100", SELL_DECIMALS);
  const MIN_BUY_AMOUNT = parseUnits("250", BUY_DECIMALS);

  let chainId: number;

  before(async () => {
    chainId = await publicClient.getChainId();
  });

  async function signOrder(order: SwapOrder): Promise<`0x${string}`> {
    return user.signTypedData({
      account: user.account,
      domain: {
        name: "SwapSettlement",
        version: "1",
        chainId,
        verifyingContract: settlement.address,
      },
      types: ORDER_TYPES,
      primaryType: "SwapOrder",
      message: order,
    });
  }

  function buildOrder(overrides: Partial<SwapOrder> = {}): SwapOrder {
    return {
      user: user.account.address,
      fromToken: sellToken.address,
      toToken: buyToken.address,
      fromAmount: SELL_AMOUNT,
      minToAmount: MIN_BUY_AMOUNT,
      nonce: 1n,
      deadline: BigInt(Math.floor(Date.now() / 1000) + 3600),
      ...overrides,
    };
  }

  beforeEach(async () => {
    settlement = await viem.deployContract("SwapSettlement");
    sellToken = await viem.deployContract("MockERC20", ["Sell", "SELL", SELL_DECIMALS]);
    buyToken = await viem.deployContract("MockERC20", ["Buy", "BUY", BUY_DECIMALS]);
    solver = await viem.deployContract("MockSolver");

    await sellToken.write.mint([user.account.address, SELL_AMOUNT]);
    await buyToken.write.mint([solver.address, parseUnits("1000000", BUY_DECIMALS)]);
    await sellToken.write.approve([settlement.address, SELL_AMOUNT], {
      account: user.account,
    });
  });

  describe("EIP-712", () => {
    it("derives the same order hash as the off-chain signer", async () => {
      const order = buildOrder();
      const onChainHash = await settlement.read.hashOrder([order]);

      const signature = await signOrder(order);
      const recovered = await publicClient.verifyTypedData({
        address: user.account.address,
        domain: {
          name: "SwapSettlement",
          version: "1",
          chainId,
          verifyingContract: settlement.address,
        },
        types: ORDER_TYPES,
        primaryType: "SwapOrder",
        message: order,
        signature,
      });

      assert.equal(recovered, true);
      assert.match(onChainHash, /^0x[0-9a-f]{64}$/);
    });

    it("rejects a signature from someone other than the order user", async () => {
      const order = buildOrder();
      const badSignature = await solverOperator.signTypedData({
        account: solverOperator.account,
        domain: {
          name: "SwapSettlement",
          version: "1",
          chainId,
          verifyingContract: settlement.address,
        },
        types: ORDER_TYPES,
        primaryType: "SwapOrder",
        message: order,
      });

      await viem.assertions.revertWithCustomError(
        settlement.write.settle([order, badSignature, solver.address, "0x"], {
          account: solverOperator.account,
        }),
        settlement,
        "InvalidSignature",
      );
    });

    it("rejects an order whose fields were tampered with after signing", async () => {
      const order = buildOrder();
      const signature = await signOrder(order);
      const tampered = { ...order, minToAmount: 1n };

      await viem.assertions.revertWithCustomError(
        settlement.write.settle([tampered, signature, solver.address, "0x"], {
          account: solverOperator.account,
        }),
        settlement,
        "InvalidSignature",
      );
    });
  });

  describe("settle", () => {
    it("pays the user the buy token and the caller the sell token", async () => {
      const order = buildOrder();
      const signature = await signOrder(order);

      await settlement.write.settle([order, signature, solver.address, "0x"], {
        account: solverOperator.account,
      });

      assert.equal(await sellToken.read.balanceOf([user.account.address]), 0n);
      assert.equal(await buyToken.read.balanceOf([user.account.address]), MIN_BUY_AMOUNT);
      assert.equal(
        await sellToken.read.balanceOf([solverOperator.account.address]),
        SELL_AMOUNT,
      );
    });

    it("leaves no token dust in the settlement contract", async () => {
      const order = buildOrder();
      const signature = await signOrder(order);

      await settlement.write.settle([order, signature, solver.address, "0x"], {
        account: solverOperator.account,
      });

      assert.equal(await sellToken.read.balanceOf([settlement.address]), 0n);
      assert.equal(await buyToken.read.balanceOf([settlement.address]), 0n);
    });

    it("forwards surplus output to the user", async () => {
      await solver.write.setPayoutBps([12_000n]);

      const order = buildOrder();
      const signature = await signOrder(order);

      await settlement.write.settle([order, signature, solver.address, "0x"], {
        account: solverOperator.account,
      });

      assert.equal(
        await buyToken.read.balanceOf([user.account.address]),
        (MIN_BUY_AMOUNT * 12_000n) / 10_000n,
      );
    });

    it("emits Settled with the executed amounts", async () => {
      const order = buildOrder();
      const signature = await signOrder(order);
      const orderHash = await settlement.read.hashOrder([order]);

      await viem.assertions.emitWithArgs(
        settlement.write.settle([order, signature, solver.address, "0x"], {
          account: solverOperator.account,
        }),
        settlement,
        "Settled",
        [
          orderHash,
          getAddress(user.account.address),
          getAddress(solverOperator.account.address),
          getAddress(sellToken.address),
          getAddress(buyToken.address),
          SELL_AMOUNT,
          MIN_BUY_AMOUNT,
        ],
      );
    });
  });

  describe("validation", () => {
    it("reverts when the solver delivers less than minToAmount", async () => {
      await solver.write.setPayoutBps([9_999n]);

      const order = buildOrder();
      const signature = await signOrder(order);

      await viem.assertions.revertWithCustomError(
        settlement.write.settle([order, signature, solver.address, "0x"], {
          account: solverOperator.account,
        }),
        settlement,
        "InsufficientOutput",
      );
    });

    it("bubbles up a failing callback and settles nothing", async () => {
      await solver.write.setShouldRevert([true]);

      const order = buildOrder();
      const signature = await signOrder(order);

      await viem.assertions.revertWithCustomError(
        settlement.write.settle([order, signature, solver.address, "0x"], {
          account: solverOperator.account,
        }),
        solver,
        "SolverFailure",
      );

      assert.equal(await sellToken.read.balanceOf([user.account.address]), SELL_AMOUNT);
    });

    it("reverts when the user balance is short", async () => {
      const order = buildOrder({ fromAmount: SELL_AMOUNT + 1n });
      const signature = await signOrder(order);

      await viem.assertions.revertWithCustomError(
        settlement.write.settle([order, signature, solver.address, "0x"], {
          account: solverOperator.account,
        }),
        settlement,
        "InsufficientUserBalance",
      );
    });

    it("reverts when the user allowance is short", async () => {
      await sellToken.write.approve([settlement.address, SELL_AMOUNT - 1n], {
        account: user.account,
      });

      const order = buildOrder();
      const signature = await signOrder(order);

      await viem.assertions.revertWithCustomError(
        settlement.write.settle([order, signature, solver.address, "0x"], {
          account: solverOperator.account,
        }),
        settlement,
        "InsufficientUserAllowance",
      );
    });

    it("reverts on an expired order", async () => {
      const order = buildOrder({ deadline: 1n });
      const signature = await signOrder(order);

      await viem.assertions.revertWithCustomError(
        settlement.write.settle([order, signature, solver.address, "0x"], {
          account: solverOperator.account,
        }),
        settlement,
        "OrderExpired",
      );
    });

    it("rejects an order that sells and buys the same token", async () => {
      const order = buildOrder({ toToken: sellToken.address });
      const signature = await signOrder(order);

      await viem.assertions.revertWithCustomError(
        settlement.write.settle([order, signature, solver.address, "0x"], {
          account: solverOperator.account,
        }),
        settlement,
        "InvalidOrder",
      );
    });

    it("rejects a callback target that is a settled token or the contract itself", async () => {
      const order = buildOrder();
      const signature = await signOrder(order);

      for (const target of [sellToken.address, buyToken.address, settlement.address]) {
        await viem.assertions.revertWithCustomError(
          settlement.write.settle([order, signature, target, "0x"], {
            account: solverOperator.account,
          }),
          settlement,
          "InvalidCallbackTarget",
        );
      }
    });
  });

  describe("replay protection", () => {
    it("consumes the nonce so an order cannot settle twice", async () => {
      const order = buildOrder();
      const signature = await signOrder(order);

      await settlement.write.settle([order, signature, solver.address, "0x"], {
        account: solverOperator.account,
      });

      assert.equal(await settlement.read.nonceUsed([user.account.address, order.nonce]), true);

      await viem.assertions.revertWithCustomError(
        settlement.write.settle([order, signature, solver.address, "0x"], {
          account: solverOperator.account,
        }),
        settlement,
        "NonceAlreadyUsed",
      );
    });

    it("lets a user cancel an unsettled nonce", async () => {
      const order = buildOrder();
      const signature = await signOrder(order);

      await settlement.write.cancelNonce([order.nonce], { account: user.account });

      await viem.assertions.revertWithCustomError(
        settlement.write.settle([order, signature, solver.address, "0x"], {
          account: solverOperator.account,
        }),
        settlement,
        "NonceAlreadyUsed",
      );
    });

    it("binds the signature to this contract instance", async () => {
      const order = buildOrder();
      const signature = await signOrder(order);

      const otherSettlement = await viem.deployContract("SwapSettlement");
      await sellToken.write.approve([otherSettlement.address, SELL_AMOUNT], {
        account: user.account,
      });

      await viem.assertions.revertWithCustomError(
        otherSettlement.write.settle([order, signature, solver.address, "0x"], {
          account: solverOperator.account,
        }),
        otherSettlement,
        "InvalidSignature",
      );
    });
  });

  it("keeps the deployer wallet uninvolved in settlement", async () => {
    const order = buildOrder();
    const signature = await signOrder(order);

    await settlement.write.settle([order, signature, solver.address, "0x"], {
      account: solverOperator.account,
    });

    assert.equal(await sellToken.read.balanceOf([deployer.account.address]), 0n);
    assert.equal(await buyToken.read.balanceOf([deployer.account.address]), 0n);
  });
});
