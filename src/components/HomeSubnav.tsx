import { Show, Suspense } from "solid-js";

import { CombinedActivity, VStack } from "~/components";
import { useMegaStore } from "~/state/megaStore";

export function HomeSubnav() {
    const [state] = useMegaStore();

    return (
        <>
            <VStack>
                <Suspense>
                    <Show when={!state.wallet_loading && !state.safe_mode}>
                        <CombinedActivity />
                    </Show>
                </Suspense>
            </VStack>
            {/* spacer just so we can always scroll above the fab */}
            <div class="h-[4rem]" />
        </>
    );
}
