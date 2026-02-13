import {
    createPublicClient,
    createWalletClient,
    http,
    keccak256,
    toHex,
    toBytes,
    pad,
    stringToHex,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { base } from 'viem/chains';
import { config, isNetConfigured } from '../config.js';
import { createLogger } from '../logger.js';
import { withRetry } from '../retry.js';

// ============================================================================
// QasidAI — Net Protocol Client
// Interfaces with Net Protocol's on-chain Storage contract on Base L2
// ============================================================================

const log = createLogger('NetClient');

// Net Protocol Storage contract — same address on all chains
const STORAGE_CONTRACT = '0x00000000DB40fcB9f4466330982372e27Fd7Bbf5' as const;

// Net Protocol Core contract — for direct Botchan feed posting
const NET_CORE_CONTRACT = '0x00000000B24D62781dB359b07880a105cD0b64e6' as const;

// Minimal ABI for Net Core contract (Botchan messaging)
const NET_CORE_ABI = [
    {
        name: 'sendMessage',
        type: 'function',
        stateMutability: 'nonpayable',
        inputs: [
            { name: 'text', type: 'string' },
            { name: 'topic', type: 'string' },
            { name: 'data', type: 'bytes' },
        ],
        outputs: [],
    },
] as const;

// Minimal ABI for Net Protocol Storage contract
const STORAGE_ABI = [
    {
        name: 'put',
        type: 'function',
        stateMutability: 'nonpayable',
        inputs: [
            { name: 'key', type: 'bytes32' },
            { name: 'text', type: 'string' },
            { name: 'data', type: 'bytes' },
        ],
        outputs: [],
    },
    {
        name: 'get',
        type: 'function',
        stateMutability: 'view',
        inputs: [
            { name: 'key', type: 'bytes32' },
            { name: 'operator', type: 'address' },
        ],
        outputs: [
            { name: 'text', type: 'string' },
            { name: 'data', type: 'bytes' },
        ],
    },
    {
        name: 'getValueAtIndex',
        type: 'function',
        stateMutability: 'view',
        inputs: [
            { name: 'key', type: 'bytes32' },
            { name: 'operator', type: 'address' },
            { name: 'idx', type: 'uint256' },
        ],
        outputs: [
            { name: 'text', type: 'string' },
            { name: 'data', type: 'bytes' },
        ],
    },
    {
        name: 'getTotalWrites',
        type: 'function',
        stateMutability: 'view',
        inputs: [
            { name: 'key', type: 'bytes32' },
            { name: 'operator', type: 'address' },
        ],
        outputs: [{ name: '', type: 'uint256' }],
    },
] as const;

// TODO: Replace 'any' with proper viem types once writeContract calls are updated
// to explicitly pass 'account'. Currently, the wallet client injects account at
// runtime but viem's strict types require it in each call's params.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let publicClient: any = null;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let walletClient: any = null;
let walletAddress: `0x${string}` | null = null;

/**
 * Initialize the Net Protocol client (Base L2).
 */
function ensureClients() {
    if (!isNetConfigured) {
        throw new Error('Net Protocol is not configured — set NET_PRIVATE_KEY in .env');
    }

    if (!publicClient) {
        publicClient = createPublicClient({
            chain: base,
            transport: http(),
        });
    }

    if (!walletClient) {
        const account = privateKeyToAccount(config.NET_PRIVATE_KEY as `0x${string}`);
        walletAddress = account.address;
        walletClient = createWalletClient({
            account,
            chain: base,
            transport: http(),
        });
    }
}

/**
 * Get QasidAI's on-chain wallet address.
 */
export function getWalletAddress(): string {
    ensureClients();
    return walletAddress!;
}

/**
 * Convert a storage key into bytes32, matching @net-protocol/storage SDK convention.
 * - Keys ≤32 bytes: UTF-8 encode + right-pad to 32 bytes
 * - Keys >32 bytes: keccak256 hash
 * Keys are lowercased first (SDK convention).
 */
function storageKeyToBytes32(key: string): `0x${string}` {
    const lowered = key.toLowerCase();
    if (lowered.length <= 32) {
        const bytes = new TextEncoder().encode(lowered);
        const hexString = toHex(bytes);
        return pad(hexString as `0x${string}`, { size: 32 }) as `0x${string}`;
    }
    // Long keys: keccak256 hash (matching keccak256HashString from @net-protocol/core)
    const stringAsBytes = toBytes(stringToHex(lowered));
    return keccak256(stringAsBytes) as `0x${string}`;
}

/**
 * Write data to Net Protocol Storage.
 * @param key Human-readable key (e.g. "qasid-personality")
 * @param text Metadata description
 * @param data The actual data to store (will be UTF-8 encoded)
 */
export async function writeStorage(key: string, text: string, data: string): Promise<string> {
    ensureClients();

    const keyHash = storageKeyToBytes32(key);
    const dataBytes = toHex(toBytes(data));

    log.info(`Writing to Net Storage: key="${key}"`, { textPreview: text.slice(0, 50) });

    return withRetry(async () => {
        const txHash = await walletClient!.writeContract({
            address: STORAGE_CONTRACT,
            abi: STORAGE_ABI,
            functionName: 'put',
            args: [keyHash, text, dataBytes],
            chain: base,
        });

        log.info(`✅ Net Storage write confirmed`, { txHash, key });
        return txHash;
    }, {
        maxRetries: 3,
        baseDelayMs: 2000,
        label: `Net Storage write (${key})`,
        circuitBreakerKey: 'net-storage',
    });
}

/**
 * Read the latest data from Net Protocol Storage.
 * @param key Human-readable key
 * @param operator Wallet address that wrote the data (defaults to QasidAI's wallet)
 */
export async function readStorage(key: string, operator?: string): Promise<{ text: string; data: string } | null> {
    ensureClients();

    const keyHash = storageKeyToBytes32(key);
    const op = (operator || walletAddress!) as `0x${string}`;

    try {
        const [text, dataBytes] = await publicClient!.readContract({
            address: STORAGE_CONTRACT,
            abi: STORAGE_ABI,
            functionName: 'get',
            args: [keyHash, op],
        }) as [string, `0x${string}`];

        if (!dataBytes || dataBytes === '0x') {
            return null;
        }

        // Decode bytes back to UTF-8 string
        const data = Buffer.from(dataBytes.slice(2), 'hex').toString('utf-8');
        return { text, data };
    } catch (error) {
        log.debug(`No data found for key="${key}"`, { error: String(error) });
        return null;
    }
}

/**
 * Get the total number of versions for a storage key.
 */
export async function getTotalVersions(key: string, operator?: string): Promise<number> {
    ensureClients();

    const keyHash = storageKeyToBytes32(key);
    const op = (operator || walletAddress!) as `0x${string}`;

    try {
        const total = await publicClient!.readContract({
            address: STORAGE_CONTRACT,
            abi: STORAGE_ABI,
            functionName: 'getTotalWrites',
            args: [keyHash, op],
        }) as bigint;

        return Number(total);
    } catch {
        return 0;
    }
}

/**
 * Read a specific historical version of stored data.
 */
export async function readStorageAtVersion(
    key: string,
    index: number,
    operator?: string,
): Promise<{ text: string; data: string } | null> {
    ensureClients();

    const keyHash = storageKeyToBytes32(key);
    const op = (operator || walletAddress!) as `0x${string}`;

    try {
        const [text, dataBytes] = await publicClient!.readContract({
            address: STORAGE_CONTRACT,
            abi: STORAGE_ABI,
            functionName: 'getValueAtIndex',
            args: [keyHash, op, BigInt(index)],
        }) as [string, `0x${string}`];

        if (!dataBytes || dataBytes === '0x') {
            return null;
        }

        const data = Buffer.from(dataBytes.slice(2), 'hex').toString('utf-8');
        return { text, data };
    } catch (error) {
        log.debug(`No data at version ${index} for key="${key}"`, { error: String(error) });
        return null;
    }
}

// ============================================================================
// Botchan Feed Posting — visible on netprotocol.app
// ============================================================================

/**
 * Post a message to a Botchan topic feed on Net Protocol.
 * This makes QasidAI visible on netprotocol.app's Botchan feed and "My content" section.
 * @param text The message text (the actual content to display)
 * @param topic The feed/topic name (e.g., 'trading', 'lisan-holdings')
 * @param data Optional additional data (default: empty)
 */
export async function postToFeed(text: string, topic: string, data?: string): Promise<string> {
    ensureClients();

    const dataBytes = data ? toHex(toBytes(data)) : '0x' as `0x${string}`;

    // Normalize topic with 'feed-' prefix (matches @net-protocol/feeds convention)
    const normalizedTopic = topic.toLowerCase().startsWith('feed-') ? topic.toLowerCase() : `feed-${topic.toLowerCase()}`;

    log.info(`Posting to Botchan feed: topic="${normalizedTopic}"`, { textPreview: text.slice(0, 80) });

    return withRetry(async () => {
        const txHash = await walletClient!.writeContract({
            address: NET_CORE_CONTRACT,
            abi: NET_CORE_ABI,
            functionName: 'sendMessage',
            args: [text, normalizedTopic, dataBytes],
            chain: base,
        });

        log.info(`✅ Botchan post confirmed`, { txHash, topic: normalizedTopic });
        return txHash;
    }, {
        maxRetries: 3,
        baseDelayMs: 2000,
        label: `Botchan post (${topic})`,
        circuitBreakerKey: 'net-botchan',
    });
}
