import { promises as fs } from "fs";

import { Contract } from "ethers";
import { HardhatRuntimeEnvironment } from "hardhat/types";

import {
  parseCsvFile,
  computeProofs,
  removeSplitClaimFiles,
  splitClaimsAndSaveToFolder,
  ReducedDeploymentProposalSettings,
  constructorInput,
  ContractName,
} from "../../ts";

export interface CowDeploymentArgs {
  claims: string;
  settings: string;
}

export async function generateDeployment(
  { claims: claimCsv, settings: settingsJson }: CowDeploymentArgs,
  hre: HardhatRuntimeEnvironment,
  outputFolder: string,
): Promise<[Contract, ReducedDeploymentProposalSettings]> {
  const chainIdUntyped = (
    await hre.ethers.provider.getNetwork()
  ).chainId.toString();
  if (!["1", "4", "5", "100", "11155111"].includes(chainIdUntyped)) {
    throw new Error(`Chain id ${chainIdUntyped} not supported`);
  }

  console.log("Processing input files...");
  // TODO: validate settings
  const inputSettings: ReducedDeploymentProposalSettings = JSON.parse(
    await fs.readFile(settingsJson, "utf8"),
  );
  const claims = await parseCsvFile(claimCsv);

  console.log("Generating Merkle proofs...");
  const { merkleRoot, claims: claimsWithProof } = computeProofs(claims);

  const settings = {
    ...inputSettings,
    virtualCowToken: {
      gnoPrice: inputSettings.virtualCowToken.gnoPrice,
      nativeTokenPrice: inputSettings.virtualCowToken.nativeTokenPrice,
      merkleRoot,
      usdcToken: "0x0000000000000000000000000000000000000000",
      gnoToken: "0x0000000000000000000000000000000000000000",
      wrappedNativeToken: "0x0000000000000000000000000000000000000000",
    },
  };
  // const proposal = await generateDeploymentProposal(
  //   settings,
  //   {
  //     ...defaultSafeDeploymentAddresses(chainId),
  //     forwarder: DEFAULT_FORWARDER,
  //   },
  //   {
  //     ...defaultSafeDeploymentAddresses("100"),
  //     forwarder: DEFAULT_FORWARDER,
  //   },
  //   hre.ethers,
  // );
  // const { steps, addresses } = proposal;

  // let txHashes = null;
  // if (
  //   Object.keys(realityModuleAddress).includes(chainId) &&
  //   settings.multisend !== undefined
  // ) {
  //   console.log("Generating proposal transaction hashes...");
  //   txHashes = await getSnapshotTransactionHashes(
  //     steps,
  //     settings.multisend,
  //     chainId as keyof typeof realityModuleAddress,
  //     hre.ethers.provider,
  //   );
  // }

  const contractDeployer = await hre.ethers.getContractFactory(
    "CowProtocolVirtualToken",
  );
  const bridgedTokenDeployer = await contractDeployer.deploy(
    ...constructorInput(ContractName.VirtualToken, {
      ...settings.virtualCowToken,
      realToken: "0x5Fe27BF718937CA1c4a7818D246Cd4e755C7470c",
      usdcPrice: "0",
      communityFundsTarget: "0x0000000000000000000000000000000000000000",
      teamController: settings.teamController.expectedAddress as string,
      investorFundsTarget: "0x0000000000000000000000000000000000000000",
    }),
  );

  console.log("Clearing old files...");
  await fs.rm(`${outputFolder}/addresses.json`, {
    recursive: true,
    force: true,
  });
  await fs.rm(`${outputFolder}/steps.json`, { recursive: true, force: true });
  await fs.rm(`${outputFolder}/txhashes.json`, {
    recursive: true,
    force: true,
  });
  await fs.rm(`${outputFolder}/claims.json`, { recursive: true, force: true });
  await removeSplitClaimFiles(outputFolder);

  console.log("Saving generated data to file...");
  await fs.mkdir(outputFolder, { recursive: true });
  await fs.writeFile(
    `${outputFolder}/address.json`,
    JSON.stringify(bridgedTokenDeployer.address, undefined, 2),
  );
  // await fs.writeFile(
  //   `${outputFolder}/steps.json`,
  //   JSON.stringify(steps, undefined, 2),
  // );
  // if (txHashes !== null) {
  //   await fs.writeFile(
  //     `${outputFolder}/txhashes.json`,
  //     JSON.stringify(txHashes, undefined, 2),
  //   );
  // }
  await fs.writeFile(
    `${outputFolder}/claims.json`,
    JSON.stringify(claimsWithProof),
  );
  await splitClaimsAndSaveToFolder(claimsWithProof, outputFolder);

  return [bridgedTokenDeployer, settings];
}
