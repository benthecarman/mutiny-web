/* eslint-disable @typescript-eslint/no-explicit-any */

import {
    Network as BarkNetwork,
    Config,
    generateMnemonic,
    OnchainWallet,
    validateArkAddress,
    validateMnemonic,
    Wallet
} from "@secondts/bark";
import {
    EventTemplate,
    finalizeEvent,
    generateSecretKey,
    getPublicKey,
    nip04,
    nip19,
    Event as NostrEvent,
    SimplePool
} from "nostr-tools";

import { IActivityItem } from "~/components";
import { MutinyWalletSettingStrings } from "~/logic/mutinyWalletSetup";
import { FakeDirectMessage, OnChainTx } from "~/routes";
import {
    DiscoveredFederation,
    MutinyFederationIdentity,
    ResyncProgress
} from "~/routes/settings";
import {
    ActivityItem,
    BudgetPeriod,
    ChannelClosure,
    FederationBalances,
    FedimintSweepResult,
    LnUrlParams,
    MutinyBalance,
    MutinyBip21RawMaterials,
    MutinyChannel,
    MutinyInvoice,
    MutinyPeer,
    NwcProfile,
    PaymentParams,
    PendingNwcInvoice,
    TagItem
} from "~/types/wallet";
import { bech32 } from "~/utils/bech32";
import {
    DEFAULT_PRIMAL_URL,
    primalRequest as requestPrimal
} from "~/utils/primal";

type NostrMetadata = {
    name?: string;
    display_name?: string;
    picture?: string;
    lud16?: string;
    nip05?: string;
    deleted?: boolean;
};

type BarkPersistedState = {
    mnemonic: string;
};

type StoredContact = {
    name: string;
    npub?: string;
    ln_address?: string;
    lnurl?: string;
    image_url?: string;
    last_used: number;
};

type NostrState = {
    secretKey?: string;
    pubkey?: string;
    profile?: NostrMetadata;
    follows: string[];
};

const STORAGE_DB = "mutiny-bark-state";
const STORAGE_STORE = "kv";
const STORAGE_KEY = "wallet";
const CONTACTS_KEY = "contacts";
const NOSTR_KEY = "nostr";
const BARK_WALLET_DB = "mutiny-bark-wallet";
const BARK_ONCHAIN_WALLET_DB = "mutiny-bark-onchain-wallet";
const DEFAULT_NOSTR_RELAYS = [
    "wss://relay.damus.io",
    "wss://nos.lol",
    "wss://relay.primal.net",
    "wss://nostr.wine"
];

let wallet: Wallet | undefined;
let onchainWallet: OnchainWallet | undefined;
let activeConfig: Config | undefined;
let activePrimalApi: string | undefined;
let walletNetwork: BarkNetwork = "Signet";
const createdInvoices = new Map<string, MutinyInvoice>();
const receiveClaimPromises = new Map<string, Promise<void>>();
export let wasm_initialized = false;
export let wallet_initialized = false;

function unsupported(feature: string): never {
    throw new Error(`${feature} is not supported by the Bark backend.`);
}

function sats(value: number | bigint | undefined): bigint {
    if (value === undefined) return 0n;
    return typeof value === "bigint" ? value : BigInt(Math.trunc(value));
}

function wordsToInt(words: number[]): number {
    return Number(words.reduce((acc, word) => (acc << 5n) + BigInt(word), 0n));
}

function wordsToHex(words: number[]): string {
    return bech32
        .fromWords(words)
        .map((byte) => byte.toString(16).padStart(2, "0"))
        .join("");
}

function parseBolt11Amount(prefix: string): bigint {
    const currencyPrefixes = ["lnbcrt", "lntbs", "lntb", "lnbc", "lnsb"];
    const currency = currencyPrefixes.find((currency) =>
        prefix.startsWith(currency)
    );
    const amount = currency ? prefix.slice(currency.length) : "";
    if (!amount) return 0n;

    const unit = amount.at(-1);
    const raw = unit && /[munp]/u.test(unit) ? amount.slice(0, -1) : amount;
    if (!/^\d+$/u.test(raw)) return 0n;

    const value = BigInt(raw);
    switch (unit) {
        case "m":
            return value * 100_000n;
        case "u":
            return value * 100n;
        case "n":
            return value / 10n;
        case "p":
            return value / 10_000n;
        default:
            return value * 100_000_000n;
    }
}

function decodeBolt11Invoice(invoice: string): MutinyInvoice {
    const decoded = bech32.decode(invoice, 4096);
    const [timestampWords, tagWords] = [
        decoded.words.slice(0, 7),
        decoded.words.slice(7)
    ];
    const timestamp = wordsToInt(timestampWords);
    let description: string | undefined;
    let expiry = 3600;
    let paymentHash: string | undefined;
    let payeePubkey: string | undefined;

    for (let i = 0; i + 3 <= tagWords.length; ) {
        const tag = tagWords[i];
        const length = (tagWords[i + 1] << 5) + tagWords[i + 2];
        const data = tagWords.slice(i + 3, i + 3 + length);
        i += 3 + length;

        if (tag === 1) paymentHash = wordsToHex(data);
        if (tag === 6) expiry = wordsToInt(data);
        if (tag === 13) {
            description = new TextDecoder().decode(
                new Uint8Array(bech32.fromWords(data))
            );
        }
        if (tag === 19) payeePubkey = wordsToHex(data);
    }

    const expire = timestamp + expiry;

    return {
        amount_sats: parseBolt11Amount(decoded.prefix),
        bolt11: invoice,
        description,
        expire,
        expired: Math.floor(Date.now() / 1000) > expire,
        inbound: false,
        labels: [],
        paid: false,
        payment_hash: paymentHash,
        payee_pubkey: payeePubkey,
        potential_hodl_invoice: false,
        status: "unpaid"
    };
}

function barkNetwork(network?: string): BarkNetwork {
    switch (network?.toLowerCase()) {
        case "bitcoin":
            return "Bitcoin";
        case "testnet":
            return "Testnet";
        case "regtest":
            return "Regtest";
        case "signet":
        default:
            return "Signet";
    }
}

function mutinyNetwork(network: BarkNetwork): string {
    return network.toLowerCase();
}

function barkServerAddress(settings: MutinyWalletSettingStrings): string {
    const envServer =
        import.meta.env.VITE_BARK_SERVER || import.meta.env.VITE_ARK_SERVER;
    const server =
        envServer ||
        (barkNetwork(settings.network) === "Signet"
            ? "https://ark.signet.2nd.dev"
            : undefined);
    if (!server) {
        throw new Error(
            "Missing Bark server address. Set VITE_BARK_SERVER or VITE_ARK_SERVER in your .env file."
        );
    }
    return server;
}

