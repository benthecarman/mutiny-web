/* eslint-disable @typescript-eslint/no-explicit-any */

export enum BudgetPeriod {
    Day,
    Week,
    Month,
    Year
}

export enum TagKind {
    Contact = "contact",
    Label = "label"
}

export type MutinyBalance = {
    federation: bigint;
    lightning: bigint;
    confirmed: bigint;
    unconfirmed: bigint;
    force_close: bigint;
};

export type MutinyInvoice = {
    amount_sats: bigint;
    bolt11: string;
    description?: string;
    expire: number;
    expired: boolean;
    fees_paid?: bigint;
    inbound?: boolean;
    labels: string[];
    last_updated?: number;
    paid?: boolean;
    payee_pubkey?: string;
    payment_hash?: string;
    potential_hodl_invoice: boolean;
    preimage?: string;
    privacy_level?: string;
    status?: string;
};

export type MutinyBip21RawMaterials = {
    address: string;
    bip21: string;
    invoice?: string;
};

export type LnUrlParams = {
    tag?: string;
    callback?: string;
    min: bigint;
    max: bigint;
    min_sendable?: number;
    max_sendable?: number;
    min_withdrawable?: number;
    max_withdrawable?: number;
    default_description?: string;
    domain?: string;
    metadata?: string;
    comment_allowed?: number;
    allows_nostr?: boolean;
    nostr_pubkey?: string;
};

export type PaymentParams = {
    address?: string;
    amount_msats?: bigint;
    amount_sats?: bigint;
    ark_address?: string;
    cashu_token?: string;
    disable_output_substitution?: boolean;
    fedimint_invite_code?: string;
    fedimint_oob_notes?: string;
    invoice?: string;
    is_lnurl_auth?: boolean;
    lightning_address?: string;
    lnurl?: string;
    memo?: string;
    network?: string;
    node_pubkey?: string;
    nostr_pubkey?: string;
    nostr_wallet_auth?: string;
    offer?: string;
    payjoin_endpoint?: string;
    payjoin_supported?: boolean;
    refund?: string;
    string: string;
};

export type ActivityItem = {
    id?: string | number;
    status?: string;
    labels: string[];
    type?: string;
    amount_sats?: number;
    fee?: bigint;
    inbound?: boolean;
    timestamp?: number;
    last_updated?: number;
    labels_str?: string;
    [key: string]: any;
};

export type ChannelClosure = {
    channel_id: string;
    node_id: string;
    reason: string;
    timestamp: number;
};

export type FederationBalance = {
    balance: bigint;
    identity_federation_id: string;
    identity_uuid: string;
};

export type FederationBalances = {
    balances: FederationBalance[];
};

export type FedimintSweepResult = {
    amount?: bigint;
    fees?: bigint;
    fees_paid?: bigint;
    invoice?: MutinyInvoice;
    preimage?: string;
};

export type MutinyChannel = {
    channel_id?: string;
    counterparty_node_id: string;
    funding_txo: string;
    balance: bigint;
    reserve: bigint;
    inbound_capacity_sats: bigint;
    outbound_capacity_sats: bigint;
    channel_value_sats?: bigint;
    is_channel_ready?: boolean;
    is_usable?: boolean;
    confirmations?: number;
    [key: string]: any;
};

export type MutinyPeer = {
    pubkey: string;
    connection_string?: string;
    alias?: string;
    connected?: boolean;
    [key: string]: any;
};

export type NwcProfile = {
    index: number;
    name: string;
    uri: string;
    enabled?: boolean;
    budget_sats?: bigint;
    budget_period?: BudgetPeriod;
    commands?: string[];
    [key: string]: any;
};

export type PendingNwcInvoice = {
    amount_sats: bigint;
    expiry: bigint;
    id: string;
    index: number;
    invoice: string;
    invoice_description?: string;
    npub?: string;
    profile_name?: string;
};

export type TagItem = {
    id: string;
    name: string;
    label?: string;
    npub?: string;
    ln_address?: string;
    lnurl?: string;
    image_url?: string;
    kind?: TagKind | string;
    [key: string]: any;
};
