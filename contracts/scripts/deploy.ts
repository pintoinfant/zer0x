import { ethers } from "hardhat";

async function main() {
  const [deployer] = await ethers.getSigners();
  console.log("Deploying with account:", deployer.address);
  console.log("Balance:", ethers.formatEther(await ethers.provider.getBalance(deployer.address)));

  // 1. Deploy PayAgentVerifier
  console.log("\n1. Deploying PayAgentVerifier...");
  const VerifierFactory = await ethers.getContractFactory("PayAgentVerifier");
  const verifier = await VerifierFactory.deploy(ethers.ZeroAddress, 0); // zero attestation, TEE type
  await verifier.waitForDeployment();
  const verifierAddr = await verifier.getAddress();
  console.log("PayAgentVerifier deployed to:", verifierAddr);

  // 2. Deploy PayAgentNFT implementation
  console.log("\n2. Deploying PayAgentNFT implementation...");
  const NFTFactory = await ethers.getContractFactory("PayAgentNFT");
  const nftImpl = await NFTFactory.deploy();
  await nftImpl.waitForDeployment();
  const nftImplAddr = await nftImpl.getAddress();
  console.log("PayAgentNFT implementation:", nftImplAddr);

  // 3. Deploy UpgradeableBeacon
  console.log("\n3. Deploying UpgradeableBeacon...");
  const BeaconFactory = await ethers.getContractFactory("UpgradeableBeacon");
  const beacon = await BeaconFactory.deploy(nftImplAddr, deployer.address);
  await beacon.waitForDeployment();
  const beaconAddr = await beacon.getAddress();
  console.log("UpgradeableBeacon deployed to:", beaconAddr);

  // 4. Prepare initialization data
  const nftName = process.env.ZG_NFT_NAME || "PayAgent iNFT";
  const nftSymbol = process.env.ZG_NFT_SYMBOL || "PAYAGENT";
  const chainURL = process.env.ZG_RPC_URL || "https://evmrpc-testnet.0g.ai";
  const indexerURL =
    process.env.ZG_INDEXER_URL || "https://indexer-storage-testnet-turbo.0g.ai";

  const initData = NFTFactory.interface.encodeFunctionData("initialize", [
    nftName,
    nftSymbol,
    verifierAddr,
    chainURL,
    indexerURL,
  ]);

  // 5. Deploy BeaconProxy
  console.log("\n4. Deploying BeaconProxy...");
  const ProxyFactory = await ethers.getContractFactory("BeaconProxy");
  const proxy = await ProxyFactory.deploy(beaconAddr, initData);
  await proxy.waitForDeployment();
  const proxyAddr = await proxy.getAddress();
  console.log("PayAgentNFT proxy deployed to:", proxyAddr);

  // 6. Verify initialization
  const payAgentNFT = NFTFactory.attach(proxyAddr);
  const name = await payAgentNFT.name();
  const symbol = await payAgentNFT.symbol();
  console.log(`\nVerification: name="${name}", symbol="${symbol}"`);

  console.log("\n=== Deployment Complete ===");
  console.log("PayAgentVerifier:", verifierAddr);
  console.log("PayAgentNFT (proxy):", proxyAddr);
  console.log("PayAgentNFT (impl):", nftImplAddr);
  console.log("Beacon:", beaconAddr);
  console.log("\nAdd to your .env:");
  console.log(`PAYAGENT_NFT_ADDRESS=${proxyAddr}`);
  console.log(`PAYAGENT_VERIFIER_ADDRESS=${verifierAddr}`);
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