function barkConfig(settings: MutinyWalletSettingStrings): Config {
    walletNetwork = barkNetwork(settings.network);
    activeConfig = {
        serverAddress: barkServerAddress(settings),
        esploraAddress:
            settings.esplora ||
            (walletNetwork === "Signet"
                ? "https://esplora.signet.2nd.dev"
                : undefined),
        network: walletNetwork,
        daemonManualSync: true
    };
    return activeConfig;
}

async function openDb(): Promise<IDBDatabase> {
    return await new Promise((resolve, reject) => {
        const request = indexedDB.open(STORAGE_DB, 1);
        request.onupgradeneeded = () => {
            request.result.createObjectStore(STORAGE_STORE);
        };
        request.onerror = () => reject(request.error);
        request.onsuccess = () => resolve(request.result);
    });
}

async function readState(): Promise<BarkPersistedState | undefined> {
    const db = await openDb();
    return await new Promise((resolve, reject) => {
        const tx = db.transaction(STORAGE_STORE, "readonly");
        const request = tx.objectStore(STORAGE_STORE).get(STORAGE_KEY);
        request.onerror = () => reject(request.error);
        request.onsuccess = () =>
            resolve(request.result as BarkPersistedState | undefined);
    });
}

async function writeState(state: BarkPersistedState): Promise<void> {
    const db = await openDb();
    await new Promise<void>((resolve, reject) => {
        const tx = db.transaction(STORAGE_STORE, "readwrite");
        tx.objectStore(STORAGE_STORE).put(state, STORAGE_KEY);
        tx.onerror = () => reject(tx.error);
        tx.oncomplete = () => resolve();
    });
}

async function deleteState(): Promise<void> {
    indexedDB.deleteDatabase(STORAGE_DB);
}

async function readKv<T>(key: string): Promise<T | undefined> {
    const db = await openDb();
    return await new Promise((resolve, reject) => {
        const tx = db.transaction(STORAGE_STORE, "readonly");
        const request = tx.objectStore(STORAGE_STORE).get(key);
        request.onerror = () => reject(request.error);
        request.onsuccess = () => resolve(request.result as T | undefined);
    });
}

async function writeKv<T>(key: string, value: T): Promise<void> {
    const db = await openDb();
    await new Promise<void>((resolve, reject) => {
        const tx = db.transaction(STORAGE_STORE, "readwrite");
        tx.objectStore(STORAGE_STORE).put(value, key);
        tx.onerror = () => reject(tx.error);
        tx.oncomplete = () => resolve();
    });
}

async function readContacts(): Promise<Record<string, StoredContact>> {
    return (await readKv<Record<string, StoredContact>>(CONTACTS_KEY)) || {};
}

async function writeContacts(
    contacts: Record<string, StoredContact>
): Promise<void> {
    await writeKv(CONTACTS_KEY, contacts);
}

async function readNostrState(): Promise<NostrState> {
    return (
        (await readKv<NostrState>(NOSTR_KEY)) || {
            follows: []
        }
    );
}

async function writeNostrState(state: NostrState): Promise<void> {
    await writeKv(NOSTR_KEY, { ...state, follows: state.follows || [] });
}

function bytesToHex(bytes: Uint8Array): string {
    return Array.from(bytes)
        .map((byte) => byte.toString(16).padStart(2, "0"))
        .join("");
}

