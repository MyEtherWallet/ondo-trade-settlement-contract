import type { HardhatUserConfig } from "hardhat/config";

import hardhatToolboxViemPlugin from "@nomicfoundation/hardhat-toolbox-viem";

const config: HardhatUserConfig = {
  plugins: [hardhatToolboxViemPlugin],
  solidity: {
    version: "0.8.28",
    settings: {
      viaIR: true,
      optimizer: { enabled: true, runs: 200 },
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
