import { Capacitor } from "@capacitor/core";
import { SecureStoragePlugin } from "capacitor-secure-storage-plugin";

const NSEC_STORAGE_KEY = "nsec";

export async function getStoredNsec(): Promise<string | undefined> {
    if (Capacitor.isNativePlatform()) {
        try {
            const value = await SecureStoragePlugin.get({
                key: NSEC_STORAGE_KEY
            });
            return value.value || undefined;
        } catch {
            return undefined;
        }
    }

    return localStorage.getItem(NSEC_STORAGE_KEY) || undefined;
}

export async function setStoredNsec(nsec: string): Promise<void> {
    if (Capacitor.isNativePlatform()) {
        await SecureStoragePlugin.set({ key: NSEC_STORAGE_KEY, value: nsec });
        return;
    }

    localStorage.setItem(NSEC_STORAGE_KEY, nsec);
}

export async function clearStoredNsec(): Promise<void> {
    if (Capacitor.isNativePlatform()) {
        await SecureStoragePlugin.clear();
        return;
    }

    localStorage.removeItem(NSEC_STORAGE_KEY);
}