function hexToBytes(hex: string): Uint8Array {
    if (!/^[0-9a-f]*$/iu.test(hex) || hex.length % 2 !== 0) {
        throw new Error("Invalid hex string.");
    }
    const bytes = new Uint8Array(hex.length / 2);
    for (let i = 0; i < bytes.length; i += 1) {
        bytes[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
    }
    return bytes;
}

function base64ToBytes(base64: string): Uint8Array {
    const binary = atob(base64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i += 1) {
        bytes[i] = binary.charCodeAt(i);
    }
    return bytes;
}

function base64Encode(value: string): string {
    return btoa(value);
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
    const digest = await crypto.subtle.digest("SHA-256", bytes);
    return bytesToHex(new Uint8Array(digest));
}

function normalizePubkey(value: string): string {
    const trimmed = value.trim();
    if (/^[0-9a-f]{64}$/iu.test(trimmed)) return trimmed.toLowerCase();

    const decoded = nip19.decode(trimmed);
    if (decoded.type !== "npub") {
        throw new Error("Expected a Nostr npub or hex public key.");
    }
    return decoded.data;
}

function normalizeNpub(value: string): string {
    return nip19.npubEncode(normalizePubkey(value));
}

function decodeSecretKey(nsec: string): string {
    const decoded = nip19.decode(nsec.trim());
    if (decoded.type !== "nsec") {
        throw new Error("Expected a Nostr nsec private key.");
    }
    return bytesToHex(decoded.data);
}

function newContactId(): string {
    return `contact-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function contactToTagItem(
    id: string,
    contact: StoredContact,
    follows: string[]
): TagItem {
    return {
        id,
        kind: "contact",
        name: contact.name,
        label: contact.name,
        npub: contact.npub,
        ln_address: contact.ln_address,
        lnurl: contact.lnurl,
        image_url: contact.image_url,
        primal_image_url: contact.image_url
            ? `https://primal.b-cdn.net/media-cache?s=s&a=1&u=${encodeURIComponent(
                  contact.image_url
              )}`
            : undefined,
        is_followed: contact.npub ? follows.includes(contact.npub) : false,
        last_used: contact.last_used
    };
}

function pubkeyFromSecret(secretKey: string): string {
    return getPublicKey(hexToBytes(secretKey));
}

async function ensureNostrKeys(): Promise<
    Required<Pick<NostrState, "secretKey" | "pubkey">>
> {
    let state = await readNostrState();
    if (!state.secretKey) {
        const secretKey = bytesToHex(generateSecretKey());
        state = {
            ...state,
            secretKey,
            pubkey: pubkeyFromSecret(secretKey),
            follows: state.follows || []
        };
        await writeNostrState(state);
    }

    if (!state.secretKey) throw new Error("Nostr secret key not found.");

    return {
        secretKey: state.secretKey,
        pubkey: state.pubkey || pubkeyFromSecret(state.secretKey)
    };
}

async function getNostrPubkey(): Promise<string | undefined> {
    const state = await readNostrState();
    if (state.pubkey) return state.pubkey;
    if (!state.secretKey) return undefined;
    const pubkey = pubkeyFromSecret(state.secretKey);
    await writeNostrState({ ...state, pubkey });
    return pubkey;
}

function profileContent(profile: NostrMetadata): string {
    return JSON.stringify({
        name: profile.name,
        display_name: profile.display_name || profile.name,
        picture: profile.picture,
        lud16: profile.lud16,
        nip05: profile.nip05,
        deleted: profile.deleted
    });
}

function contactListContent(): string {
    return JSON.stringify(
        Object.fromEntries(
            DEFAULT_NOSTR_RELAYS.map((relay) => [
                relay,
                { read: true, write: true }
            ])
        )
    );
}

async function publishNostrEvent(event: EventTemplate): Promise<NostrEvent> {
    const { secretKey } = await ensureNostrKeys();
    const signed = finalizeEvent(event, hexToBytes(secretKey));
    const pool = new SimplePool();
    try {
        await Promise.any(pool.publish(DEFAULT_NOSTR_RELAYS, signed));
    } finally {
        pool.close(DEFAULT_NOSTR_RELAYS);
    }
    return signed;
}

async function signNostrEvent(event: EventTemplate): Promise<NostrEvent> {
    const { secretKey } = await ensureNostrKeys();
    return finalizeEvent(event, hexToBytes(secretKey));
}

function primalApiUrl(): string {
    const url =
        activePrimalApi || import.meta.env.VITE_PRIMAL || DEFAULT_PRIMAL_URL;
    if (!url) throw new Error("Missing VITE_PRIMAL environment variable.");
    return url;
}

async function primalRequest(body: unknown): Promise<NostrEvent[]> {
    const data = await requestPrimal(primalApiUrl(), body as [string, unknown]);
    return data.filter((item): item is NostrEvent => {
        const event = item as Partial<NostrEvent>;
        return (
            typeof event.id === "string" &&
            typeof event.pubkey === "string" &&
            typeof event.kind === "number" &&
            typeof event.content === "string" &&
            Array.isArray(event.tags)
        );
    });
}

function metadataFromEvent(
    event: NostrEvent | undefined
): Record<string, string | boolean | undefined> {
    if (!event || event.kind !== 0) return {};
    try {
        return JSON.parse(event.content) as Record<
            string,
            string | boolean | undefined
        >;
    } catch (e) {
        console.warn("Unable to parse Nostr profile", e);
        return {};
    }
}

async function syncFollowContacts(limit = 40): Promise<void> {
    const state = await readNostrState();
    const pubkey = await getNostrPubkey();
    if (!pubkey) return;

    let follows = state.follows || [];
    let metadataEvents: NostrEvent[] = [];
    if (follows.length === 0) {
        const contactListResponse = await primalRequest([
            "contact_list",
            { pubkey }
        ]);
        metadataEvents = contactListResponse.filter(
            (event) => event.kind === 0
        );
        const followEvents = contactListResponse.filter(
            (event) => event.kind === 3
        );
        const latest = followEvents.sort(
            (a, b) => b.created_at - a.created_at
        )[0];
        follows =
            latest?.tags
                .filter((tag) => tag[0] === "p" && tag[1])
                .map((tag) => nip19.npubEncode(normalizePubkey(tag[1]))) || [];
        if (follows.length > 0) {
            await writeNostrState({ ...state, follows });
        }
    }

    if (follows.length === 0) return;

    const contacts = await readContacts();
    const existing = new Set(
        Object.values(contacts)
            .map((contact) => contact.npub)
            .filter(Boolean)
    );
    const missing = follows.filter((follow) => !existing.has(follow));
    if (missing.length === 0) return;

    if (metadataEvents.length === 0) {
        metadataEvents = await primalRequest([
            "user_infos",
            { pubkeys: missing.slice(0, limit).map(normalizePubkey) }
        ]);
    }
    const latestProfiles = new Map<string, NostrEvent>();
    for (const event of metadataEvents.filter((event) => event.kind === 0)) {
        const current = latestProfiles.get(event.pubkey);
        if (!current || event.created_at > current.created_at) {
            latestProfiles.set(event.pubkey, event);
        }
    }

    for (const follow of missing.slice(0, limit)) {
        const pubkeyHex = normalizePubkey(follow);
        const event = latestProfiles.get(pubkeyHex);
        const metadata = metadataFromEvent(event);

        contacts[newContactId()] = {
            name:
                String(metadata.display_name || metadata.name || "") ||
                `${follow.slice(0, 12)}...`,
            npub: follow,
            ln_address:
                typeof metadata.lud16 === "string" ? metadata.lud16 : undefined,
            lnurl:
                typeof metadata.lud06 === "string" ? metadata.lud06 : undefined,
            image_url:
                typeof metadata.picture === "string"
                    ? metadata.picture
                    : typeof metadata.image === "string"
                      ? metadata.image
                      : undefined,
            last_used: 0
        };
    }

    await writeContacts(contacts);
}

function ensureWallet(): Wallet {
    if (!wallet) throw new Error("Bark wallet is not initialized.");
    return wallet;
}

async function ensureOnchainWallet(): Promise<OnchainWallet> {
    if (onchainWallet) return onchainWallet;

    const state = await readState();
    if (!state) throw new Error("No Bark wallet seed found.");
    if (!activeConfig) throw new Error("Bark wallet is not initialized.");

    onchainWallet = await withTimeout(
        "Opening Bark on-chain wallet",
        OnchainWallet.default({
            mnemonic: state.mnemonic,
            config: activeConfig,
            dbName: BARK_ONCHAIN_WALLET_DB
        })
    );
    await withTimeout("Syncing Bark on-chain wallet", onchainWallet.sync());
    return onchainWallet;
}

async function withTimeout<T>(
    label: string,
    promise: Promise<T>,
    timeoutMs = 30_000
): Promise<T> {
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
        return await Promise.race([
            promise,
            new Promise<never>((_resolve, reject) => {
                timeout = setTimeout(() => {
                    reject(new Error(`${label} timed out after 30 seconds.`));
                }, timeoutMs);
            })
        ]);
    } finally {
        if (timeout) clearTimeout(timeout);
    }
}

function toInvoice(invoice: {
    invoice: string;
    amountSats: number;
    paymentHash: string;
}): MutinyInvoice {
    return {
        amount_sats: sats(invoice.amountSats),
        bolt11: invoice.invoice,
        expire: Math.floor(Date.now() / 1000) + 3600,
        expired: false,
        inbound: true,
        labels: [],
        paid: false,
        payment_hash: invoice.paymentHash,
        potential_hodl_invoice: false,
        status: "pending"
    };
}

function startReceiveClaim(invoice: MutinyInvoice): void {
    const paymentHash = invoice.payment_hash;
    if (!paymentHash || receiveClaimPromises.has(paymentHash)) return;

    const claimPromise = withTimeout(
        "Waiting to claim Bark lightning receive",
        ensureWallet().tryClaimLightningReceive({
            paymentHash,
            wait: true
        }),
        10 * 60_000
    )
        .then(async () => {
            const refreshed = await refreshReceiveInvoice(invoice);
            createdInvoices.set(refreshed.bolt11, refreshed);
        })
        .catch((e) => {
            console.warn("Bark lightning receive claim stopped", e);
        })
        .finally(() => {
            receiveClaimPromises.delete(paymentHash);
        });

    receiveClaimPromises.set(paymentHash, claimPromise);
}

async function refreshReceiveInvoice(
    invoice: MutinyInvoice
): Promise<MutinyInvoice> {
    const paymentHash = invoice.payment_hash;
    if (!paymentHash) return invoice;

    startReceiveClaim(invoice);
    const barkWallet = ensureWallet();
    let status = await barkWallet.lightningReceiveStatus(paymentHash);

    if (status && !status.preimageRevealed) {
        try {
            await withTimeout(
                "Claiming Bark lightning receive",
                barkWallet.tryClaimLightningReceive({
                    paymentHash,
                    wait: false
                }),
                10_000
            );
            status = await barkWallet.lightningReceiveStatus(paymentHash);
        } catch (e) {
            console.warn("Unable to claim Bark lightning receive yet", e);
        }
    }

    const refreshed = {
        ...invoice,
        amount_sats: status ? sats(status.amountSats) : invoice.amount_sats,
        bolt11: status?.invoice || invoice.bolt11,
        paid: !!status?.preimageRevealed,
        preimage: status?.paymentPreimage,
        status: status?.preimageRevealed ? "succeeded" : "pending"
    };
    createdInvoices.set(refreshed.bolt11, refreshed);
    return refreshed;
}

function movementToActivity(movement: {
    id: number;
    status: string;
    subsystemKind: string;
    intendedBalanceSats: number;
    effectiveBalanceSats: number;
    offchainFeeSats: number;
    createdAt: string;
    updatedAt: string;
    completedAt?: string;
}): IActivityItem {
    const inbound = movement.effectiveBalanceSats >= 0;
    return {
        id: String(movement.id),
        kind: movement.subsystemKind === "onchain" ? "OnChain" : "Lightning",
        type: movement.subsystemKind,
        status: movement.status,
        amount_sats: Math.abs(
            movement.effectiveBalanceSats || movement.intendedBalanceSats
        ),
        fee: movement.offchainFeeSats,
        inbound,
        labels: [],
        contacts: [],
        privacy_level: "NotAvailable",
        timestamp:
            Date.parse(
                movement.completedAt || movement.updatedAt || movement.createdAt
            ) / 1000,
        last_updated:
            Date.parse(movement.updatedAt || movement.createdAt) / 1000
    } as unknown as IActivityItem;
}

export async function checkForWasm() {}

export async function initializeWasm() {
    if (wasm_initialized) return;
    const barkModule = (await import(
        "@secondts/bark"
    )) as unknown as typeof import("@secondts/bark") & {
        default?: () => Promise<unknown>;
    };
    const initBark = barkModule.default;
    if (initBark) {
        await initBark();
    }
    wasm_initialized = true;
}

export async function setupMutinyWallet(
    settings: MutinyWalletSettingStrings,
    _password?: string,
    ...args: unknown[]
): Promise<boolean> {
    await initializeWasm();
    const maybeNsec = args.find(
        (arg): arg is string =>
            typeof arg === "string" && arg.trim().startsWith("nsec")
    );
    if (maybeNsec) {
        const secretKey = decodeSecretKey(maybeNsec);
        await writeNostrState({
            ...(await readNostrState()),
            secretKey,
            pubkey: pubkeyFromSecret(secretKey)
        });
    }

    const config = barkConfig(settings);
    activePrimalApi = settings.primal_api;
    let state = await readState();
    let created = false;

    if (!state) {
        state = { mnemonic: generateMnemonic() };
        await writeState(state);
        created = true;
    }

    const walletArgs = {
        mnemonic: state.mnemonic,
        config,
        dbName: BARK_WALLET_DB
    };

    console.log(created ? "Creating Bark wallet" : "Opening Bark wallet");
    if (created) {
        wallet = await withTimeout(
            "Creating Bark wallet",
            Wallet.create({
                ...walletArgs,
                forceRescan: false
            })
        );
    } else {
        try {
            wallet = await withTimeout(
                "Opening Bark wallet",
                Wallet.open(walletArgs)
            );
        } catch (e) {
            console.warn(
                "Could not open existing Bark wallet, attempting create",
                e
            );
            wallet = await withTimeout(
                "Creating Bark wallet",
                Wallet.create({
                    ...walletArgs,
                    forceRescan: false
                })
            );
        }
    }

    console.log("Syncing Bark wallet");
    await withTimeout("Syncing Bark wallet", wallet.sync());
    wallet_initialized = true;
    return true;
}

export async function get_balance(): Promise<MutinyBalance> {
    const balance = await ensureWallet().balance();
    const onchain = onchainWallet ? await onchainWallet.balance() : undefined;
    return {
        federation: 0n,
        lightning: sats(
            balance.spendableSats + balance.claimableLightningReceiveSats
        ),
        confirmed: sats(onchain?.confirmedSats),
        unconfirmed: sats(onchain?.pendingSats),
        force_close: sats(balance.pendingExitSats)
    };
}

export async function list_federations(): Promise<MutinyFederationIdentity[]> {
    return [];
}

export async function check_subscribed(): Promise<bigint | undefined> {
    return undefined;
}

export async function stop(): Promise<void> {
    wallet = undefined;
    onchainWallet = undefined;
    wallet_initialized = false;
}

export async function delete_all(): Promise<void> {
    await stop();
    await deleteState();
    indexedDB.deleteDatabase(BARK_WALLET_DB);
    indexedDB.deleteDatabase(BARK_ONCHAIN_WALLET_DB);
}

export async function get_bitcoin_price(fiat: string): Promise<number> {
    const res = await fetch(
        `https://api.coinbase.com/v2/exchange-rates?currency=BTC`
    );
    const json = await res.json();
    const price = Number(json?.data?.rates?.[fiat.toUpperCase()]);
    if (!Number.isFinite(price))
        throw new Error(`Could not fetch BTC/${fiat} price.`);
    return price;
}

