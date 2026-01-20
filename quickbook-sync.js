/**
 * QuickBooks Online (Sandbox/Prod) + Hedera Mirror Node Sync (DE-DUPED)
 * --------------------------------------------------------------------
 * Single-file Express server:
 * - OAuth callback (Intuit)
 * - Get company info
 * - Create/Get QBO ledger accounts representing Hedera accounts ("wallet bank accounts")
 * - Fetch Hedera (testnet/mainnet) CRYPTOTRANSFER transactions for a Hedera account
 * - Create QBO Deposits (inbound) and Transfers (outbound / between tracked wallets)
 * - BEFORE creating, checks QBO for duplicates WITHOUT querying PrivateNote
 *     (because PrivateNote is not queryable for Transfer/Deposit in many QBO envs)
 *
 * De-dupe approach (robust):
 * - Store deterministic idempotency key in PrivateNote:
 *     key = "hedera:<transaction_id>:<consensus_timestamp>"
 * - To check duplicates:
 *     1) Query using queryable fields (TxnDate/Amount/AccountRefs)
 *     2) Read candidate entity by Id and verify entity.PrivateNote === key
 *
 * Ready to run:
 *   1) npm i express intuit-oauth node-fetch
 *   2) Set env vars:
 *        export QBO_CLIENT_ID="..."
 *        export QBO_CLIENT_SECRET="..."
 *        export QBO_ENV="sandbox"   # or "production"
 *        export QBO_REDIRECT_URI="http://localhost:3000/callback"
 *        export HEDERA_ACCOUNT="0.0.6856591"
 *        export HEDERA_TRACKED_ACCOUNTS="0.0.6856591,0.0.123,0.0.456"
 *        export MIRROR_NETWORK="testnet"  # testnet/mainnet
 *   3) node stablecoin.js
 *   4) Open authorize URL printed in console
 *   5) After callback, run:
 *        http://localhost:3000/syncHederaToQbo
 */
require("dotenv").config();
const OAuthClient = require("intuit-oauth");
const express = require("express");
const fetch = require("node-fetch");


const app = express();
const port = process.env.PORT || 3000;

// -------------------- ENV --------------------
const QBO_ENV = process.env.QBO_ENV || "sandbox";
const QBO_REDIRECT_URI = process.env.QBO_REDIRECT_URI || `http://localhost:${port}/callback`;
const QBO_CLIENT_ID = process.env.QBO_CLIENT_ID;
const QBO_CLIENT_SECRET = process.env.QBO_CLIENT_SECRET;

const TARGET_HEDERA_ACCOUNT = process.env.HEDERA_ACCOUNT || "0.0.6856591";
const TRACKED_HEDERA_ACCOUNTS = (process.env.HEDERA_TRACKED_ACCOUNTS || TARGET_HEDERA_ACCOUNT)
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

const MIRROR_NETWORK = process.env.MIRROR_NETWORK || "testnet";
const MIRROR_BASE =
    MIRROR_NETWORK === "mainnet"
        ? "https://mainnet.mirrornode.hedera.com/api/v1"
        : "https://testnet.mirrornode.hedera.com/api/v1";

// -------------------- OAUTH CLIENT --------------------
const oauthClient = new OAuthClient({
    clientId: QBO_CLIENT_ID,
    clientSecret: QBO_CLIENT_SECRET,
    environment: QBO_ENV,
    redirectUri: QBO_REDIRECT_URI,
    logging: true,
});

// Note: keep realmId only for debug; for API calls we rely on token.realmId
let realmId = null;

const QB_BASE_URL =
    oauthClient.environment === "sandbox"
        ? "https://sandbox-quickbooks.api.intuit.com/"
        : "https://quickbooks.api.intuit.com/";

// -------------------- DE-DUPE CACHE (optional) --------------------
const seenKeys = new Set();
function alreadyProcessedInMemory(key) {
    if (seenKeys.has(key)) return true;
    seenKeys.add(key);
    return false;
}

