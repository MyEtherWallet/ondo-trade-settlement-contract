import type { HardhatUserConfig } from "hardhat/config";

import hardhatToolboxViemPlugin from "@nomicfoundation/hardhat-toolbox-viem";

// viaIR is required: the settle path is otherwise stack-too-deep. Every build profile
// must repeat these settings, since a profile that omits them falls back to Hardhat's
// defaults rather than inheriting.
const solidity = {
  version: "0.8.28",
  settings: {
    viaIR: true,
    optimizer: { enabled: true, runs: 200 },
  },
};

const config: HardhatUserConfig = {
  plugins: [hardhatToolboxViemPlugin],
  solidity: {
    profiles: {
      default: solidity,
      production: solidity,
    },
  },
  networks: {
    hardhatMainnet: {
      type: "edr-simulated",
      chainType: "l1",
    },
    mainnet: {
      type: "http",
      chainType: "l1",
      url: "https://nodes.mewapi.io/rpc/eth",
      accounts: process.env.PRIV_KEY ? [process.env.PRIV_KEY] : [],
    },
  },
};

export default config;
