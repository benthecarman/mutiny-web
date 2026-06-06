import { IDBFactory } from "fake-indexeddb";
import {
    finalizeEvent,
    generateSecretKey,
    getPublicKey,
    nip04,
    nip19
} from "nostr-tools";
import { beforeEach, describe, expect, test, vi } from "vitest";

const nostrMock = vi.hoisted(() => ({
    published: [] as { relays: string[]; event: Record<string, unknown> }[]
}));

vi.mock("nostr-tools", async (importOriginal) => {
    const actual = await importOriginal<typeof import("nostr-tools")>();
    return {
        ...actual,
        SimplePool: class {
            publish(relays: string[], event: Record<string, unknown>) {
                nostrMock.published.push({ relays, event });
                return [Promise.resolve("ok")];
            }

            close() {}
        }
    };
});

type Listener = (event?: unknown) => void;

class MockWebSocket {
    static handlers = new Map<string, unknown[]>();

    readyState = 0;
    listeners = new Map<string, Listener[]>();

    static CONNECTING = 0;
    static OPEN = 1;
    static CLOSED = 3;

    constructor(public _url: string) {
        queueMicrotask(() => this.open());
    }

    addEventListener(type: string, listener: Listener) {
        this.listeners.set(type, [
            ...(this.listeners.get(type) || []),
            listener
        ]);
    }

    removeEventListener(type: string, listener: Listener) {
        this.listeners.set(
            type,
            (this.listeners.get(type) || []).filter((item) => item !== listener)
        );
    }

    send(message: string) {
        const [, subId, request] = JSON.parse(message);
        const cache = request.cache[0] as string;
        const events = MockWebSocket.handlers.get(cache) || [];
        for (const event of events) {
            this.message(["EVENT", subId, event]);
        }
        this.message(["EOSE", subId]);
    }

    close() {
        this.readyState = MockWebSocket.CLOSED;
    }

    private open() {
        this.readyState = MockWebSocket.OPEN;
        this.emit("open");
    }

    private message(data: unknown) {
        this.emit("message", { data: JSON.stringify(data) });
    }

    private emit(type: string, event?: unknown) {
        for (const listener of this.listeners.get(type) || []) {
            listener(event);
        }
    }
}

function hex(bytes: Uint8Array): string {
    return Array.from(bytes)
        .map((byte) => byte.toString(16).padStart(2, "0"))
        .join("");
}

function nsec(secretKey: Uint8Array): string {
    return nip19.nsecEncode(secretKey);
}

beforeEach(() => {
    Object.defineProperty(globalThis, "indexedDB", {
        configurable: true,
        value: new IDBFactory()
    });
    vi.stubGlobal("WebSocket", MockWebSocket);
    MockWebSocket.handlers.clear();
    nostrMock.published = [];
});

