export const DEFAULT_PRIMAL_URL = "wss://cache2.primal.net/v1";

type PrimalEnvelope =
    | ["EVENT", string, unknown]
    | ["EOSE", string]
    | ["NOTICE", string]
    | ["CLOSED", string, string];

export async function primalRequest<T = unknown>(
    url: string | undefined,
    body: [string, unknown],
    timeoutMs = 15_000
): Promise<T[]> {
    const primalUrl = url || DEFAULT_PRIMAL_URL;
    const subId = `mutiny-${Date.now()}-${Math.random().toString(36).slice(2)}`;

    return await new Promise<T[]>((resolve, reject) => {
        const socket = new WebSocket(primalUrl);
        const results: T[] = [];
        let settled = false;

        const cleanup = () => {
            clearTimeout(timeout);
            socket.removeEventListener("open", handleOpen);
            socket.removeEventListener("message", handleMessage);
            socket.removeEventListener("error", handleError);
            socket.removeEventListener("close", handleClose);
            if (
                socket.readyState === WebSocket.OPEN ||
                socket.readyState === WebSocket.CONNECTING
            ) {
                socket.close();
            }
        };

        const settle = (callback: () => void) => {
            if (settled) return;
            settled = true;
            cleanup();
            callback();
        };

        const timeout = setTimeout(() => {
            settle(() => reject(new Error("Primal request timed out.")));
        }, timeoutMs);

        const handleOpen = () => {
            socket.send(JSON.stringify(["REQ", subId, { cache: body }]));
        };

        const handleMessage = (event: MessageEvent) => {
            if (typeof event.data !== "string") return;

            let message: PrimalEnvelope;
            try {
                message = JSON.parse(event.data) as PrimalEnvelope;
            } catch {
                return;
            }

            const [type, messageSubId] = message;
            if (type === "NOTICE") return;
            if (messageSubId !== subId) return;

            if (type === "EVENT") {
                results.push(message[2] as T);
                return;
            }

            if (type === "EOSE") {
                settle(() => resolve(results));
                return;
            }

            if (type === "CLOSED") {
                settle(() => reject(new Error(message[2])));
            }
        };

        const handleError = () => {
            settle(() => reject(new Error("Primal WebSocket request failed.")));
        };

        const handleClose = () => {
            settle(() => resolve(results));
        };

        socket.addEventListener("open", handleOpen);
        socket.addEventListener("message", handleMessage);
        socket.addEventListener("error", handleError);
        socket.addEventListener("close", handleClose);
    });
}