export async function get_tag_items(): Promise<TagItem[]> {
    return get_contacts_sorted();
}

export async function get_network(): Promise<string> {
    return mutinyNetwork(walletNetwork);
}

export async function get_nostr_profile(): Promise<NostrMetadata | undefined> {
    const state = await readNostrState();
    if (state.profile) return state.profile;

    const pubkey = await getNostrPubkey();
    if (!pubkey) return undefined;

    const events = await primalRequest(["user_profile", { pubkey }]);
    const latest = events
        .filter((event) => event.kind === 0)
        .sort((a, b) => b.created_at - a.created_at)[0];
    if (!latest) return undefined;

    const profile = metadataFromEvent(latest) as NostrMetadata;
    await writeNostrState({ ...state, profile });
    return profile;
}

export async function get_activity(
    limit: number,
    offset = 0
): Promise<IActivityItem[]> {
    const history = await ensureWallet().history();
    return history.slice(offset, offset + limit).map(movementToActivity);
}

export async function get_contact_for_npub(
    npub: string
): Promise<TagItem | undefined> {
    const normalized = normalizeNpub(npub);
    const [contacts, nostr] = await Promise.all([
        readContacts(),
        readNostrState()
    ]);
    const entry = Object.entries(contacts).find(
        ([, contact]) => contact.npub === normalized
    );
    if (!entry) return undefined;
    return contactToTagItem(entry[0], entry[1], nostr.follows || []);
}