describe("walletWorker social API", () => {
    test("imports, exports, and converts Nostr keys", async () => {
        const worker = await import("./walletWorker");
        const secretKey = generateSecretKey();
        const expectedNpub = nip19.npubEncode(getPublicKey(secretKey));

        await expect(worker.change_nostr_keys(nsec(secretKey))).resolves.toBe(
            expectedNpub
        );
        await expect(worker.get_npub()).resolves.toBe(expectedNpub);
        await expect(worker.export_nsec()).resolves.toBe(nsec(secretKey));
        await expect(worker.nsec_to_npub(nsec(secretKey))).resolves.toBe(
            expectedNpub
        );
        await expect(worker.npub_to_hexpub(expectedNpub)).resolves.toBe(
            getPublicKey(secretKey)
        );
        await expect(
            worker.hexpub_to_npub(getPublicKey(secretKey))
        ).resolves.toBe(expectedNpub);
    });

    test("creates, edits, sorts, finds, and deletes local contacts", async () => {
        const worker = await import("./walletWorker");
        const alice = nip19.npubEncode(getPublicKey(generateSecretKey()));
        const bob = nip19.npubEncode(getPublicKey(generateSecretKey()));

        const aliceId = await worker.create_new_contact(
            "Alice",
            alice,
            "alice@example.com"
        );
        const bobId = await worker.create_new_contact("Bob", bob);

        await expect(worker.get_contact_for_npub(alice)).resolves.toMatchObject(
            {
                id: aliceId,
                name: "Alice",
                npub: alice,
                ln_address: "alice@example.com"
            }
        );

        await worker.edit_contact(
            bobId,
            "Bobby",
            bob,
            "bob@example.com",
            undefined,
            "https://example.com/bob.png"
        );

        await expect(worker.get_tag_item(bobId)).resolves.toMatchObject({
            name: "Bobby",
            primal_image_url:
                "https://primal.b-cdn.net/media-cache?s=s&a=1&u=https%3A%2F%2Fexample.com%2Fbob.png"
        });

        expect(
            (await worker.get_contacts_sorted()).map((contact) => contact.name)
        ).toEqual(expect.arrayContaining(["Alice", "Bobby"]));

        await worker.delete_contact(aliceId);
        await expect(worker.get_tag_item(aliceId)).resolves.toBeUndefined();
    });

    test("publishes and stores profile changes", async () => {
        const worker = await import("./walletWorker");
        await worker.change_nostr_keys(nsec(generateSecretKey()));

        await expect(
            worker.setup_new_profile("Alice", "https://example.com/a.png")
        ).resolves.toMatchObject({
            name: "Alice",
            picture: "https://example.com/a.png"
        });
        await expect(worker.get_nostr_profile()).resolves.toMatchObject({
            name: "Alice"
        });

        await expect(
            worker.edit_nostr_profile(
                "Alice Edited",
                undefined,
                "alice@example.com",
                "alice@example.com"
            )
        ).resolves.toMatchObject({
            name: "Alice Edited",
            lud16: "alice@example.com",
            nip05: "alice@example.com"
        });

        await worker.delete_profile();
        await expect(worker.get_nostr_profile()).resolves.toMatchObject({
            deleted: true
        });

        const kinds = nostrMock.published.map(({ event }) => event.kind);
        expect(kinds).toEqual([0, 0, 0]);
    });

    test("follows contacts and publishes a kind 3 contact list", async () => {
        const worker = await import("./walletWorker");
        const selfSecret = generateSecretKey();
        const target = nip19.npubEncode(getPublicKey(generateSecretKey()));
        const targetId = await worker.create_new_contact("Target", target);

        await worker.change_nostr_keys(nsec(selfSecret));
        await worker.follow_npub(target);

        await expect(worker.get_tag_item(targetId)).resolves.toMatchObject({
            is_followed: true
        });

        const published = nostrMock.published.at(-1)?.event;
        expect(published).toMatchObject({ kind: 3 });
        expect(published?.tags).toEqual(
            expect.arrayContaining([
                ["p", getPublicKey(selfSecret)],
                ["p", await worker.npub_to_hexpub(target)]
            ])
        );
        expect(JSON.parse(String(published?.content))).toMatchObject({
            "wss://relay.primal.net": { read: true, write: true }
        });

        await worker.unfollow_npub(target);
        await expect(worker.get_tag_item(targetId)).resolves.toMatchObject({
            is_followed: false
        });
    });

    test("loads a profile from Primal when no local profile is cached", async () => {
        const worker = await import("./walletWorker");
        const secretKey = generateSecretKey();
        const pubkey = getPublicKey(secretKey);
        MockWebSocket.handlers.set("user_profile", [
            {
                id: "profile-id",
                pubkey,
                created_at: 1,
                kind: 0,
                tags: [],
                content: JSON.stringify({
                    name: "Primal Alice",
                    lud16: "alice@example.com"
                }),
                sig: "sig"
            }
        ]);

        await worker.change_nostr_keys(nsec(secretKey));

        await expect(worker.get_nostr_profile()).resolves.toMatchObject({
            name: "Primal Alice",
            lud16: "alice@example.com"
        });
    });

    test("hydrates followed contacts from Primal contact_list and user_infos", async () => {
        const worker = await import("./walletWorker");
        const selfSecret = generateSecretKey();
        const followedPubkey = getPublicKey(generateSecretKey());
        const followedNpub = nip19.npubEncode(followedPubkey);

        MockWebSocket.handlers.set("contact_list", [
            {
                id: "contacts",
                pubkey: getPublicKey(selfSecret),
                created_at: 2,
                kind: 3,
                tags: [["p", followedPubkey]],
                content: "",
                sig: "sig"
            },
            {
                id: "followed-profile",
                pubkey: followedPubkey,
                created_at: 3,
                kind: 0,
                tags: [],
                content: JSON.stringify({
                    display_name: "Followed",
                    lud16: "followed@example.com"
                }),
                sig: "sig"
            }
        ]);

        await worker.change_nostr_keys(nsec(selfSecret));

        await expect(worker.get_contacts_sorted()).resolves.toEqual([
            expect.objectContaining({
                name: "Followed",
                npub: followedNpub,
                ln_address: "followed@example.com",
                is_followed: true
            })
        ]);
    });

    test("loads and decrypts DM history from Primal", async () => {
        const worker = await import("./walletWorker");
        const selfSecret = generateSecretKey();
        const selfPubkey = getPublicKey(selfSecret);
        const peerSecret = generateSecretKey();
        const peerPubkey = getPublicKey(peerSecret);
        const content = await nip04.encrypt(
            hex(selfSecret),
            peerPubkey,
            "hello from me"
        );
        const dm = finalizeEvent(
            {
                kind: 4,
                content,
                tags: [["p", peerPubkey]],
                created_at: 10
            },
            selfSecret
        );

        MockWebSocket.handlers.set("get_directmsgs", [dm]);

        await worker.change_nostr_keys(nsec(selfSecret));

        await expect(
            worker.get_dm_conversation(nip19.npubEncode(peerPubkey), 20)
        ).resolves.toEqual([
            {
                from: nip19.npubEncode(selfPubkey),
                to: nip19.npubEncode(peerPubkey),
                message: "hello from me",
                date: 10
            }
        ]);
    });

    test("uploads profile pictures with NIP-98 authorization", async () => {
        const worker = await import("./walletWorker");
        await worker.change_nostr_keys(nsec(generateSecretKey()));

        const fetchMock = vi.fn(async (_url: string, init: RequestInit) => {
            expect(init.method).toBe("POST");
            expect(init.headers).toMatchObject({
                Authorization: expect.stringMatching(/^Nostr /)
            });
            expect(init.body).toBeInstanceOf(FormData);

            const token = String(
                (init.headers as Record<string, string>).Authorization
            ).replace("Nostr ", "");
            const event = JSON.parse(
                Buffer.from(token, "base64").toString("utf8")
            ) as { kind: number; tags: string[][] };
            expect(event.kind).toBe(27235);
            expect(event.tags).toEqual(
                expect.arrayContaining([
                    ["u", "https://nostr.build/api/v2/upload/profile"],
                    ["method", "POST"]
                ])
            );

            return new Response(
                JSON.stringify({
                    status: "success",
                    data: [{ url: "https://nostr.build/i/example.png" }]
                }),
                { status: 200 }
            );
        });
        vi.stubGlobal("fetch", fetchMock);

        await expect(
            worker.upload_profile_pic(btoa("image-bytes"))
        ).resolves.toBe("https://nostr.build/i/example.png");
    });
});
