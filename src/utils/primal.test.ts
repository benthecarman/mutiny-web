import { beforeEach, describe, expect, test, vi } from "vitest";

import { DEFAULT_PRIMAL_URL, primalRequest } from "./primal";

type Listener = (event?: unknown) => void;

class MockWebSocket {
    static instances: MockWebSocket[] = [];

    readyState = 0;
    sent: string[] = [];
    listeners = new Map<string, Listener[]>();

    static CONNECTING = 0;
    static OPEN = 1;
    static CLOSED = 3;

    constructor(public url: string) {
        MockWebSocket.instances.push(this);
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
        this.sent.push(message);
    }

    close() {
        this.readyState = MockWebSocket.CLOSED;
    }

    open() {
        this.readyState = MockWebSocket.OPEN;
        this.emit("open");
    }

    message(data: unknown) {
        this.emit("message", { data: JSON.stringify(data) });
    }

    error() {
        this.emit("error");
    }

    private emit(type: string, event?: unknown) {
        for (const listener of this.listeners.get(type) || []) {
            listener(event);
        }
    }
}

describe("primalRequest", () => {
    beforeEach(() => {
        MockWebSocket.instances = [];
    });

    test("sends Primal cache REQ messages and resolves EVENT payloads on EOSE", async () => {
        vi.stubGlobal("WebSocket", MockWebSocket);

        const promise = primalRequest("wss://cache2.primal.net/v1", [
            "user_search",
            { query: "mutiny", limit: 1 }
        ]);

        const socket = MockWebSocket.instances[0];
        socket.open();

        const sent = JSON.parse(socket.sent[0]);
        const subId = sent[1];
        expect(sent).toEqual([
            "REQ",
            subId,
            { cache: ["user_search", { query: "mutiny", limit: 1 }] }
        ]);

        socket.message(["EVENT", "other", { ignored: true }]);
        socket.message(["EVENT", subId, { kind: 0, pubkey: "abc" }]);
        socket.message(["EOSE", subId]);

        await expect(promise).resolves.toEqual([{ kind: 0, pubkey: "abc" }]);
        expect(socket.readyState).toBe(MockWebSocket.CLOSED);
    });

    test("uses Primal's public cache URL by default", async () => {
        vi.stubGlobal("WebSocket", MockWebSocket);

        const promise = primalRequest(undefined, [
            "user_profile",
            { pubkey: "abc" }
        ]);
        const socket = MockWebSocket.instances[0];
        socket.open();
        socket.message(["EOSE", JSON.parse(socket.sent[0])[1]]);

        await expect(promise).resolves.toEqual([]);
        expect(socket.url).toBe(DEFAULT_PRIMAL_URL);
    });

    test("rejects when Primal closes the subscription with an error", async () => {
        vi.stubGlobal("WebSocket", MockWebSocket);

        const promise = primalRequest("wss://cache2.primal.net/v1", [
            "user_profile",
            { pubkey: "abc" }
        ]);
        const socket = MockWebSocket.instances[0];
        socket.open();
        socket.message([
            "CLOSED",
            JSON.parse(socket.sent[0])[1],
            "bad request"
        ]);

        await expect(promise).rejects.toThrow("bad request");
    });
});
