import { beforeEach, describe, expect, test, vi } from "vitest";

import {
    actuallyFetchNostrProfile,
    profileToPseudoContact,
    searchProfiles
} from "./fetchZaps";

vi.mock("~/state/megaStore", () => ({
    useMegaStore: () => []
}));

type Listener = (event?: unknown) => void;

class MockWebSocket {
    static handlers = new Map<string, unknown[]>();

    readyState = 0;
    listeners = new Map<string, Listener[]>();

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
        for (const event of MockWebSocket.handlers.get(cache) || []) {
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

describe("Primal-backed profile search helpers", () => {
    beforeEach(() => {
        vi.stubGlobal("WebSocket", MockWebSocket);
        vi.spyOn(console, "log").mockImplementation(() => {});
        MockWebSocket.handlers.clear();
    });

    test("loads a single profile from Primal", async () => {
        MockWebSocket.handlers.set("user_profile", [
            {
                id: "profile",
                pubkey: "abc",
                created_at: 1,
                kind: 0,
                tags: [],
                content: JSON.stringify({ name: "Alice" }),
                sig: "sig"
            }
        ]);

        await expect(actuallyFetchNostrProfile("abc")).resolves.toMatchObject({
            kind: 0,
            pubkey: "abc"
        });
    });

    test("searches profiles and converts them to pseudo contacts", async () => {
        MockWebSocket.handlers.set("user_search", [
            {
                id: "profile",
                pubkey: "abc",
                created_at: 1,
                kind: 0,
                tags: [],
                content: JSON.stringify({
                    display_name: "Alice",
                    lud16: "alice@example.com",
                    picture: "https://example.com/a.png"
                }),
                sig: "sig"
            }
        ]);

        await expect(searchProfiles("alice")).resolves.toEqual([
            {
                name: "Alice",
                hexpub: "abc",
                ln_address: "alice@example.com",
                lnurl: undefined,
                image_url: "https://example.com/a.png",
                primal_image_url:
                    "https://primal.b-cdn.net/media-cache?s=s&a=1&u=https%3A%2F%2Fexample.com%2Fa.png"
            }
        ]);
    });

    test("maps Primal profile metadata into a pseudo contact", () => {
        expect(
            profileToPseudoContact({
                id: "profile",
                pubkey: "abc",
                created_at: 1,
                kind: 0,
                tags: [],
                content: JSON.stringify({
                    name: "Alice",
                    lud06: "lnurl",
                    image: "https://example.com/a.png"
                }),
                sig: "sig"
            })
        ).toMatchObject({
            name: "Alice",
            hexpub: "abc",
            lnurl: "lnurl",
            image_url: "https://example.com/a.png"
        });
    });
});
