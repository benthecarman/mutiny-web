import {
    BackLink,
    DefaultMain,
    ImportNsecForm,
    MutinyWalletGuard
} from "~/components";
import { useI18n } from "~/i18n/context";

export function ImportProfileSettings() {
    const i18n = useI18n();

    return (
        <MutinyWalletGuard>
            <DefaultMain>
                <BackLink title="Back" href="/settings/nostrkeys" />
                <div class="mx-auto flex max-w-[20rem] flex-1 flex-col items-center gap-4">
                    <div class="flex-1" />
                    <h1 class="text-3xl font-semibold">
                        {i18n.t("settings.nostr_keys.change_key")}
                    </h1>
                    <p class="text-center text-xl font-light text-neutral-200">
                        Import an nsec to replace your active Nostr key.
                        <br />
                    </p>
                    <div class="flex-1" />
                    <ImportNsecForm />
                    <div class="flex-1" />
                </div>
            </DefaultMain>
        </MutinyWalletGuard>
    );
}
