import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';

// ============================================================================
// QasidAI — Wallet Generator
// Generates a fresh wallet for QasidAI's on-chain identity on Base L2
// Run: npx tsx src/net/generate-wallet.ts
// ============================================================================

const privateKey = generatePrivateKey();
const account = privateKeyToAccount(privateKey);

console.log(`
╔═══════════════════════════════════════════════════════════╗
║   QasidAI — Fresh Wallet Generated                       ║
╚═══════════════════════════════════════════════════════════╝

  🔑 Private Key: ${privateKey}
  📍 Address:     ${account.address}
  ⛓️  Chain:       Base (Chain ID: 8453)

  ⚠️  SAVE THE PRIVATE KEY SECURELY — you cannot recover it.

  Next steps:
  1. Copy the private key into your .env file as NET_PRIVATE_KEY
  2. Set NET_ENABLED=true in your .env
  3. Fund the wallet address with ~$0.50 of ETH on Base
     → Send Base ETH to: ${account.address}
     → You can bridge ETH to Base at https://bridge.base.org
`);