// -------------------- REALM HELPER (prevents mismatch issues) --------------------
function getCompanyRealmIdOrThrow() {
    const token = oauthClient.getToken();
    if (!token) throw new Error("Not authenticated (no token)");
    if (!token.realmId) throw new Error("Token missing realmId");

    // If you keep realmId from callback, ensure it matches token.realmId
    if (realmId && realmId !== token.realmId) {
        throw new Error(`Realm mismatch: realmId var=${realmId} vs token.realmId=${token.realmId}. Re-authorize.`);
    }

    return token.realmId; // ALWAYS use token realmId for API calls
}

// -------------------- ROUTES --------------------
app.get("/", (req, res) => {
    res.json({
        status: "ok",
        authorizeUrl: oauthClient.authorizeUri({
            scope: [OAuthClient.scopes.Accounting, OAuthClient.scopes.OpenId],
            state: "testState",
        }),
        endpoints: {
            callback: "/callback",
            getCompanyInfo: "/getCompanyInfo",
            syncHederaToQbo: "/syncHederaToQbo?account=0.0.6856591",
            listTransfers: "/listTransfers",
            listDeposits: "/listDeposits",
            listAccounts: "/listAccounts",
            debugRealm: "/debugRealm",
        },
        mirror: MIRROR_BASE,
        trackedHederaAccounts: TRACKED_HEDERA_ACCOUNTS,
    });
});

app.get("/callback", async (req, res) => {
    try {
        const newRealmId = req.query.realmId || null;

        // Clear in-memory cache when sandbox company/realm changes
        if (realmId && newRealmId && realmId !== newRealmId) {
            seenKeys.clear();
            console.log(`Realm changed ${realmId} -> ${newRealmId}. Cleared in-memory cache.`);
        }

        realmId = newRealmId;

        const authResponse = await oauthClient.createToken(req.url);
        const token = authResponse.getJson();

        console.log("Callback realmId:", realmId, "token.realmId:", oauthClient.getToken()?.realmId);

        // Build human-readable HTML
        const prettyToken = JSON.stringify(token, null, 2);

        const baseUrl = `${req.protocol}://${req.get("host")}`;

        res.send(`
            <html>
            <head>
                <title>QBO OAuth Success</title>
                <style>
                    body { font-family: Arial, sans-serif; margin: 40px; }
                    pre { background:#f6f6f6; padding:15px; border-radius:8px; }
                    a { display:block; margin:6px 0; }
                </style>
            </head>
            <body>
                <h2>✅ OAuth Token Received</h2>

                <h3>Realm Info</h3>
                <pre>realmId (callback): ${realmId}
token.realmId: ${oauthClient.getToken()?.realmId}</pre>

                <h3>Token JSON</h3>
                <pre>${prettyToken}</pre>

                <h3>Quick Links</h3>
                <a href="${baseUrl}/">Home (Authorize URL)</a>
                <a href="${baseUrl}/debugRealm">Debug Realm</a>
                <a href="${baseUrl}/getCompanyInfo">Get Company Info</a>
                <a href="${baseUrl}/listAccounts">List Accounts</a>
                <a href="${baseUrl}/listDeposits">List Deposits</a>
                <a href="${baseUrl}/listTransfers">List Transfers</a>
                <a href="${baseUrl}/syncHederaToQbo">Run Hedera → QBO Sync</a>

                <h3>Next Step</h3>
                <p>Click <a href="${baseUrl}/syncHederaToQbo">/syncHederaToQbo</a> to start syncing.</p>
            </body>
            </html>
        `);

    } catch (e) {
        console.error("Callback error:", e);
        res.status(500).json({
            error: e.error || "callback_failed",
            error_description: e.error_description || String(e),
            intuit_tid: e.intuit_tid,
        });
    }
});

app.get("/debugRealm", (req, res) => {
    const token = oauthClient.getToken();
    res.json({
        realmId_var: realmId,
        token_realmId: token?.realmId || null,
        has_token: !!token,
    });
});

app.get("/getCompanyInfo", async (req, res) => {
    try {
        const companyRealmId = getCompanyRealmIdOrThrow();
        const url = `${QB_BASE_URL}v3/company/${companyRealmId}/companyinfo/${companyRealmId}?minorversion=75`;
        const apiResponse = await oauthClient.makeApiCall({ url });
        const body = typeof apiResponse.body === "string" ? JSON.parse(apiResponse.body) : apiResponse.body;
        res.json(body);
    } catch (e) {
        console.error("CompanyInfo error:", e);
        res.status(500).json({ error: String(e) });
    }
});