export async function create_new_contact(
    name: string,
    npub?: string,
    ln_address?: string,
    lnurl?: string,
    image_url?: string
): Promise<string> {
    const contacts = await readContacts();
    const id = newContactId();
    contacts[id] = {
        name,
        npub: npub ? normalizeNpub(npub) : undefined,
        ln_address,
        lnurl,
        image_url,
        last_used: Math.floor(Date.now() / 1000)
    };
    await writeContacts(contacts);
    return id;
}

export async function get_tag_item(id: string): Promise<TagItem | undefined> {
    const [contacts, nostr] = await Promise.all([
        readContacts(),
        readNostrState()
    ]);
    const contact = contacts[id];
    if (!contact) return undefined;
    return contactToTagItem(id, contact, nostr.follows || []);
}

export async function get_label_activity(
    label: string
): Promise<IActivityItem[]> {
    return (await get_activity(100)).filter((item) =>
        item.labels?.includes(label)
    );
}

export async function get_dm_conversation(
    npub: string,
    limit: number | bigint = 20,
    until?: number,
    since?: number
): Promise<FakeDirectMessage[] | undefined> {
    const state = await readNostrState();
    if (!state.secretKey || !state.pubkey) return [];

    const counterparty = normalizePubkey(npub);
    const params: Record<string, string | number> = {
        sender: state.pubkey,
        receiver: counterparty,
        limit: Number(limit),
        since: since ? Number(since) : 0
    };
    if (until) params.until = Number(until);

    const events = (await primalRequest(["get_directmsgs", params])).filter(
        (event) => event.kind === 4
    );
    const unique = new Map(events.map((event) => [event.id, event]));
    const messages: (FakeDirectMessage | undefined)[] = await Promise.all(
        Array.from(unique.values()).map(async (event) => {
            const peer =
                event.pubkey === state.pubkey ? counterparty : event.pubkey;
            try {
                return {
                    from: nip19.npubEncode(event.pubkey),
                    to: nip19.npubEncode(
                        event.tags.find((tag) => tag[0] === "p")?.[1] ||
                            state.pubkey!
                    ),
                    message: await nip04.decrypt(
                        state.secretKey!,
                        peer,
                        event.content
                    ),
                    date: event.created_at
                };
            } catch (e) {
                console.warn("Unable to decrypt Nostr DM", e);
                return undefined;
            }
        })
    );

    return messages
        .filter((message): message is FakeDirectMessage => !!message)
        .sort((a, b) => b.date - a.date)
        .slice(0, Number(limit));
}

export async function get_invoice(
    bolt11: string
): Promise<MutinyInvoice | undefined> {
    const invoice = createdInvoices.get(bolt11);
    if (invoice) {
        return refreshReceiveInvoice(invoice);
    }
    return decode_invoice(bolt11);
}

export async function get_contacts_sorted(_limit?: number): Promise<TagItem[]> {
    await syncFollowContacts(_limit);
    const [contacts, nostr] = await Promise.all([
        readContacts(),
        readNostrState()
    ]);
    return Object.entries(contacts)
        .map(([id, contact]) => contactToTagItem(id, contact, nostr.follows))
        .sort((a, b) => {
            const lastUsed =
                Number(b.last_used || 0) - Number(a.last_used || 0);
            return lastUsed || a.name.localeCompare(b.name);
        })
        .slice(0, _limit);
}

export async function edit_contact(
    id: string,
    name: string,
    npub?: string,
    ln_address?: string,
    lnurl?: string,
    image_url?: string
): Promise<void> {
    const contacts = await readContacts();
    const existing = contacts[id];
    if (!existing) throw new Error("Contact not found.");
    contacts[id] = {
        ...existing,
        name,
        npub: npub ? normalizeNpub(npub) : undefined,
        ln_address,
        lnurl,
        image_url,
        last_used: Math.floor(Date.now() / 1000)
    };
    await writeContacts(contacts);
}

export async function delete_contact(id: string): Promise<void> {
    const contacts = await readContacts();
    delete contacts[id];
    await writeContacts(contacts);
}

export async function follow_npub(npub: string): Promise<void> {
    const { pubkey } = await ensureNostrKeys();
    await syncFollowContacts();
    const normalized = normalizeNpub(npub);
    const state = await readNostrState();
    const follows = Array.from(
        new Set([
            ...(state.follows || []),
            normalized,
            nip19.npubEncode(pubkey)
        ])
    );
    await writeNostrState({ ...state, follows });
    await publishNostrEvent({
        kind: 3,
        content: contactListContent(),
        tags: follows.map((follow) => ["p", normalizePubkey(follow)]),
        created_at: Math.floor(Date.now() / 1000)
    });
}

export async function unfollow_npub(npub: string): Promise<void> {
    await ensureNostrKeys();
    await syncFollowContacts();
    const normalized = normalizeNpub(npub);
    const state = await readNostrState();
    const follows = (state.follows || []).filter(
        (follow) => follow !== normalized
    );
    await writeNostrState({ ...state, follows });
    await publishNostrEvent({
        kind: 3,
        content: contactListContent(),
        tags: follows.map((follow) => ["p", normalizePubkey(follow)]),
        created_at: Math.floor(Date.now() / 1000)
    });
}

export async function send_dm(
    npub: string,
    message: string
): Promise<string | undefined> {
    const { secretKey } = await ensureNostrKeys();
    const pubkey = normalizePubkey(npub);
    const content = await nip04.encrypt(secretKey, pubkey, message);
    const event = await publishNostrEvent({
        kind: 4,
        content,
        tags: [["p", pubkey]],
        created_at: Math.floor(Date.now() / 1000)
    });
    return event.id;
}

