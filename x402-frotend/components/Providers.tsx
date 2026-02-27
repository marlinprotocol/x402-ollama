'use client';

import * as React from 'react';
import {
    RainbowKitProvider,
    getDefaultConfig,
    darkTheme,
} from '@rainbow-me/rainbowkit';
import { WagmiProvider } from 'wagmi';
import {
    mainnet,
    polygon,
    optimism,
    arbitrum,
    base,
    baseSepolia,
    sepolia,
} from 'wagmi/chains';
import {
    QueryClientProvider,
    QueryClient,
} from "@tanstack/react-query";
import '@rainbow-me/rainbowkit/styles.css';

const config = getDefaultConfig({
    appName: 'X402 App',
    projectId: 'YOUR_PROJECT_ID', // Get your project ID from https://cloud.walletconnect.com
    chains: [mainnet, polygon, optimism, arbitrum, base, baseSepolia, sepolia],
    ssr: true,
});

const queryClient = new QueryClient();

const appTheme = darkTheme({
    accentColor: '#3db48a',
    accentColorForeground: '#04120d',
    borderRadius: 'medium',
    fontStack: 'system',
    overlayBlur: 'small',
});

// Override specific tokens to match the dark-green palette
appTheme.colors.connectButtonBackground = '#15382f';
appTheme.colors.connectButtonInnerBackground = '#0f1d1a';
appTheme.colors.connectButtonText = '#edf4f1';
appTheme.colors.modalBackground = '#0f1d1a';
appTheme.colors.modalBorder = '#2f4a42';
appTheme.colors.modalText = '#edf4f1';
appTheme.colors.modalTextSecondary = '#91b5a9';
appTheme.colors.actionButtonBorder = '#2f4a42';
appTheme.colors.actionButtonSecondaryBackground = '#15382f';
appTheme.colors.profileAction = '#15382f';
appTheme.colors.profileActionHover = '#1b4a3d';
appTheme.colors.generalBorder = '#2f4a42';
appTheme.colors.menuItemBackground = '#15382f';
appTheme.shadows.connectButton = '0 4px 12px rgba(0,0,0,0.3)';

export function Providers({ children }: { children: React.ReactNode }) {
    return (
        <WagmiProvider config={config}>
            <QueryClientProvider client={queryClient}>
                <RainbowKitProvider theme={appTheme}>
                    {children}
                </RainbowKitProvider>
            </QueryClientProvider>
        </WagmiProvider>
    );
}
