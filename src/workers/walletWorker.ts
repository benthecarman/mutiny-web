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

const STORAGE_DB = "mutiny-bark-state";
const STORAGE_STORE = "kv";
const STORAGE_KEY = "wallet";

let wallet: Wallet | undefined;
let onchainWallet: OnchainWallet | undefined;
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
    return {
        serverAddress: barkServerAddress(settings),
        esploraAddress:
            settings.esplora ||
            (walletNetwork === "Signet"
                ? "https://esplora.signet.2nd.dev"
                : undefined),
        network: walletNetwork,
        daemonManualSync: true
    };
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

function ensureWallet(): Wallet {
    if (!wallet) throw new Error("Bark wallet is not initialized.");
    return wallet;
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
    ..._args: unknown[]
): Promise<boolean> {
    await initializeWasm();
    const config = barkConfig(settings);
    let state = await readState();
    let created = false;

    if (!state) {
        state = { mnemonic: generateMnemonic() };
        await writeState(state);
        created = true;
    }

    const args = {
        mnemonic: state.mnemonic,
        config,
        dbName: "mutiny-bark-wallet"
    };

    console.log(created ? "Creating Bark wallet" : "Opening Bark wallet");
    if (created) {
        wallet = await withTimeout(
            "Creating Bark wallet",
            Wallet.create({
                ...args,
                forceRescan: false
            })
        );
    } else {
        try {
            wallet = await withTimeout(
                "Opening Bark wallet",
                Wallet.open(args)
            );
        } catch (e) {
            console.warn(
                "Could not open existing Bark wallet, attempting create",
                e
            );
            wallet = await withTimeout(
                "Creating Bark wallet",
                Wallet.create({
                    ...args,
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
    indexedDB.deleteDatabase("mutiny-bark-wallet");
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
    return [];
}

export async function get_network(): Promise<string> {
    return mutinyNetwork(walletNetwork);
}

export async function get_nostr_profile(): Promise<NostrMetadata | undefined> {
    return undefined;
}

export async function get_activity(
    limit: number,
    offset = 0
): Promise<IActivityItem[]> {
    const history = await ensureWallet().history();
    return history.slice(offset, offset + limit).map(movementToActivity);
}

export async function get_contact_for_npub(
    _npub: string
): Promise<TagItem | undefined> {
    return undefined;
}

export async function create_new_contact(..._args: any[]): Promise<string> {
    unsupported("Contacts");
}

export async function get_tag_item(_id: string): Promise<TagItem | undefined> {
    return undefined;
}

export async function get_label_activity(
    label: string
): Promise<IActivityItem[]> {
    return (await get_activity(100)).filter((item) =>
        item.labels?.includes(label)
    );
}

export async function get_dm_conversation(
    ..._args: any[]
): Promise<FakeDirectMessage[] | undefined> {
    return [];
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
    return [];
}

export async function edit_contact(..._args: any[]): Promise<void> {
    unsupported("Contacts");
}

export async function delete_contact(..._args: any[]): Promise<void> {
    unsupported("Contacts");
}

export async function follow_npub(..._args: any[]): Promise<void> {
    unsupported("Nostr follows");
}

export async function unfollow_npub(..._args: any[]): Promise<void> {
    unsupported("Nostr follows");
}

export async function send_dm(..._args: any[]): Promise<string | undefined> {
    unsupported("Nostr DMs");
}

export async function get_npub(): Promise<string | undefined> {
    return undefined;
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
    const address = await ensureWallet().newAddress();
    return { address, bip21: `bitcoin:${address}` };
}

export async function check_address(_address: string): Promise<OnChainTx> {
    unsupported("Address monitoring");
}

export async function list_channels(): Promise<MutinyChannel[]> {
    return [];
}

export async function setup_new_profile(..._args: any[]): Promise<unknown> {
    return {};
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
    ..._args: any[]
): Promise<NostrMetadata> {
    unsupported("Nostr profile");
}

export async function upload_profile_pic(..._args: any[]): Promise<string> {
    unsupported("Profile uploads");
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

export async function change_nostr_keys(..._args: any[]): Promise<string> {
    unsupported("Nostr keys");
}

export async function delete_profile(..._args: any[]): Promise<void> {
    unsupported("Nostr profile");
}

export async function export_nsec(): Promise<string | undefined> {
    return undefined;
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
    return npub;
}

export async function nsec_to_npub(nsec: string): Promise<string> {
    return nsec;
}

export async function hexpub_to_npub(hexpub: string): Promise<string> {
    return hexpub;
}

export async function restore_mnemonic(
    mnemonic: string,
    ..._args: any[]
): Promise<void> {
    if (!validateMnemonic(mnemonic)) {
        throw new Error("Invalid mnemonic.");
    }
    await stop();
    indexedDB.deleteDatabase("mutiny-bark-wallet");
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