export async function get_npub(): Promise<string | undefined> {
    const pubkey = await getNostrPubkey();
    return pubkey ? nip19.npubEncode(pubkey) : undefined;
}

export async function decode_invoice(
    invoice: string,
    ..._args: any[]
): Promise<MutinyInvoice | undefined> {
    return decodeBolt11Invoice(invoice);
}

export async function create_bip21(
    amount: bigint | undefined,
    _labels: string[]
): Promise<MutinyBip21RawMaterials> {
    const address = await ensureWallet().newAddress();
    const query = amount ? `?amount=${await convert_sats_to_btc(amount)}` : "";
    return { address, bip21: `bitcoin:${address}${query}` };
}

export async function create_invoice(
    amount: bigint,
    _labels: string[]
): Promise<MutinyInvoice | undefined> {
    const invoice = await ensureWallet().bolt11Invoice({
        amountSats: Number(amount),
        description: "Mutiny payment"
    });
    const mutinyInvoice = toInvoice(invoice);
    createdInvoices.set(mutinyInvoice.bolt11, mutinyInvoice);
    startReceiveClaim(mutinyInvoice);
    return mutinyInvoice;
}

export async function estimate_sweep_tx_fee(
    ..._args: any[]
): Promise<bigint | undefined> {
    unsupported("On-chain sweep fee estimation");
}

export async function estimate_tx_fee(
    address: string,
    amount: bigint,
    ..._args: any[]
): Promise<bigint | undefined> {
    const fee = await ensureWallet().estimateSendOnchainFee(
        address,
        Number(amount)
    );
    return sats(fee.feeSats);
}

export async function decode_lnurl(_lnurl: string): Promise<LnUrlParams> {
    unsupported("LNURL");
}

export async function pay_invoice(
    invoice: string,
    amt_sats: bigint | undefined,
    _labels: string[]
): Promise<MutinyInvoice | undefined> {
    const decoded = decodeBolt11Invoice(invoice);
    const sent = await ensureWallet().payLightningInvoice({
        invoice,
        amountSats: amt_sats ? Number(amt_sats) : undefined
    });
    return {
        amount_sats: sats(sent.amountSats || Number(decoded.amount_sats)),
        bolt11: invoice,
        description: decoded.description,
        expire: decoded.expire,
        expired: decoded.expired,
        inbound: false,
        labels: [],
        paid: !!sent.preimage,
        payment_hash: decoded.payment_hash,
        payee_pubkey: decoded.payee_pubkey,
        potential_hodl_invoice: false,
        preimage: sent.preimage,
        status: sent.preimage ? "succeeded" : "pending"
    };
}

export async function lnurl_pay(
    ..._args: any[]
): Promise<MutinyInvoice | undefined> {
    unsupported("LNURL pay");
}

export async function sweep_wallet(
    destination_address: string,
    ..._args: any[]
): Promise<string | undefined> {
    const result = await ensureWallet().offboardAll(destination_address);
    return result.roundId;
}

export async function send_payjoin(
    ..._args: any[]
): Promise<string | undefined> {
    unsupported("Payjoin");
}

export async function send_to_address(
    destination_address: string,
    amount: bigint,
    ..._args: any[]
): Promise<string | undefined> {
    return await ensureWallet().sendOnchain(
        destination_address,
        Number(amount)
    );
}

export async function send_ark_address(
    ark_address: string,
    amount: bigint,
    ..._args: any[]
): Promise<string | undefined> {
    return await ensureWallet().sendArkoorPayment(ark_address, Number(amount));
}

export async function keysend(
    ..._args: any[]
): Promise<MutinyInvoice | undefined> {
    unsupported("Keysend");
}

export async function get_invoice_by_hash(
    hash: string
): Promise<MutinyInvoice> {
    const invoice = [...createdInvoices.values()].find(
        (invoice) => invoice.payment_hash === hash
    );
    if (invoice) {
        return refreshReceiveInvoice(invoice);
    }

    const receive = await ensureWallet().lightningReceiveStatus(hash);
    return {
        amount_sats: receive ? sats(receive.amountSats) : 0n,
        bolt11: receive?.invoice || "",
        expire: Math.floor(Date.now() / 1000) + 3600,
        expired: false,
        labels: [],
        payment_hash: hash,
        preimage: receive?.paymentPreimage,
        paid: !!receive?.preimageRevealed,
        potential_hodl_invoice: false,
        status: receive?.preimageRevealed ? "succeeded" : "pending"
    };
}

export async function get_channel_closure(
    ..._args: any[]
): Promise<ChannelClosure> {
    unsupported("Lightning channels");
}

export async function get_transaction(_txid: string): Promise<ActivityItem> {
    unsupported("Transaction lookup");
}

export async function get_new_address(
    _labels: string[]
): Promise<MutinyBip21RawMaterials> {
    const onchain = await ensureOnchainWallet();
    const address = await onchain.newAddress();
    return { address, bip21: `bitcoin:${address}` };
}

export async function get_new_ark_address(
    _labels: string[]
): Promise<MutinyBip21RawMaterials> {
    const address = await ensureWallet().newAddress();
    return { address, bip21: address };
}

function esploraAddress(): string {
    const esplora = activeConfig?.esploraAddress;
    if (!esplora) {
        throw new Error("Missing Esplora server for on-chain receive checks.");
    }
    return esplora.replace(/\/$/, "");
}

type EsploraTx = {
    txid: string;
    version: number;
    locktime: number;
    vin?: Array<{
        prevout?: {
            scriptpubkey_address?: string;
            value?: number;
        };
    }>;
    vout?: Array<{
        scriptpubkey?: string;
        scriptpubkey_address?: string;
        value?: number;
    }>;
    status?: {
        block_height?: number;
        block_time?: number;
    };
};

function esploraTxToOnChainTx(tx: EsploraTx, address: string): OnChainTx {
    const received =
        tx.vout?.reduce((total, output) => {
            if (output.scriptpubkey_address !== address) return total;
            return total + (output.value ?? 0);
        }, 0) ?? 0;
    const sent =
        tx.vin?.reduce((total, input) => {
            if (input.prevout?.scriptpubkey_address !== address) return total;
            return total + (input.prevout.value ?? 0);
        }, 0) ?? 0;

    return {
        transaction: {
            version: tx.version,
            lock_time: tx.locktime,
            input: [],
            output:
                tx.vout?.map((output) => ({
                    value: output.value ?? 0,
                    script_pubkey: output.scriptpubkey ?? ""
                })) ?? []
        },
        txid: tx.txid,
        internal_id: tx.txid,
        received,
        sent,
        confirmation_time: {
            height: tx.status?.block_height ?? 0,
            timestamp: tx.status?.block_time ?? Math.floor(Date.now() / 1000)
        }
    };
}

