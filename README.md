# Hedera → QuickBooks Online Sync

## 1. Short Description

This project synchronizes **Hedera HBAR transfers** from the Hedera
Mirror Node into **QuickBooks Online (QBO)** as Deposits and Transfers.

It: - Authenticates with Intuit OAuth2 - Auto-creates required QBO
accounts - Reads Hedera Mirror Node transactions - Writes matching
bookkeeping entries into QBO - Uses deterministic idempotency keys to
prevent duplicates

Safe to run repeatedly without double-posting transactions.

------------------------------------------------------------------------

## 2. Dependencies & Requirements

### Runtime

-   Node.js ≥ 18

### NPM Packages

-   express \^4.x\
-   intuit-oauth \^4.x\
-   node-fetch \^2.x\
-   dotenv \^16.x

### External Services

-   QuickBooks Online (Sandbox or Production)
-   Hedera Mirror Node (Testnet or Mainnet)

------------------------------------------------------------------------

## 3. Setup

### Install dependencies

``` bash
npm install
```

### Create `.env`

``` env
QBO_CLIENT_ID=YOUR_INTUIT_CLIENT_ID
QBO_CLIENT_SECRET=YOUR_INTUIT_CLIENT_SECRET
QBO_ENV=sandbox
QBO_REDIRECT_URI=http://localhost:3000/callback

HEDERA_ACCOUNT=0.0.6856591
HEDERA_TRACKED_ACCOUNTS=0.0.6856591,0.0.123,0.0.456

MIRROR_NETWORK=testnet
PORT=3000
```

### Start server

``` bash
node quickbook-sync.js
```

The console prints an **Authorize URL**.

------------------------------------------------------------------------

## 4. How to Run

1.  Open the **Authorize URL** in your browser\
2.  Log in to QuickBooks and approve access\
3.  After redirect, the callback page shows token details\
4.  Click `/syncHederaToQbo` to run the sync\
5.  Review the HTML sync report in your browser

You can re-run `/syncHederaToQbo` safely --- duplicates are skipped
automatically.

------------------------------------------------------------------------

## 5. API Paths

  -----------------------------------------------------------------------
  Path                         Purpose
  ---------------------------- ------------------------------------------
  `/`                          Home page. Shows authorization link and
                               route index.

  `/callback`                  OAuth redirect endpoint. Exchanges code
                               for QBO token and displays session info.

  `/debugRealm`                Displays active QuickBooks realmId bound
                               to the session.

  `/getCompanyInfo`            Fetches QBO company profile to confirm
                               connection.

  `/syncHederaToQbo`           Main sync. Reads Hedera transactions and
                               creates QBO Deposits / Transfers with
                               de-duplication.

  `/listAccounts`              Displays QuickBooks Chart of Accounts in a
                               readable table.

  `/listDeposits`              Displays recent QBO Deposit records.

  `/listTransfers`             Displays recent QBO Transfer records.
  -----------------------------------------------------------------------

------------------------------------------------------------------------

## Idempotency & De-duplication

Each Hedera transaction is tagged in QBO:

    hedera:<transaction_id>:<consensus_timestamp>

Stored in `PrivateNote`.

Before creating new records, the script checks existing QBO entries and
skips matches --- ensuring safe repeat runs.

------------------------------------------------------------------------

## Networks

  Setting            Values
  ------------------ ---------------------------
  `MIRROR_NETWORK`   `testnet` or `mainnet`
  `QBO_ENV`          `sandbox` or `production`

------------------------------------------------------------------------

## License

MIT
