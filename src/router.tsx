import { App as CapacitorApp } from "@capacitor/app";
import { Capacitor } from "@capacitor/core";
import { StatusBar, Style } from "@capacitor/status-bar";
import { MetaProvider, Title } from "@solidjs/meta";
import { Route, Router as SolidRouter, useNavigate } from "@solidjs/router";
import {
    ErrorBoundary,
    JSX,
    Match,
    onCleanup,
    onMount,
    Suspense,
    Switch
} from "solid-js";

import {
    ErrorDisplay,
    I18nProvider,
    SetupErrorDisplay,
    Toaster
} from "~/components";
import { Feedback, Main, NotFound, Receive, Scanner, Send } from "~/routes";
import {
    Backup,
    Currency,
    Language,
    Restore,
    Servers,
    Settings
} from "~/routes/settings";
import { Setup, SetupRestore } from "~/routes/setup";
import { Provider as MegaStoreProvider, useMegaStore } from "~/state/megaStore";

const setStatusBarStyleDark = async () => {
    await StatusBar.setStyle({ style: Style.Dark });
};

if (Capacitor.isNativePlatform()) {
    await setStatusBarStyleDark();
}

function ChildrenOrError(props: { children: JSX.Element }) {
    const [state] = useMegaStore();

    // listeners for native navigation handling
    // Check if the platform is Android to handle back
    onMount(async () => {
        if (Capacitor.getPlatform() === "android") {
            const { remove } = await CapacitorApp.addListener(
                "backButton",
                ({ canGoBack }) => {
                    if (!canGoBack) {
                        CapacitorApp.exitApp();
                    } else {
                        window.history.back();
                    }
                }
            );

            // Ensure the listener is cleaned up when the component is destroyed
            onCleanup(() => {
                console.debug("cleaning up backButton listener");
                remove();
            });
        }

        // Handle app links on native platforms
        if (Capacitor.isNativePlatform()) {
            const navigate = useNavigate();
            const { remove } = await CapacitorApp.addListener(
                "appUrlOpen",
                (data) => {
                    const url = new URL(data.url);
                    const path = url.pathname;
                    const urlParams = new URLSearchParams(url.search);

                    if (urlParams.size) {
                        console.log(
                            `Navigating to ${path}?${urlParams.toString()}`
                        );
                        navigate(`${path}?${urlParams.toString()}`);
                    } else {
                        console.log(`Navigating to ${path}`);
                        navigate(path);
                    }
                }
            );

            onCleanup(() => {
                console.debug("cleaning up appUrlOpen listener");
                remove();
            });
        }
    });

    return (
        <Switch>
            <Match when={state.setup_error}>
                <SetupErrorDisplay
                    initialError={state.setup_error!}
                    password={state.password}
                />
            </Match>
            <Match when={true}>{props.children}</Match>
        </Switch>
    );
}

export function Router() {
    return (
        <SolidRouter
            root={(props) => (
                <MetaProvider>
                    <Title>Mutiny Wallet</Title>
                    <ErrorBoundary fallback={(e) => <ErrorDisplay error={e} />}>
                        <Suspense>
                            <ErrorBoundary
                                fallback={(e) => <ErrorDisplay error={e} />}
                            >
                                <MegaStoreProvider>
                                    <I18nProvider>
                                        <ErrorBoundary
                                            fallback={(e) => (
                                                <ErrorDisplay error={e} />
                                            )}
                                        >
                                            <ChildrenOrError>
                                                {props.children}
                                            </ChildrenOrError>
                                            <Toaster />
                                        </ErrorBoundary>
                                    </I18nProvider>
                                </MegaStoreProvider>
                            </ErrorBoundary>
                        </Suspense>
                    </ErrorBoundary>
                </MetaProvider>
            )}
        >
            <Route path="/" component={Main} />
            <Route path="/setup" component={Setup} />
            <Route path="/setup/restore" component={SetupRestore} />
            <Route path="/feedback" component={Feedback} />
            <Route path="/receive" component={Receive} />
            <Route path="/scanner" component={Scanner} />
            <Route path="/send" component={Send} />
            <Route path="/settings">
                <Route path="/" component={Settings} />
                <Route path="/backup" component={Backup} />
                <Route path="/currency" component={Currency} />
                <Route path="/language" component={Language} />
                <Route path="/restore" component={Restore} />
                <Route path="/servers" component={Servers} />
            </Route>
            <Route path="/*all" component={NotFound} />
        </SolidRouter>
    );
}