export async function check_address(
    address: string
): Promise<OnChainTx | undefined> {
    const onchain = await ensureOnchainWallet();
    await withTimeout("Syncing Bark on-chain wallet", onchain.sync());

    const res = await fetch(
        `${esploraAddress()}/address/${encodeURIComponent(address)}/txs`
    );
    if (!res.ok) {
        throw new Error(`Could not check address: ${res.statusText}`);
    }
    const txs = (await res.json()) as EsploraTx[];
    const tx = txs.find((tx) =>
        tx.vout?.some((output) => output.scriptpubkey_address === address)
    );
    return tx ? esploraTxToOnChainTx(tx, address) : undefined;
}

export async function check_ark_address(
    address: string
): Promise<OnChainTx | undefined> {
    await ensureWallet().sync();
    const movement = (await ensureWallet().history()).find(
        (movement) =>
            movement.effectiveBalanceSats > 0 &&
            movement.receivedOnAddresses.includes(address)
    );

    if (!movement) return undefined;

    return {
        transaction: {
            version: 0,
            lock_time: 0,
            input: [],
            output: []
        },
        txid: String(movement.id),
        internal_id: String(movement.id),
        received: movement.effectiveBalanceSats,
        sent: 0,
        confirmation_time: {
            height: 0,
            timestamp:
                Date.parse(
                    movement.completedAt ||
                        movement.updatedAt ||
                        movement.createdAt
                ) / 1000
        }
    };
}

export async function list_channels(): Promise<MutinyChannel[]> {
    return [];
}

export async function setup_new_profile(
    name?: string,
    img_url?: string,
    lnurl?: string,
    nip05?: string
): Promise<NostrMetadata> {
    await ensureNostrKeys();
    const profile: NostrMetadata = {
        name,
        display_name: name,
        picture: img_url,
        lud16: lnurl,
        nip05
    };
    await publishNostrEvent({
        kind: 0,
        content: profileContent(profile),
        tags: [],
        created_at: Math.floor(Date.now() / 1000)
    });
    await writeNostrState({ ...(await readNostrState()), profile });
    return profile;
}

export async function discover_federations(): Promise<
    DiscoveredFederation[] | undefined
> {
    return [];
}

export async function has_recommended_federation(
    ..._args: any[]
): Promise<boolean> {
    return false;
}

export async function new_federation(..._args: any[]): Promise<unknown> {
    unsupported("Fedimint");
}

export async function edit_nostr_profile(
    name?: string,
    img_url?: string,
    lnurl?: string,
    nip05?: string
): Promise<NostrMetadata> {
    await ensureNostrKeys();
    const profile: NostrMetadata = {
        name,
        display_name: name,
        picture: img_url,
        lud16: lnurl,
        nip05
    };
    await publishNostrEvent({
        kind: 0,
        content: profileContent(profile),
        tags: [],
        created_at: Math.floor(Date.now() / 1000)
    });
    await writeNostrState({ ...(await readNostrState()), profile });
    return profile;
}

export async function upload_profile_pic(img_base64: string): Promise<string> {
    const url = "https://nostr.build/api/v2/upload/profile";
    const imageBytes = base64ToBytes(img_base64);
    const payloadHash = await sha256Hex(imageBytes);
    const authEvent = await signNostrEvent({
        kind: 27235,
        content: "",
        tags: [
            ["u", url],
            ["method", "POST"],
            ["payload", payloadHash]
        ],
        created_at: Math.floor(Date.now() / 1000)
    });

    const formData = new FormData();
    formData.append("fileToUpload", new Blob([imageBytes]));

    const response = await fetch(url, {
        method: "POST",
        headers: {
            Authorization: `Nostr ${base64Encode(JSON.stringify(authEvent))}`
        },
        body: formData
    });
    if (!response.ok) throw new Error("Failed to upload profile picture.");

    const result = (await response.json()) as {
        status?: string;
        message?: string;
        data?: { url?: string }[];
    };
    const uploadedUrl = result.data?.[0]?.url;
    if (result.status !== "success" || !uploadedUrl) {
        throw new Error(result.message || "Failed to upload profile picture.");
    }

    return uploadedUrl;
}

export async function get_pending_nwc_invoices(): Promise<
    PendingNwcInvoice[] | undefined
> {
    return [];
}

export async function delete_nwc_profile(..._args: any[]): Promise<void> {
    unsupported("Nostr Wallet Connect");
}

export async function get_nwc_profiles(): Promise<NwcProfile[]> {
    return [];
}

export async function approve_nostr_wallet_auth(
    ..._args: any[]
): Promise<NwcProfile> {
    unsupported("Nostr Wallet Connect");
}

export async function get_nwc_profile(..._args: any[]): Promise<NwcProfile> {
    unsupported("Nostr Wallet Connect");
}

export async function approve_invoice(..._args: any[]): Promise<void> {
    unsupported("Nostr Wallet Connect");
}

export async function deny_invoice(..._args: any[]): Promise<void> {}

export async function deny_all_pending_nwc(): Promise<void> {}

export async function set_nwc_profile_budget(
    ..._args: any[]
): Promise<NwcProfile> {
    unsupported("Nostr Wallet Connect");
}

export async function set_nwc_profile_require_approval(
    ..._args: any[]
): Promise<NwcProfile> {
    unsupported("Nostr Wallet Connect");
}

export async function create_nwc_profile(..._args: any[]): Promise<NwcProfile> {
    unsupported("Nostr Wallet Connect");
}

export async function create_budget_nwc_profile(
    _name: string,
    _budget: bigint,
    _period: BudgetPeriod,
    ..._args: any[]
): Promise<NwcProfile> {
    unsupported("Nostr Wallet Connect");
}

export async function disconnect_peer(..._args: any[]): Promise<void> {
    unsupported("Lightning peers");
}

export async function delete_peer(..._args: any[]): Promise<void> {
    unsupported("Lightning peers");
}

export async function list_peers(): Promise<MutinyPeer[]> {
    return [];
}

export async function connect_to_peer(..._args: any[]): Promise<void> {
    unsupported("Lightning peers");
}

export async function close_channel(..._args: any[]): Promise<void> {
    unsupported("Lightning channels");
}

export async function remove_federation(..._args: any[]): Promise<void> {
    unsupported("Fedimint");
}

export async function resync_federation(..._args: any[]): Promise<void> {
    unsupported("Fedimint");
}

export async function get_federation_resync_progress(
    ..._args: any[]
): Promise<ResyncProgress | undefined> {
    return undefined;
}

