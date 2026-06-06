import { webcrypto } from "node:crypto";
import { TextDecoder, TextEncoder } from "node:util";
import { indexedDB } from "fake-indexeddb";
import { afterEach, vi } from "vitest";

Object.defineProperty(globalThis, "indexedDB", {
    configurable: true,
    value: indexedDB
});

Object.defineProperty(globalThis, "crypto", {
    configurable: true,
    value: webcrypto
});

Object.defineProperty(globalThis, "TextEncoder", {
    configurable: true,
    value: TextEncoder
});

Object.defineProperty(globalThis, "TextDecoder", {
    configurable: true,
    value: TextDecoder
});

Object.defineProperty(globalThis, "atob", {
    configurable: true,
    value: (value: string) => Buffer.from(value, "base64").toString("binary")
});

Object.defineProperty(globalThis, "btoa", {
    configurable: true,
    value: (value: string) => Buffer.from(value, "binary").toString("base64")
});

afterEach(() => {
    vi.restoreAllMocks();
});
