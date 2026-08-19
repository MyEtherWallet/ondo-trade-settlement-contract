import { buildModule } from "@nomicfoundation/hardhat-ignition/modules";

export default buildModule("SwapSettlementModule", (m) => {
  const settlement = m.contract("SwapSettlement");

  return { settlement };
});
