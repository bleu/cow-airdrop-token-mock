import { promises as fs } from "fs";

import { BigNumber, BigNumberish, utils } from "ethers";
import { task } from "hardhat/config";
import { HardhatRuntimeEnvironment } from "hardhat/types";

import {
  computeProofs,
  parseCsvFile,
  DeploymentHelperDeployParams,
  constructorInput,
  ContractName,
  getDeployArgsFromBridgedTokenDeployer,
  getExpectedAddresses,
  ReducedDeploymentProposalSettings,
} from "../ts";
import { defaultTokens } from "../ts/lib/constants";
import { removeSplitClaimFiles, splitClaimsAndSaveToFolder } from "../ts/split";

import { CowDeploymentArgs } from "./ts/deployment";
import { defaultSafeDeploymentAddresses, SupportedChainId } from "./ts/safe";

export const OUTPUT_FOLDER_GC = "./output/deployment-gc";

interface Args extends CowDeploymentArgs {
  verify: string;
}

const setupBridgedTokenDeployerTask: () => void = () => {
  task(
    "deployment-bridged-token-deployer",
    "Generate the list of claims from a csv and reads settings from json and deploys the bridged token deployer on gnosis chain",
  )
    .addParam(
      "claims",
      "Path to the CSV file that contains the list of claims to generate.",
    )
    .addParam(
      "settings",
      "Path to the JSON file that contains the deployment settings.",
    )
    .addFlag(
      "verify",
      "If set, the factory is not deployed but the existing deployment in the settings is checked against the computed parameter.",
    )
    .setAction(generateDeployment);
};

export { setupBridgedTokenDeployerTask };

async function generateDeployment(
  { claims: claimCsv, settings: settingsJson, verify }: Args,
  hre: HardhatRuntimeEnvironment,
): Promise<void> {
  const { ethers } = hre;
  const [deployer] = await ethers.getSigners();

  const chainId = (await hre.ethers.provider.getNetwork()).chainId.toString();
  // if (chainId !== "100") {
  //   throw new Error(
  //     `This script must be run on gnosis chain. Found chainId ${chainId}`,
  //   );
  // }

  console.log(settingsJson);

  const settings: ReducedDeploymentProposalSettings = JSON.parse(
    await fs.readFile(settingsJson, "utf8"),
  );
  console.log(`Using deployer ${deployer.address}`);

  console.log("Reading user claims for gnosis chain from file...");
  const claims = await parseCsvFile(claimCsv);

  console.log("Generating Merkle proofs...");
  const { merkleRoot, claims: claimsWithProof } = computeProofs(claims);

  // const { cowToken, cowDao } = await getExpectedAddresses(
  //   settings,
  //   defaultSafeDeploymentAddresses(chainId as SupportedChainId),
  //   defaultSafeDeploymentAddresses("100"),
  //   hre.ethers,
  // );

  // if (settings.cowToken.expectedAddress !== undefined) {
  //   if (
  //     settings.cowToken.expectedAddress.toLowerCase() !== cowToken.toLowerCase()
  //   ) {
  //     throw new Error(
  //       `Expected cowToken address ${settings.cowToken.expectedAddress} does not coincide with calculated address ${cowToken}`,
  //     );
  //   }
  // } else {
  //   console.warn("settings.cowToken.expectedAddress was not defined");
  // }

  // if (settings.cowDao.expectedAddress !== undefined) {
  //   if (
  //     settings.cowDao.expectedAddress.toLowerCase() !== cowDao.toLowerCase()
  //   ) {
  //     throw new Error(
  //       "Expected cowDao address does not coincide with calculated address",
  //     );
  //   }
  // } else {
  //   console.warn("settings.cowDao.expectedAddress was not defined");
  // }

  const deploymentHelperParameters: DeploymentHelperDeployParams = {
    foreignToken: "0x0000000000000000000000000000000000000000",
    multiTokenMediatorGnosisChain:
      settings.bridge.multiTokenMediatorGnosisChain,
    merkleRoot,
    communityFundsTarget: "0x0000000000000000000000000000000000000000",
    gnoToken: "0x0000000000000000000000000000000000000000",
    gnoPrice: settings.virtualCowToken.gnoPrice,
    nativeTokenPrice: utils.parseUnits("0.15", 18).toString(), // the price of one unit of COW in xDAI
    wrappedNativeToken: "0x0000000000000000000000000000000000000000",
  };

  console.log(
    "The following deployment parameters will be used",
    deploymentHelperParameters,
  );

  let bridgedTokenDeployerAddress;
  if (!verify) {
    const BridgedTokenDeployer = await hre.ethers.getContractFactory(
      "BridgedTokenDeployer",
    );
    const bridgedTokenDeployer = await BridgedTokenDeployer.deploy(
      ...constructorInput(
        ContractName.BridgedTokenDeployer,
        deploymentHelperParameters,
      ),
    );

    bridgedTokenDeployerAddress = bridgedTokenDeployer.address;
  } else {
    if (settings.bridgedTokenDeployer === undefined) {
      throw new Error(
        "Bridged token deployer not found in settings, nothing to verify.",
      );
    }
    bridgedTokenDeployerAddress = settings.bridgedTokenDeployer;
    await verifyDeployment(
      bridgedTokenDeployerAddress,
      deploymentHelperParameters,
      hre,
    );
  }

  console.log("Clearing old files...");
  await fs.rm(`${OUTPUT_FOLDER_GC}/addresses.json`, {
    recursive: true,
    force: true,
  });
  await fs.rm(`${OUTPUT_FOLDER_GC}/claims.json`, {
    recursive: true,
    force: true,
  });
  await removeSplitClaimFiles(OUTPUT_FOLDER_GC);

  console.log("Saving generated data to file...");
  await fs.mkdir(OUTPUT_FOLDER_GC, { recursive: true });
  await fs.writeFile(
    `${OUTPUT_FOLDER_GC}/addresses.json`,
    JSON.stringify(bridgedTokenDeployerAddress, undefined, 2),
  );
  await fs.writeFile(
    `${OUTPUT_FOLDER_GC}/claims.json`,
    JSON.stringify(claimsWithProof),
  );
  await splitClaimsAndSaveToFolder(claimsWithProof, OUTPUT_FOLDER_GC);
}

async function verifyDeployment(
  address: string,
  expectedParams: DeploymentHelperDeployParams,
  hre: HardhatRuntimeEnvironment,
) {
  const instance = await hre.ethers.getContractAt(
    ContractName.BridgedTokenDeployer,
    address,
  );
  const realParams = await getDeployArgsFromBridgedTokenDeployer(instance);

  for (const key of Object.keys(
    realParams,
  ) as (keyof DeploymentHelperDeployParams)[]) {
    const real = stringifyParam(realParams[key]);
    const expected = stringifyParam(expectedParams[key]);
    if (real !== expected) {
      throw new Error(
        `Bad parameter detected! Expected parameter ${key} to be ${expected}, found ${real}`,
      );
    }
  }

  console.log(
    `The deployment parameters of contract ${address} match the settings of the proposal.`,
  );
}

function stringifyParam(input: string | BigNumberish): string {
  return typeof input === "string" ? input : BigNumber.from(input).toString();
}
