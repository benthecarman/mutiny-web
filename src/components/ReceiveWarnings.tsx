import { Match, Switch } from "solid-js";

import { InfoBox } from "~/components/InfoBox";
import { useI18n } from "~/i18n/context";
import { ReceiveFlavor } from "~/routes";

export function ReceiveWarnings(props: {
    amountSats: bigint;
    from_fedi_to_ln?: boolean;
    flavor?: ReceiveFlavor;
}) {
    const i18n = useI18n();

    const sillyAmountWarning = () => {
        const parsed = Number(props.amountSats);
        if (isNaN(parsed)) {
            return undefined;
        }

        if (parsed >= 2099999997690000) {
            // If over 21 million bitcoin, warn that too much
            return i18n.t("receive.amount_editable.more_than_21m");
        }
    };

    const tooSmallWarning = () => {
        if (
            props.flavor === "onchain" &&
            props.amountSats > 0n &&
            props.amountSats < 546n
        ) {
            return i18n.t("receive.error_under_min_onchain");
        }
    };

    return (
        <Switch>
            <Match when={tooSmallWarning()}>
                <InfoBox accent="red">{tooSmallWarning()}</InfoBox>
            </Match>
            <Match when={sillyAmountWarning()}>
                <InfoBox accent="red">{sillyAmountWarning()}</InfoBox>
            </Match>
        </Switch>
    );
}
