import assert from "node:assert/strict";
import { before, beforeEach, describe, it } from "node:test";

import { network } from "hardhat";
import { getAddress, parseUnits, type Address, type Hex } from "viem";

import {
  PERMIT2_ADDRESS,
  PERMIT2_RUNTIME_BYTECODE,
} from "./fixtures/permit2.js";

const { viem, provider } = await network.getOrCreate();

const SELL_DECIMALS = 18;
const BUY_DECIMALS = 6;

const PERMIT2_WITNESS_TYPES = {
  PermitWitnessTransferFrom: [
    { name: "permitted", type: "TokenPermissions" },
    { name: "spender", type: "address" },
    { name: "nonce", type: "uint256" },
    { name: "deadline", type: "uint256" },
    { name: "witness", type: "SwapWitness" },
  ],
  TokenPermissions: [
    { name: "token", type: "address" },
    { name: "amount", type: "uint256" },
  ],
  SwapWitness: [
    { name: "toToken", type: "address" },
    { name: "minToAmount", type: "uint256" },
  ],
} as const;

type Permit = {
  permitted: { token: Address; amount: bigint };
  nonce: bigint;
  deadline: bigint;
};

type Witness = { toToken: Address; minToAmount: bigint };

describe("SwapSettlement", async () => {
  const publicClient = await viem.getPublicClient();
  const [deployer, user, solverOperator] = await viem.getWalletClients();

  let settlement: Awaited<
    ReturnType<typeof viem.deployContract<"SwapSettlement">>
  >;
  let sellToken: Awaited<ReturnType<typeof viem.deployContract<"MockERC20">>>;
  let buyToken: Awaited<ReturnType<typeof viem.deployContract<"MockERC20">>>;
  let solver: Awaited<ReturnType<typeof viem.deployContract<"MockSolver">>>;

  const SELL_AMOUNT = parseUnits("100", SELL_DECIMALS);
  const MIN_BUY_AMOUNT = parseUnits("250", BUY_DECIMALS);
  const MAX_UINT256 = (1n << 256n) - 1n;

  let chainId: number;
  let nextNonce = 0n;
  let permit2: Awaited<
    ReturnType<typeof viem.getContractAt<"ISignatureTransfer">>
  >;

  before(async () => {
    chainId = await publicClient.getChainId();
    await provider.request({
      method: "hardhat_setCode",
      params: [PERMIT2_ADDRESS, PERMIT2_RUNTIME_BYTECODE],
    });
    permit2 = await viem.getContractAt("ISignatureTransfer", PERMIT2_ADDRESS);
  });

  function buildPermit(overrides: Partial<Permit> = {}): Permit {
    return {
      permitted: { token: sellToken.address, amount: SELL_AMOUNT },
      nonce: nextNonce++,
      deadline: BigInt(Math.floor(Date.now() / 1000) + 3600),
      ...overrides,
    };
  }

  function buildWitness(overrides: Partial<Witness> = {}): Witness {
    return {
      toToken: buyToken.address,
      minToAmount: MIN_BUY_AMOUNT,
      ...overrides,
    };
  }

  async function signPermit(
    permit: Permit,
    witness: Witness,
    opts: { spender?: Address; signer?: typeof user } = {},
  ): Promise<Hex> {
    const signer = opts.signer ?? user;
    return signer.signTypedData({
      account: signer.account,
      domain: { name: "Permit2", chainId, verifyingContract: PERMIT2_ADDRESS },
      types: PERMIT2_WITNESS_TYPES,
      primaryType: "PermitWitnessTransferFrom",
      message: {
        permitted: permit.permitted,
        spender: opts.spender ?? settlement.address,
        nonce: permit.nonce,
        deadline: permit.deadline,
        witness,
      },
    });
  }

  beforeEach(async () => {
    settlement = await viem.deployContract("SwapSettlement", [PERMIT2_ADDRESS]);
    sellToken = await viem.deployContract("MockERC20", [
      "Sell",
      "SELL",
      SELL_DECIMALS,
    ]);
    buyToken = await viem.deployContract("MockERC20", [
      "Buy",
      "BUY",
      BUY_DECIMALS,
    ]);
    solver = await viem.deployContract("MockSolver");

    await sellToken.write.mint([user.account.address, SELL_AMOUNT]);
    await buyToken.write.mint([
      solver.address,
      parseUnits("1000000", BUY_DECIMALS),
    ]);

    // Users approve Permit2 once, not the settlement contract.
    await sellToken.write.approve([PERMIT2_ADDRESS, MAX_UINT256], {
      account: user.account,
    });
  });

  describe("permit2 wiring", () => {
    it("uses the canonical Permit2 deployment", async () => {
      assert.equal(
        await settlement.read.PERMIT2(),
        getAddress(PERMIT2_ADDRESS),
      );

      const code = await publicClient.getCode({ address: PERMIT2_ADDRESS });
      assert.ok(code && code.length > 2);
    });

    it("exposes a witness type string that Permit2 accepts", async () => {
      assert.equal(
        await settlement.read.WITNESS_TYPE_STRING(),
        "SwapWitness witness)SwapWitness(address toToken,uint256 minToAmount)TokenPermissions(address token,uint256 amount)",
      );
    });

    it("rejects a zero Permit2 address at deployment", async () => {
      await assert.rejects(
        viem.deployContract("SwapSettlement", [
          "0x0000000000000000000000000000000000000000",
        ]),
        /InvalidPermit2/,
      );
    });
  });

  describe("settle", () => {
    it("pays the user the buy token and the callback target the sell token", async () => {
      const permit = buildPermit();
      const witness = buildWitness();
      const signature = await signPermit(permit, witness);

      await settlement.write.settle(
        [
          permit,
          user.account.address,
          witness,
          signature,
          solver.address,
          "0x",
        ],
        { account: solverOperator.account },
      );

      assert.equal(await sellToken.read.balanceOf([user.account.address]), 0n);
      assert.equal(
        await buyToken.read.balanceOf([user.account.address]),
        MIN_BUY_AMOUNT,
      );
      // The sell token goes to callbackTarget, which needs it to source the buy
      // side, not to the caller.
      assert.equal(
        await sellToken.read.balanceOf([solver.address]),
        SELL_AMOUNT,
      );
      assert.equal(
        await sellToken.read.balanceOf([solverOperator.account.address]),
        0n,
      );
    });

    // The point of forwarding before the callback: a solver can fund the buy side
    // from the user's own money instead of its own balance. MockSolver asserts
    // custody internally, so this fails if the transfer moves back after the call.
    it("gives the callback custody of the sell token before invoking it", async () => {
      await solver.write.setRequireSellTokenReceived([true]);

      const permit = buildPermit();
      const witness = buildWitness();
      const signature = await signPermit(permit, witness);

      await settlement.write.settle(
        [
          permit,
          user.account.address,
          witness,
          signature,
          solver.address,
          "0x",
        ],
        { account: solverOperator.account },
      );

      assert.equal(
        await buyToken.read.balanceOf([user.account.address]),
        MIN_BUY_AMOUNT,
      );
      assert.equal(
        await sellToken.read.balanceOf([solver.address]),
        SELL_AMOUNT,
      );
    });

    it("leaves no token dust in the settlement contract", async () => {
      const permit = buildPermit();
      const witness = buildWitness();
      const signature = await signPermit(permit, witness);

      await settlement.write.settle(
        [
          permit,
          user.account.address,
          witness,
          signature,
          solver.address,
          "0x",
        ],
        { account: solverOperator.account },
      );

      assert.equal(await sellToken.read.balanceOf([settlement.address]), 0n);
      assert.equal(await buyToken.read.balanceOf([settlement.address]), 0n);
    });

    it("forwards surplus output to the user", async () => {
      await solver.write.setPayoutBps([12_000n]);

      const permit = buildPermit();
      const witness = buildWitness();
      const signature = await signPermit(permit, witness);

      await settlement.write.settle(
        [
          permit,
          user.account.address,
          witness,
          signature,
          solver.address,
          "0x",
        ],
        { account: solverOperator.account },
      );

      assert.equal(
        await buyToken.read.balanceOf([user.account.address]),
        (MIN_BUY_AMOUNT * 12_000n) / 10_000n,
      );
    });

    it("emits Settled with the executed amounts", async () => {
      const permit = buildPermit();
      const witness = buildWitness();
      const signature = await signPermit(permit, witness);

      await viem.assertions.emitWithArgs(
        settlement.write.settle(
          [
            permit,
            user.account.address,
            witness,
            signature,
            solver.address,
            "0x",
          ],
          { account: solverOperator.account },
        ),
        settlement,
        "Settled",
        [
          getAddress(user.account.address),
          getAddress(solverOperator.account.address),
          permit.nonce,
          getAddress(sellToken.address),
          getAddress(buyToken.address),
          SELL_AMOUNT,
          MIN_BUY_AMOUNT,
        ],
      );
    });
  });

  describe("permit2 signature enforcement", () => {
    it("rejects a signature from someone other than the named owner", async () => {
      const permit = buildPermit();
      const witness = buildWitness();
      const signature = await signPermit(permit, witness, {
        signer: solverOperator,
      });

      await viem.assertions.revertWithCustomError(
        settlement.write.settle(
          [
            permit,
            user.account.address,
            witness,
            signature,
            solver.address,
            "0x",
          ],
          { account: solverOperator.account },
        ),
        permit2,
        "InvalidSigner",
      );
    });

    it("rejects a witness that was tampered with after signing", async () => {
      const permit = buildPermit();
      const witness = buildWitness();
      const signature = await signPermit(permit, witness);

      await viem.assertions.revertWithCustomError(
        settlement.write.settle(
          [
            permit,
            user.account.address,
            { ...witness, minToAmount: 1n },
            signature,
            solver.address,
            "0x",
          ],
          { account: solverOperator.account },
        ),
        permit2,
        "InvalidSigner",
      );
    });

    it("rejects a permit amount that was tampered with after signing", async () => {
      const permit = buildPermit();
      const witness = buildWitness();
      const signature = await signPermit(permit, witness);

      await viem.assertions.revertWithCustomError(
        settlement.write.settle(
          [
            {
              ...permit,
              permitted: { ...permit.permitted, amount: SELL_AMOUNT / 2n },
            },
            user.account.address,
            witness,
            signature,
            solver.address,
            "0x",
          ],
          { account: solverOperator.account },
        ),
        permit2,
        "InvalidSigner",
      );
    });

    it("binds the signature to the settlement contract as spender", async () => {
      const permit = buildPermit();
      const witness = buildWitness();
      const other = await viem.deployContract("SwapSettlement", [
        PERMIT2_ADDRESS,
      ]);
      const signature = await signPermit(permit, witness, {
        spender: other.address,
      });

      await viem.assertions.revertWithCustomError(
        settlement.write.settle(
          [
            permit,
            user.account.address,
            witness,
            signature,
            solver.address,
            "0x",
          ],
          { account: solverOperator.account },
        ),
        permit2,
        "InvalidSigner",
      );
    });

    it("reverts on an expired permit", async () => {
      const permit = buildPermit({ deadline: 1n });
      const witness = buildWitness();
      const signature = await signPermit(permit, witness);

      await viem.assertions.revertWithCustomError(
        settlement.write.settle(
          [
            permit,
            user.account.address,
            witness,
            signature,
            solver.address,
            "0x",
          ],
          { account: solverOperator.account },
        ),
        permit2,
        "SignatureExpired",
      );
    });
  });

  describe("replay protection", () => {
    it("consumes the Permit2 nonce so an order cannot settle twice", async () => {
      const permit = buildPermit();
      const witness = buildWitness();
      const signature = await signPermit(permit, witness);

      await settlement.write.settle(
        [
          permit,
          user.account.address,
          witness,
          signature,
          solver.address,
          "0x",
        ],
        { account: solverOperator.account },
      );

      await sellToken.write.mint([user.account.address, SELL_AMOUNT]);

      await viem.assertions.revertWithCustomError(
        settlement.write.settle(
          [
            permit,
            user.account.address,
            witness,
            signature,
            solver.address,
            "0x",
          ],
          { account: solverOperator.account },
        ),
        permit2,
        "InvalidNonce",
      );
    });

    it("lets a user cancel a nonce through Permit2", async () => {
      const permit = buildPermit();
      const witness = buildWitness();
      const signature = await signPermit(permit, witness);

      await permit2.write.invalidateUnorderedNonces(
        [permit.nonce >> 8n, 1n << (permit.nonce & 0xffn)],
        { account: user.account },
      );

      await viem.assertions.revertWithCustomError(
        settlement.write.settle(
          [
            permit,
            user.account.address,
            witness,
            signature,
            solver.address,
            "0x",
          ],
          { account: solverOperator.account },
        ),
        permit2,
        "InvalidNonce",
      );
    });
  });

  describe("validation", () => {
    it("reverts when the solver delivers less than minToAmount", async () => {
      await solver.write.setPayoutBps([9_999n]);

      const permit = buildPermit();
      const witness = buildWitness();
      const signature = await signPermit(permit, witness);

      await viem.assertions.revertWithCustomError(
        settlement.write.settle(
          [
            permit,
            user.account.address,
            witness,
            signature,
            solver.address,
            "0x",
          ],
          { account: solverOperator.account },
        ),
        settlement,
        "InsufficientOutput",
      );
    });

    it("bubbles up a failing callback and settles nothing", async () => {
      await solver.write.setShouldRevert([true]);

      const permit = buildPermit();
      const witness = buildWitness();
      const signature = await signPermit(permit, witness);

      await viem.assertions.revertWithCustomError(
        settlement.write.settle(
          [
            permit,
            user.account.address,
            witness,
            signature,
            solver.address,
            "0x",
          ],
          { account: solverOperator.account },
        ),
        solver,
        "SolverFailure",
      );

      assert.equal(
        await sellToken.read.balanceOf([user.account.address]),
        SELL_AMOUNT,
      );
    });

    it("reverts when the user balance is short", async () => {
      const permit = buildPermit({
        permitted: { token: sellToken.address, amount: SELL_AMOUNT + 1n },
      });
      const witness = buildWitness();
      const signature = await signPermit(permit, witness);

      await viem.assertions.revertWithCustomError(
        settlement.write.settle(
          [
            permit,
            user.account.address,
            witness,
            signature,
            solver.address,
            "0x",
          ],
          { account: solverOperator.account },
        ),
        settlement,
        "InsufficientUserBalance",
      );
    });

    it("reverts when the Permit2 allowance is short", async () => {
      await sellToken.write.approve([PERMIT2_ADDRESS, SELL_AMOUNT - 1n], {
        account: user.account,
      });

      const permit = buildPermit();
      const witness = buildWitness();
      const signature = await signPermit(permit, witness);

      await viem.assertions.revertWithCustomError(
        settlement.write.settle(
          [
            permit,
            user.account.address,
            witness,
            signature,
            solver.address,
            "0x",
          ],
          { account: solverOperator.account },
        ),
        settlement,
        "InsufficientPermit2Allowance",
      );
    });

    it("rejects an order that sells and buys the same token", async () => {
      const permit = buildPermit();
      const witness = buildWitness({ toToken: sellToken.address });
      const signature = await signPermit(permit, witness);

      await viem.assertions.revertWithCustomError(
        settlement.write.settle(
          [
            permit,
            user.account.address,
            witness,
            signature,
            solver.address,
            "0x",
          ],
          { account: solverOperator.account },
        ),
        settlement,
        "InvalidOrder",
      );
    });

    it("rejects a callback target that is a token, Permit2, or the contract itself", async () => {
      const permit = buildPermit();
      const witness = buildWitness();
      const signature = await signPermit(permit, witness);

      const targets: Address[] = [
        sellToken.address,
        buyToken.address,
        settlement.address,
        PERMIT2_ADDRESS,
      ];

      for (const target of targets) {
        await viem.assertions.revertWithCustomError(
          settlement.write.settle(
            [permit, user.account.address, witness, signature, target, "0x"],
            { account: solverOperator.account },
          ),
          settlement,
          "InvalidCallbackTarget",
        );
      }
    });
  });

  it("keeps the deployer wallet uninvolved in settlement", async () => {
    const permit = buildPermit();
    const witness = buildWitness();
    const signature = await signPermit(permit, witness);

    await settlement.write.settle(
      [permit, user.account.address, witness, signature, solver.address, "0x"],
      { account: solverOperator.account },
    );

    assert.equal(
      await sellToken.read.balanceOf([deployer.account.address]),
      0n,
    );
    assert.equal(await buyToken.read.balanceOf([deployer.account.address]), 0n);
  });
});