export async function open_channel(..._args: any[]): Promise<MutinyChannel> {
    unsupported("Lightning channels");
}

export async function list_nodes(): Promise<string[]> {
    return [];
}

export async function change_lsp(..._args: any[]): Promise<void> {
    unsupported("LSP configuration");
}

export async function get_configured_lsp(): Promise<{
    url?: string;
    connection_string?: string;
    token?: string;
}> {
    return {};
}

export async function reset_onchain_tracker(..._args: any[]): Promise<void> {
    unsupported("On-chain tracker reset");
}

export async function start(): Promise<void> {
    await ensureWallet().sync();
}

export async function lnurl_auth(..._args: any[]): Promise<void> {
    unsupported("LNURL auth");
}

export async function get_subscription_plans(): Promise<
    { id: number; amount_sat: bigint }[]
> {
    return [];
}

export async function subscribe_to_plan(
    ..._args: any[]
): Promise<MutinyInvoice> {
    unsupported("Mutiny+");
}

export async function pay_subscription_invoice(..._args: any[]): Promise<void> {
    unsupported("Mutiny+");
}

export async function change_nostr_keys(
    nsec?: string,
    extension_pk?: string
): Promise<string> {
    let secretKey: string | undefined;
    let pubkey: string;

    if (nsec) {
        secretKey = decodeSecretKey(nsec);
        pubkey = pubkeyFromSecret(secretKey);
    } else if (extension_pk) {
        pubkey = normalizePubkey(extension_pk);
    } else {
        secretKey = bytesToHex(generateSecretKey());
        pubkey = pubkeyFromSecret(secretKey);
    }

    await writeNostrState({
        secretKey,
        pubkey,
        follows: []
    });
    return nip19.npubEncode(pubkey);
}

export async function delete_profile(..._args: any[]): Promise<void> {
    await ensureNostrKeys();
    const profile: NostrMetadata = {
        ...(await get_nostr_profile()),
        deleted: true
    };
    await publishNostrEvent({
        kind: 0,
        content: profileContent(profile),
        tags: [],
        created_at: Math.floor(Date.now() / 1000)
    });
    await writeNostrState({ ...(await readNostrState()), profile });
}

export async function export_nsec(): Promise<string | undefined> {
    const state = await readNostrState();
    return state.secretKey
        ? nip19.nsecEncode(hexToBytes(state.secretKey))
        : undefined;
}

export async function show_seed(): Promise<string> {
    const state = await readState();
    if (!state) throw new Error("No Bark wallet seed found.");
    return state.mnemonic;
}

export async function claim_single_use_nwc(
    ..._args: any[]
): Promise<string | undefined> {
    unsupported("Single-use NWC");
}

export async function lnurl_withdraw(..._args: any[]): Promise<boolean> {
    unsupported("LNURL withdraw");
}

export async function check_lnurl_name(): Promise<string | undefined> {
    return undefined;
}

export async function check_available_lnurl_name(
    ..._args: any[]
): Promise<boolean> {
    return false;
}

export async function reserve_lnurl_name(..._args: any[]): Promise<void> {
    unsupported("Mutiny Address");
}

export async function recommend_federation(..._args: any[]): Promise<string> {
    unsupported("Fedimint recommendations");
}

export async function delete_federation_recommendation(
    ..._args: any[]
): Promise<void> {
    unsupported("Fedimint recommendations");
}

export async function get_federation_balances(): Promise<FederationBalances> {
    return { balances: [] };
}

export async function change_password(..._args: any[]): Promise<void> {
    unsupported("Wallet encryption");
}

export async function convert_sats_to_btc(sats: bigint): Promise<number> {
    return Number(sats) / 100_000_000;
}

export async function convert_btc_to_sats(btc: number): Promise<bigint> {
    return BigInt(Math.round(btc * 100_000_000));
}

export async function has_node_manager(): Promise<boolean> {
    return !!(await readState());
}

export async function npub_to_hexpub(
    npub: string,
    ..._args: any[]
): Promise<string> {
    return normalizePubkey(npub);
}

export async function nsec_to_npub(nsec: string): Promise<string> {
    return nip19.npubEncode(pubkeyFromSecret(decodeSecretKey(nsec)));
}

export async function hexpub_to_npub(hexpub: string): Promise<string> {
    return nip19.npubEncode(normalizePubkey(hexpub));
}

export async function restore_mnemonic(
    mnemonic: string,
    ..._args: any[]
): Promise<void> {
    if (!validateMnemonic(mnemonic)) {
        throw new Error("Invalid mnemonic.");
    }
    await stop();
    indexedDB.deleteDatabase(BARK_WALLET_DB);
    indexedDB.deleteDatabase(BARK_ONCHAIN_WALLET_DB);
    await writeState({ mnemonic });
}

export async function import_json(..._args: any[]): Promise<void> {
    unsupported("Mutiny JSON import");
}

export async function export_json(..._args: any[]): Promise<string> {
    const state = await readState();
    return JSON.stringify({ bark: state });
}

export async function get_logs(): Promise<string[]> {
    return [];
}

export async function get_device_lock_remaining_secs(
    ..._args: any[]
): Promise<bigint | undefined> {
    return undefined;
}

export async function sweep_all_to_channel(
    ..._args: any[]
): Promise<MutinyChannel> {
    unsupported("Lightning channels");
}

export async function estimate_sweep_channel_open_fee(
    ..._args: any[]
): Promise<bigint> {
    unsupported("Lightning channels");
}

export async function sweep_federation_balance_to_invoice(
    ..._args: any[]
): Promise<FedimintSweepResult> {
    unsupported("Fedimint");
}

export async function create_sweep_federation_invoice(
    ..._args: any[]
): Promise<MutinyInvoice> {
    unsupported("Fedimint");
}

export async function parse_params(params: string): Promise<PaymentParams> {
    const value = params.trim();
    const lower = value.toLowerCase();
    const parsed: PaymentParams = { string: value };

    if (lower.startsWith("lightning:")) {
        parsed.invoice = value.slice("lightning:".length);
    } else if (
        lower.startsWith("lnbc") ||
        lower.startsWith("lntb") ||
        lower.startsWith("lnbcrt")
    ) {
        parsed.invoice = value;
    } else if (lower.startsWith("ark") || lower.startsWith("tark")) {
        parsed.ark_address = value;
    } else if (validateArkAddress(value)) {
        parsed.ark_address = value;
    } else if (lower.startsWith("bitcoin:")) {
        const url = new URL(value);
        parsed.address = url.pathname;
        const amount = url.searchParams.get("amount");
        if (amount)
            parsed.amount_sats = await convert_btc_to_sats(Number(amount));
    } else {
        parsed.address = value;
    }

    return parsed;
}
