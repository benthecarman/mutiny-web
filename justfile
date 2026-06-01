set dotenv-load := false

dev:
    pnpm run dev

pre:
    pnpm run pre-commit

native:
    pnpm install && pnpm build && npx cap sync

test:
    pnpm exec playwright test
    
test-ui:
    pnpm exec playwright test --ui

mainnet:
    cp .env.mainnet .env.local

signet:
    cp .env.signet .env.local
