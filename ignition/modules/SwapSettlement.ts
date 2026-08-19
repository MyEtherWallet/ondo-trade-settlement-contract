import { buildModule } from "@nomicfoundation/hardhat-ignition/modules";

const CANONICAL_PERMIT2 = "0x000000000022D473030F116dDEE9F6B43aC78BA3";

export default buildModule("SwapSettlementModule", (m) => {
  const permit2 = m.getParameter("permit2", CANONICAL_PERMIT2);
  const settlement = m.contract("SwapSettlement", [permit2]);

  return { settlement };
});