// -------------------- QBO HELPERS --------------------
async function qboQuery(companyRealmId, query) {
    const url = `${QB_BASE_URL}v3/company/${companyRealmId}/query?query=${encodeURIComponent(query)}&minorversion=75`;
    const r = await oauthClient.makeApiCall({ url });
    return JSON.parse(r.body);
}

function qboEscape(str) {
    return String(str).replace(/\\/g, "\\\\").replace(/'/g, "\\'");
}

/**
 * De-dupe Transfer WITHOUT querying PrivateNote:
 * - Query by queryable fields
 * - Read candidates and verify PrivateNote === key
 */
async function qboExistsTransferByKey(companyRealmId, { txnDate, amount, fromAccountId, toAccountId, key }) {
    const amt = Number(amount.toFixed(2));
    const query = `
    select Id,PrivateNote from Transfer
    where TxnDate='${txnDate}'
    maxresults 200
  `.replace(/\s+/g, " ").trim();
    console.log("Transfer de-dupe query:", query);

    const data = await qboQuery(companyRealmId, query);
    const candidates = data?.QueryResponse?.Transfer || [];
    console.log("Candidates for Transfer de-dupe:", candidates.length);
    if (candidates.length === 0) return false;

    for (const c of candidates) {
        if (c.PrivateNote === key) return true;
    }
    return false;
}

/**
 * De-dupe Deposit WITHOUT querying PrivateNote:
 * - Query by queryable fields
 * - Read candidates and verify PrivateNote === key
 * - Optionally verify the DepositLineDetail account equals sourceAccountId
 */
async function qboExistsDepositByKey(companyRealmId, { txnDate, amount, depositToAccountId, sourceAccountId, key }) {
    const query = `
    select Id, PrivateNote from Deposit
    where TxnDate='${txnDate}'
    maxresults 200
  `.replace(/\s+/g, " ").trim();

    const data = await qboQuery(companyRealmId, query);
    const candidates = data?.QueryResponse?.Deposit || [];
    console.log("Candidates for Deposit de-dupe:", candidates.length);
    if (candidates.length === 0) return false;

    for (const c of candidates) {
        if (c.PrivateNote === key) return true;

    }
    return false;
}

async function getOrCreateQboAccount(companyRealmId, { name, accountType, accountSubType }) {
    const safeName = qboEscape(name);
    const findQuery = `select * from Account where Name='${safeName}' maxresults 1`;
    const foundData = await qboQuery(companyRealmId, findQuery);
    const found = foundData?.QueryResponse?.Account?.[0];
    console.log("Found Account", found)

    if (found?.Id) return found.Id;

    const url = `${QB_BASE_URL}v3/company/${companyRealmId}/account?minorversion=75`;
    const payload = {
        Name: name,
        AccountType: accountType,
        ...(accountSubType ? { AccountSubType: accountSubType } : {}),
    };
    console.log("Creating QBO Account with payload:", payload);

    const r = await oauthClient.makeApiCall({
        url,
        method: "POST",
        body: JSON.stringify(payload),
        headers: { "Content-Type": "application/json", Accept: "application/json" },
    });

    const body = JSON.parse(r.body);
    if (body?.Fault) throw new Error(JSON.stringify(body.Fault));
    return body.Account.Id;
}

function hederaWalletAccountName(hederaId) {
    return `Hedera ${hederaId}`;
}

async function getOrCreateWalletBankAccount(companyRealmId, hederaId) {
    return getOrCreateQboAccount(companyRealmId, {
        name: hederaWalletAccountName(hederaId),
        accountType: "Bank",
    });
}

async function getOrCreateClearingAccount(companyRealmId) {
    return getOrCreateQboAccount(companyRealmId, {
        name: "Hedera Clearing",
        accountType: "Income",
    });
}

async function getOrCreateExternalOutflowBank(companyRealmId) {
    return getOrCreateQboAccount(companyRealmId, {
        name: "External Hedera Outflow",
        accountType: "Bank",
    });
}

async function createQboDeposit(companyRealmId, depositToAccountId, sourceAccountId, amount, privateNoteKey, txnDate) {
    const url = `${QB_BASE_URL}v3/company/${companyRealmId}/deposit?minorversion=75`;
    const payload = {
        TxnDate: txnDate,
        DepositToAccountRef: { value: depositToAccountId },
        PrivateNote: privateNoteKey,
        Line: [
            {
                Amount: Number(amount.toFixed(2)),
                DetailType: "DepositLineDetail",
                DepositLineDetail: { AccountRef: { value: sourceAccountId } },
            },
        ],
    };

    const r = await oauthClient.makeApiCall({
        url,
        method: "POST",
        body: JSON.stringify(payload),
        headers: { "Content-Type": "application/json", Accept: "application/json" },
    });

    const body = JSON.parse(r.body);
    if (body?.Fault) throw new Error(JSON.stringify(body.Fault));
    return body;
}

async function createQboTransfer(companyRealmId, fromAccountId, toAccountId, amount, privateNoteKey, txnDate) {
    const url = `${QB_BASE_URL}v3/company/${companyRealmId}/transfer?minorversion=75`;
    const payload = {
        TxnDate: txnDate,
        FromAccountRef: { value: fromAccountId },
        ToAccountRef: { value: toAccountId },
        Amount: Number(amount.toFixed(2)),
        PrivateNote: privateNoteKey,
    };

    const r = await oauthClient.makeApiCall({
        url,
        method: "POST",
        body: JSON.stringify(payload),
        headers: { "Content-Type": "application/json", Accept: "application/json" },
    });

    const body = JSON.parse(r.body);
    if (body?.Fault) throw new Error(JSON.stringify(body.Fault));
    return body;
}

// -------------------- HEDERA HELPERS --------------------
async function fetchMirrorTransactionsForAccount(hederaId, limit = 25) {
    const url = `${MIRROR_BASE}/transactions?account.id=${encodeURIComponent(hederaId)}&limit=${limit}`;
    const r = await fetch(url, { headers: { Accept: "application/json" } });
    if (!r.ok) throw new Error(`Mirror node HTTP ${r.status}`);
    return r.json();
}


function netTinybarFor(tx, hederaId) {
    const transfers = tx.transfers || [];
    return transfers
        .filter((t) => t.account === hederaId)
        .reduce((sum, t) => sum + Number(t.amount || 0), 0);
}

function otherAccountsInTransfer(tx, targetId) {
    return (tx.transfers || [])
        .map((t) => ({ account: t.account, amount: Number(t.amount || 0) }))
        .filter((t) => t.account && t.account !== targetId);
}

// Use consensus timestamp date (UTC) for tighter de-dupe queries
function toTxnDateFromConsensus(consensusTs) {
    // consensusTs looks like "1737328182.123456789"
    if (!consensusTs) return new Date().toISOString().slice(0, 10);
    const secs = Number(String(consensusTs).split(".")[0]);
    if (!Number.isFinite(secs)) return new Date().toISOString().slice(0, 10);
    return new Date(secs * 1000).toISOString().slice(0, 10);
}

function makeIdempotencyKey(tx) {
    return `hedera:${tx.transaction_id || ""}:${tx.consensus_timestamp || ""}`;
}

app.get("/syncHederaToQbo", async (req, res) => {
    try {
        const companyRealmId = getCompanyRealmIdOrThrow();
        const target = (req.query.account || TARGET_HEDERA_ACCOUNT).trim();

        const targetWalletId = await getOrCreateWalletBankAccount(companyRealmId, target);
        const clearingId = await getOrCreateClearingAccount(companyRealmId);
        const externalOutflowId = await getOrCreateExternalOutflowBank(companyRealmId);

        const data = await fetchMirrorTransactionsForAccount(target, 25);
        const txs = data.transactions;

        const results = [];

        for (const tx of txs) {
            const net = netTinybarFor(tx, target);
            if (net === 0) continue;

            const hbar = Math.abs(net) / 100_000_000;
            const txnDate = toTxnDateFromConsensus(tx.consensus_timestamp);
            const key = makeIdempotencyKey(tx);

            if (alreadyProcessedInMemory(key)) {
                results.push({ kind: "SKIPPED_MEMORY", key });
                continue;
            }

            if (net > 0) {
                const exists = await qboExistsDepositByKey(companyRealmId, {
                    txnDate,
                    amount: hbar,
                    depositToAccountId: targetWalletId,
                    sourceAccountId: clearingId,
                    key,
                });

                if (exists) {
                    results.push({ kind: "SKIPPED_QBO", type: "Deposit", key });
                    continue;
                }

                await createQboDeposit(companyRealmId, targetWalletId, clearingId, hbar, key, txnDate);
                results.push({ kind: "CREATED", type: "Deposit", to: target, hbar, txnDate, key });

            } else {
                const others = otherAccountsInTransfer(tx, target).map(x => x.account);
                const toTracked = others.find(a => TRACKED_HEDERA_ACCOUNTS.includes(a));

                let toAccountId = externalOutflowId;
                if (toTracked) {
                    toAccountId = await getOrCreateWalletBankAccount(companyRealmId, toTracked);
                }

                const exists = await qboExistsTransferByKey(companyRealmId, {
                    txnDate,
                    amount: hbar,
                    fromAccountId: targetWalletId,
                    toAccountId,
                    key,
                });

                if (exists) {
                    results.push({ kind: "SKIPPED_QBO", type: "Transfer", key });
                    continue;
                }

                await createQboTransfer(companyRealmId, targetWalletId, toAccountId, hbar, key, txnDate);

                results.push({
                    kind: "CREATED",
                    type: "Transfer",
                    from: target,
                    to: toTracked || "External Wallet",
                    hbar,
                    txnDate,
                    key
                });
            }
        }

        // ---- Build HTML Report ----
        const rows = results.map(r => {
            if (r.kind.startsWith("SKIPPED")) {
                return `
                    <tr style="color:#999">
                        <td>Skipped</td>
                        <td>${r.type || "-"}</td>
                        <td>-</td>
                        <td>-</td>
                        <td>${r.key}</td>
                    </tr>`;
            }

            return `
                <tr>
                    <td>Created</td>
                    <td>${r.type}</td>
                    <td>${r.from || "-"}</td>
                    <td>${r.to || r.target || "-"}</td>
                    <td>${r.hbar} HBAR</td>
                    <td>${r.txnDate}</td>
                    <td>${r.key}</td>
                </tr>`;
        }).join("");

        const html = `
        <html>
        <head>
            <title>Hedera → QBO Sync Report</title>
            <style>
                body { font-family: Arial; margin:30px; }
                table { border-collapse: collapse; width:100%; }
                th, td { border:1px solid #ddd; padding:8px; }
                th { background:#f2f2f2; }
            </style>
        </head>
        <body>
            <h2>✅ Hedera → QuickBooks Sync Report</h2>

            <p><b>Target Hedera Account:</b> ${target}</p>
            <p><b>Mirror Node:</b> ${MIRROR_BASE}</p>

            <p>
              <b>Created:</b> ${results.filter(r => r.kind === "CREATED").length} <br>
              <b>Skipped:</b> ${results.filter(r => r.kind.startsWith("SKIPPED")).length}
            </p>

            <table>
                <tr>
                    <th>Status</th>
                    <th>Type</th>
                    <th>From</th>
                    <th>To</th>
                    <th>Amount</th>
                    <th>Date</th>
                    <th>Idempotency Key</th>
                </tr>
                ${rows}
            </table>

            <br>
            <a href="/">⬅ Back Home</a>
        </body>
        </html>`;

        res.send(html);

    } catch (e) {
        console.error("syncHederaToQbo error:", e?.response?.body || e);
        res.status(500).send(`<pre>${String(e)}</pre>`);
    }
});


// -------------------- HUMAN-READABLE LIST ROUTES --------------------

function htmlPage(title, body) {
    return `
    <html>
    <head>
        <title>${title}</title>
        <style>
            body { font-family: Arial, sans-serif; margin: 30px; }
            table { border-collapse: collapse; width: 100%; }
            th, td { border: 1px solid #ddd; padding: 8px; text-align:left; }
            th { background: #f0f0f0; }
            tr:nth-child(even){background:#fafafa;}
            a { color: #0366d6; text-decoration:none; }
        </style>
    </head>
    <body>
        ${body}
    </body>
    </html>`;
}

// ---- List Accounts ----
app.get("/listAccounts", async (req, res) => {
    try {
        const companyRealmId = getCompanyRealmIdOrThrow();
        const data = await qboQuery(
            companyRealmId,
            "select * from Account order by MetaData.CreateTime desc maxresults 200"
        );

        const accounts = data?.QueryResponse?.Account || [];

        const rows = accounts.map(a => `
            <tr>
                <td>${a.Name}</td>
                <td>${a.AccountType}</td>
                <td>${a.AccountSubType || "-"}</td>
                <td>${a.Id}</td>
                <td>${a.MetaData?.CreateTime || "-"}</td>
            </tr>
        `).join("");

        res.send(htmlPage("QBO Accounts", `
            <h2>📘 Chart of Accounts</h2>
            <table>
                <tr>
                    <th>Name</th>
                    <th>Type</th>
                    <th>SubType</th>
                    <th>Id</th>
                    <th>Created</th>
                </tr>
                ${rows}
            </table>
            <br>
            <a href="/">⬅ Back Home</a>
        `));

    } catch (e) {
        res.status(500).send(htmlPage("Error", `<pre>${String(e)}</pre>`));
    }
});


// ---- List Transfers ----
app.get("/listTransfers", async (req, res) => {
    try {
        const companyRealmId = getCompanyRealmIdOrThrow();
        const data = await qboQuery(
            companyRealmId,
            "select * from Transfer order by MetaData.CreateTime desc maxresults 50"
        );

        const transfers = data?.QueryResponse?.Transfer || [];

        const rows = transfers.map(t => `
            <tr>
                <td>${t.TxnDate}</td>
                <td>${t.Amount}</td>
                <td>${t.FromAccountRef?.name || t.FromAccountRef?.value}</td>
                <td>${t.ToAccountRef?.name || t.ToAccountRef?.value}</td>
                <td>${t.PrivateNote || "-"}</td>
            </tr>
        `).join("");

        res.send(htmlPage("QBO Transfers", `
            <h2>💸 Transfers</h2>
            <table>
                <tr>
                    <th>Date</th>
                    <th>Amount</th>
                    <th>From</th>
                    <th>To</th>
                    <th>Private Note (Idempotency Key)</th>
                </tr>
                ${rows}
            </table>
            <br>
            <a href="/">⬅ Back Home</a>
        `));

    } catch (e) {
        res.status(500).send(htmlPage("Error", `<pre>${String(e)}</pre>`));
    }
});


// ---- List Deposits ----
app.get("/listDeposits", async (req, res) => {
    try {
        const companyRealmId = getCompanyRealmIdOrThrow();
        const data = await qboQuery(
            companyRealmId,
            "select * from Deposit order by MetaData.CreateTime desc maxresults 50"
        );

        const deposits = data?.QueryResponse?.Deposit || [];

        const rows = deposits.map(d => `
            <tr>
                <td>${d.TxnDate}</td>
                <td>${d.Line?.[0]?.Amount || "-"}</td>
                <td>${d.DepositToAccountRef?.name || d.DepositToAccountRef?.value}</td>
                <td>${d.Line?.[0]?.DepositLineDetail?.AccountRef?.name || "-"}</td>
                <td>${d.PrivateNote || "-"}</td>
            </tr>
        `).join("");

        res.send(htmlPage("QBO Deposits", `
            <h2>🏦 Deposits</h2>
            <table>
                <tr>
                    <th>Date</th>
                    <th>Amount</th>
                    <th>Deposit To</th>
                    <th>Source Account</th>
                    <th>Private Note (Idempotency Key)</th>
                </tr>
                ${rows}
            </table>
            <br>
            <a href="/">⬅ Back Home</a>
        `));

    } catch (e) {
        res.status(500).send(htmlPage("Error", `<pre>${String(e)}</pre>`));
    }
});


// -------------------- START --------------------
app.listen(port, () => {
    const authUri = oauthClient.authorizeUri({
        scope: [OAuthClient.scopes.Accounting, OAuthClient.scopes.OpenId],
        state: "testState",
    });

    console.log("Authorize URL:\n", authUri);
    console.log(`Server running on http://localhost:${port}`);
    console.log(`Mirror base: ${MIRROR_BASE}`);
    console.log(`Default Hedera account: ${TARGET_HEDERA_ACCOUNT}`);
    console.log(`Tracked Hedera accounts: ${TRACKED_HEDERA_ACCOUNTS.join(", ")}`);
});
