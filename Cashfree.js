// ============================================================================
//  PulsePoint x Cashfree (Easy Split / marketplace payments)
//
//  Flow
//   1. Organizer submits payout details ONCE  -> POST /api/org/payout-setup
//      Server creates the Cashfree vendor, generates + stores the Vendor ID.
//   2. Player presses "Register & Pay"        -> POST /api/payments/create-order
//      Server creates a Cashfree order with order_splits routed to the
//      organizer's vendor (looked up from the tournament, never from the browser).
//   3. Cashfree calls                         -> POST /webhooks/cashfree
//      Signature is verified; ONLY here is a payment marked paid and the
//      registration created.
//   4. Organizer dashboard reads              -> GET /api/org/payments
// ============================================================================
"use strict";
var crypto = require("crypto");

module.exports = function mountCashfree(app, pool, helpers) {
    var db = pool.promise();
    var dbFail = helpers.dbFail;

    // ------------------------------------------------------------ config
    var MODE = String(process.env.CASHFREE_ENV || "sandbox").toLowerCase() === "production" ? "production" : "sandbox";
    var BASE = MODE === "production" ? "https://api.cashfree.com/pg" : "https://sandbox.cashfree.com/pg";
    var API_VERSION = process.env.CASHFREE_API_VERSION || "2023-08-01";
    var CLIENT_ID = process.env.CASHFREE_CLIENT_ID || "";
    var CLIENT_SECRET = process.env.CASHFREE_CLIENT_SECRET || "";
    var PUBLIC_URL = String(process.env.PUBLIC_BASE_URL || "http://localhost:" + (process.env.PORT || 2400)).replace(/\/$/, "");
    var PLATFORM_FEE_PCT = Math.max(0, Math.min(50, Number(process.env.PLATFORM_FEE_PERCENT || 0)));
    // Sandbox cannot penny-drop real/random bank accounts, so bank verification is only forced in production.
    // Override with CASHFREE_VERIFY_ACCOUNT=true|false if needed.
    var VERIFY_ACCOUNT = process.env.CASHFREE_VERIFY_ACCOUNT ? /^(true|1|yes)$/i.test(process.env.CASHFREE_VERIFY_ACCOUNT) : MODE === "production";
    var BUSINESS_TYPE = process.env.CASHFREE_BUSINESS_TYPE || "";   // optional override; must be one of the types Cashfree accepts   // must be a value Cashfree accepts - verify in sandbox

    if (!CLIENT_ID || !CLIENT_SECRET)
        console.log("Cashfree: CASHFREE_CLIENT_ID / CASHFREE_CLIENT_SECRET not set - online payments are disabled.");
    else console.log("Cashfree: " + MODE + " mode enabled.");

    function configured() { return !!(CLIENT_ID && CLIENT_SECRET); }

    async function cf(method, path, body) {
        var r = await fetch(BASE + path, {
            method: method,
            headers: {
                "Content-Type": "application/json", "Accept": "application/json",
                "x-api-version": API_VERSION, "x-client-id": CLIENT_ID, "x-client-secret": CLIENT_SECRET
            },
            body: body ? JSON.stringify(body) : undefined
        });
        var json = null;
        try { json = await r.json(); } catch (e) { }
        return { ok: r.ok, status: r.status, json: json || {} };
    }

    function md5(s) { return crypto.createHash("md5").update(String(s).toLowerCase()).digest("hex"); }
    function send(resp, code, status, message, extra) {
        return resp.status(code).json(Object.assign({ status: status, message: message }, extra || {}));
    }

    // ------------------------------------------------------------ schema
    function ensureSchema(done) {
        var h = helpers;
        h.ensureColumn("regorg", "cf_vendor_id", "VARCHAR(60) NULL", function (e1) {
            if (e1) return done(e1);
            h.ensureColumn("regorg", "cf_vendor_status", "VARCHAR(30) NULL", function (e2) {
                if (e2) return done(e2);
                h.ensureColumn("regorg", "cf_onboarded_at", "DATETIME NULL", function (e3) {
                    if (e3) return done(e3);
                    h.ensureColumn("registrations", "order_id", "VARCHAR(50) NULL", function (e4) {
                        if (e4) return done(e4);
                        pool.query(
                            "CREATE TABLE IF NOT EXISTS payment_orders(" +
                            "order_id VARCHAR(50) PRIMARY KEY, rid INT NOT NULL, player_email VARCHAR(30) NOT NULL, " +
                            "org_email VARCHAR(30) NOT NULL, vendor_id VARCHAR(60) NOT NULL, amount DECIMAL(10,2) NOT NULL, " +
                            "vendor_amount DECIMAL(10,2) NOT NULL, status VARCHAR(20) NOT NULL DEFAULT 'CREATED', " +
                            "cf_payment_id VARCHAR(30) NULL, payment_method VARCHAR(30) NULL, " +
                            "created_at DATETIME DEFAULT CURRENT_TIMESTAMP, paid_at DATETIME NULL, " +
                            "KEY ix_po_rid (rid), KEY ix_po_org (org_email), KEY ix_po_player (player_email))", done);
                    });
                });
            });
        });
    }

    // ------------------------------------------------------------ helpers
    async function getUser(email) {
        var [rows] = await db.query("SELECT comboUser, status FROM users2025 WHERE txtEmail = ? LIMIT 1", [email]);
        return rows[0] || null;
    }
    var FAILED_RE = /INVALID|REJECT|FAIL|BLOCK|ERROR/i;
    function payoutState(org) {
        if (!org) return "PROFILE_REQUIRED";
        var s = org.cf_vendor_status;
        if (!org.cf_vendor_id && !s) return "NOT_STARTED";
        if (s === "ACTIVE") return "ACTIVE";
        if (FAILED_RE.test(s || "")) return "ACTION_REQUIRED";
        return "PENDING";
    }
    async function getOrg(email) {
        var [rows] = await db.query("SELECT * FROM regorg WHERE emailid = ? LIMIT 1", [email]);
        return rows[0] || null;
    }
    async function requireOrg(req, resp) {
        var email = String((req.body && req.body.emailid) || req.query.emailid || "").trim();
        if (!email) { send(resp, 400, "error", "Email is required."); return null; }
        var u = await getUser(email);
        if (!u || String(u.comboUser).toLowerCase() !== "org" || u.status != 1) {
            send(resp, 403, "error", "Only active organizer accounts can do this."); return null;
        }
        return email;
    }

    // ============================================================ 1. VENDOR ONBOARDING (once per organization)
    app.post("/api/org/payout-setup", async function (req, resp) {
        try {
            if (!configured()) return send(resp, 503, "error", "Online payments are not enabled on this server yet.");
            var email = await requireOrg(req, resp); if (!email) return;
            var b = req.body;

            var org = await getOrg(email);
            if (!org) return send(resp, 400, "error", "Please save your Organization Details first.");

            // Everything Cashfree needs is entered in the payout pop-up. Nothing is read from Organization Details.
            var holder = String(b.accountHolder || "").trim().replace(/\s+/g, " ").toUpperCase();
            var acct = String(b.accountNumber || "").replace(/\s/g, "");
            var ifsc = String(b.ifsc || "").trim().toUpperCase();
            var pan = String(b.pan || "").trim().toUpperCase();
            var phone = String(b.phone || "").replace(/\D/g, "").replace(/^91(?=\d{10}$)/, "");
            var contactEmail = String(b.contactEmail || "").trim().toLowerCase();
            var type = String(b.accountType || "INDIVIDUAL").toUpperCase() === "BUSINESS" ? "BUSINESS" : "INDIVIDUAL";
            if (holder.length < 3 || holder.length > 100) return send(resp, 400, "error", "Enter the account holder name as on the bank account.");
            if (!/^\d{9,18}$/.test(acct)) return send(resp, 400, "error", "Enter a valid bank account number (9-18 digits).");
            if (!/^[A-Z]{4}0[A-Z0-9]{6}$/.test(ifsc)) return send(resp, 400, "error", "Enter a valid IFSC code.");
            if (!/^[A-Z]{5}[0-9]{4}[A-Z]$/.test(pan)) return send(resp, 400, "error", "Enter a valid PAN.");
            if (!/^[6-9]\d{9}$/.test(phone)) return send(resp, 400, "error", "Enter a valid 10-digit mobile number for payout notifications.");
            if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(contactEmail) || contactEmail.length > 100) return send(resp, 400, "error", "Enter a valid email address for payout notifications.");

            // Setup is allowed when nothing was submitted yet, or when Cashfree rejected the previous attempt.
            var prevId = org.cf_vendor_id || null, prevStatus = org.cf_vendor_status || null;
            if (prevId && !FAILED_RE.test(prevStatus || ""))
                return send(resp, 409, "error", "Payout setup is already done for this organization.", { state: payoutState(org) });

            // A fresh vendor id per attempt: a rejected Cashfree vendor cannot be corrected in place.
            // Cashfree accepts only alphanumeric vendor IDs.
            var vendorId = "pporg" + md5(email).slice(0, 12) + Date.now().toString(36);
            // Claim the slot atomically: only one request can pass this.
            var [claim] = await db.query(
                "UPDATE regorg SET cf_vendor_id = ?, cf_vendor_status = 'SUBMITTING' WHERE emailid = ? AND cf_vendor_id <=> ? AND cf_vendor_status <=> ?",
                [vendorId, email, prevId, prevStatus]);
            if (claim.affectedRows === 0)
                return send(resp, 409, "error", "Payout setup is already in progress. Please wait a moment.", { state: payoutState(await getOrg(email)) });

            var r = await cf("POST", "/easy-split/vendors", {
                vendor_id: vendorId, status: "ACTIVE", name: holder.slice(0, 100),
                email: contactEmail, phone: phone, verify_account: VERIFY_ACCOUNT, dashboard_access: false, schedule_option: 1,
                bank: { account_number: acct, account_holder: holder, ifsc: ifsc },
                kyc_details: { account_type: type, business_type: BUSINESS_TYPE || (type === "BUSINESS" ? "Society/Trust/Club/Association" : "Miscellaneous"), pan: pan }
            });

            if (!r.ok) {
                // put the previous state back so a rejected organizer can simply try again
                await db.query("UPDATE regorg SET cf_vendor_id = ?, cf_vendor_status = ? WHERE emailid = ? AND cf_vendor_status = 'SUBMITTING'", [prevId, prevStatus, email]);
                console.log("Cashfree vendor create failed:", r.status, r.json && r.json.code, r.json && r.json.message);
                return send(resp, 400, "error", (r.json && r.json.message) || "Cashfree could not verify these details. Please check and try again.");
            }
            var st = String(r.json.status || "PENDING").toUpperCase();
            await db.query("UPDATE regorg SET cf_vendor_status = ?, cf_onboarded_at = NOW() WHERE emailid = ?", [st, email]);
            console.log("Cashfree vendor onboarded for", email, "->", st);
            if (FAILED_RE.test(st))
                return send(resp, 400, "error", "Cashfree could not verify these bank details (" + st + "). Please check the account holder name, account number, IFSC and PAN, then try again.", { state: "ACTION_REQUIRED" });
            send(resp, 200, "success", st === "ACTIVE" ? "Payouts are active." : "Details submitted. Verification is in progress.", { state: payoutState({ cf_vendor_id: vendorId, cf_vendor_status: st }) });
        } catch (e) { console.log("payout-setup error:", e.message); send(resp, 500, "error", "Could not complete payout setup. Please try again."); }
    });

    // Status for the dashboard banner. Refreshes from Cashfree while verification is pending.
    app.get("/api/org/payout-status", async function (req, resp) {
        try {
            var email = await requireOrg(req, resp); if (!email) return;
            var org = await getOrg(email);
            if (org && org.cf_vendor_id && org.cf_vendor_status && org.cf_vendor_status !== "ACTIVE" && org.cf_vendor_status !== "SUBMITTING" && configured()) {
                var g = await cf("GET", "/easy-split/vendors/" + encodeURIComponent(org.cf_vendor_id));
                if (g.ok && g.json.status && String(g.json.status).toUpperCase() !== org.cf_vendor_status) {
                    org.cf_vendor_status = String(g.json.status).toUpperCase();
                    await db.query("UPDATE regorg SET cf_vendor_status = ? WHERE emailid = ?", [org.cf_vendor_status, email]);
                }
            }
            // Vendor ID is internal: it is never sent to the browser.
            resp.json({ state: payoutState(org), enabled: configured(), mode: MODE, platformFeePercent: PLATFORM_FEE_PCT });
        } catch (e) { console.log("payout-status error:", e.message); send(resp, 500, "error", "Could not load payout status."); }
    });

    // ============================================================ 2. PLAYER: Register & Pay
    app.post("/api/payments/create-order", async function (req, resp) {
        try {
            if (!configured()) return send(resp, 503, "error", "Online payments are not available right now.");
            var rid = parseInt(req.body.rid, 10);
            var email = String(req.body.email || "").trim();
            if (!rid || !email) return send(resp, 400, "error", "Tournament and player are required.");

            var u = await getUser(email);
            if (!u) return send(resp, 401, "error", "Account not found. Please log in again.");
            var role = String(u.comboUser || "").toLowerCase();
            if (u.status != 1) return send(resp, 403, "error", "Your account is blocked. Please contact the admin.");
            if (role !== "participant" && role !== "player") return send(resp, 403, "error", "Only player accounts can register for tournaments.");

            var [ev] = await db.query(
                "SELECT e.rid, e.eventname, e.fee, e.emailid AS org_email, (COALESCE(e.lastDate, e.doe) >= CURDATE() AND e.doe >= CURDATE()) AS is_open, " +
                "o.cf_vendor_id, o.cf_vendor_status FROM post_event e LEFT JOIN regorg o ON o.emailid = e.emailid WHERE e.rid = ? LIMIT 1", [rid]);
            if (!ev.length) return send(resp, 404, "error", "This tournament is no longer available.");
            var t = ev[0];
            if (Number(t.is_open) !== 1) return send(resp, 400, "error", "Registration for this tournament is closed.");
            var fee = Number(t.fee || 0);                       // amount ALWAYS comes from the database
            if (fee <= 0) return send(resp, 400, "error", "This tournament is free. No payment is needed.");
            if (!t.cf_vendor_id || t.cf_vendor_status !== "ACTIVE")
                return send(resp, 409, "error", "The organizer has not enabled online payments for this tournament yet.");

            var [dup] = await db.query("SELECT reg_id FROM registrations WHERE rid = ? AND player_email = ? LIMIT 1", [rid, email]);
            if (dup.length) return send(resp, 409, "error", "You are already registered for this tournament.");

            var [pl] = await db.query("SELECT name, contact FROM player_details WHERE emailid = ? LIMIT 1", [email]);
            var phone = String((pl[0] && pl[0].contact) || "");
            if (!/^\d{10}$/.test(phone)) return send(resp, 400, "error", "Please add your 10-digit mobile number in your Player Profile before paying.");

            var vendorAmount = Number((fee - fee * PLATFORM_FEE_PCT / 100).toFixed(2));
            var orderId = "PP" + rid + "_" + crypto.randomBytes(6).toString("hex");

            var meta = { return_url: PUBLIC_URL + "/payment?rid=" + rid + "&order_id={order_id}" };
            if (/^https:/i.test(PUBLIC_URL)) meta.notify_url = PUBLIC_URL + "/webhooks/cashfree";

            var r = await cf("POST", "/orders", {
                order_id: orderId, order_amount: fee, order_currency: "INR",
                order_note: ("PulsePoint: " + t.eventname).slice(0, 100),
                customer_details: { customer_id: "pl_" + md5(email).slice(0, 20), customer_email: email, customer_phone: phone, customer_name: (pl[0] && pl[0].name) || undefined },
                order_meta: meta,
                order_splits: [{ vendor_id: t.cf_vendor_id, amount: vendorAmount }]
            });
            if (!r.ok || !r.json.payment_session_id) {
                console.log("Cashfree create order failed:", r.status, r.json && r.json.code, r.json && r.json.message);
                return send(resp, 502, "error", "Could not start the payment. Please try again.");
            }
            await db.query(
                "INSERT INTO payment_orders(order_id, rid, player_email, org_email, vendor_id, amount, vendor_amount, status) VALUES(?,?,?,?,?,?,?,'CREATED')",
                [orderId, rid, email, t.org_email, t.cf_vendor_id, fee, vendorAmount]);
            resp.json({ status: "success", orderId: orderId, paymentSessionId: r.json.payment_session_id, mode: MODE });
        } catch (e) { console.log("create-order error:", e.message); send(resp, 500, "error", "Could not start the payment. Please try again."); }
    });

    // The browser never decides that a payment is paid. If the webhook has not arrived yet (always the case on
    // localhost / plain http, where Cashfree cannot call us), ask Cashfree directly with our secret key.
    async function reconcileOrder(orderId, email) {
        var [cur] = await db.query("SELECT status FROM payment_orders WHERE order_id = ? AND player_email = ? LIMIT 1", [orderId, email]);
        if (!cur.length || cur[0].status !== "CREATED" || !configured()) return;
        var r = await cf("GET", "/orders/" + encodeURIComponent(orderId) + "/payments");
        if (!r.ok || !Array.isArray(r.json) || !r.json.length) return;
        var ok = r.json.filter(function (p) { return String(p.payment_status).toUpperCase() === "SUCCESS"; })[0];
        if (ok) {
            await onPaymentSuccess({ order: { order_id: orderId, order_amount: ok.order_amount != null ? ok.order_amount : ok.payment_amount }, payment: ok });
        } else if (r.json.every(function (p) { return /FAILED|USER_DROPPED|CANCELLED/i.test(String(p.payment_status)); })) {
            await db.query("UPDATE payment_orders SET status='FAILED' WHERE order_id = ? AND status='CREATED'", [orderId]);
        }
    }

    // Read-only for the browser.
    app.get("/api/payments/status", async function (req, resp) {
        try {
            var orderId = String(req.query.order_id || ""), email = String(req.query.email || "").trim();
            try { await reconcileOrder(orderId, email); } catch (e) { console.log("reconcile error:", e.message); }
            var [rows] = await db.query(
                "SELECT po.status, po.amount, po.cf_payment_id, r.reg_id FROM payment_orders po " +
                "LEFT JOIN registrations r ON r.order_id = po.order_id WHERE po.order_id = ? AND po.player_email = ? LIMIT 1", [orderId, email]);
            if (!rows.length) return send(resp, 404, "error", "Payment not found.");
            var p = rows[0];
            resp.json({
                status: p.status, amount: Number(p.amount), txnRef: p.cf_payment_id || null,
                reference: p.reg_id ? "PP-" + String(p.reg_id).padStart(6, "0") : null
            });
        } catch (e) { send(resp, 500, "error", "Could not check the payment."); }
    });

    // ============================================================ 3. WEBHOOK (source of truth)
    function validSignature(req) {
        if (!CLIENT_SECRET || !req.rawBody) return false;
        var sig = String(req.headers["x-webhook-signature"] || ""), ts = String(req.headers["x-webhook-timestamp"] || "");
        if (!sig || !ts) return false;
        var expected = crypto.createHmac("sha256", CLIENT_SECRET).update(ts + req.rawBody).digest("base64");
        var a = Buffer.from(expected), b = Buffer.from(sig);
        return a.length === b.length && crypto.timingSafeEqual(a, b);
    }

    async function onPaymentSuccess(d) {
        var orderId = d.order && d.order.order_id, pay = d.payment || {};
        var [rows] = await db.query("SELECT * FROM payment_orders WHERE order_id = ? LIMIT 1", [orderId]);
        if (!rows.length) { console.log("Webhook for unknown order", orderId); return; }
        var po = rows[0];
        if (po.status === "PAID" || po.status === "DUPLICATE") return;                      // idempotent
        if (Number(d.order.order_amount) !== Number(po.amount)) {
            await db.query("UPDATE payment_orders SET status = 'MISMATCH' WHERE order_id = ?", [orderId]);
            console.log("Webhook amount mismatch for", orderId); return;
        }
        var conn = await db.getConnection();
        try {
            await conn.beginTransaction();
            var [u] = await conn.query(
                "UPDATE payment_orders SET status='PAID', cf_payment_id=?, payment_method=?, paid_at=NOW() WHERE order_id=? AND status IN ('CREATED','FAILED')",
                [String(pay.cf_payment_id || "").slice(0, 30), String(pay.payment_group || "").slice(0, 30), orderId]);
            if (u.affectedRows === 0) { await conn.rollback(); return; }
            try {
                await conn.query(
                    "INSERT INTO registrations(rid, player_email, amount, upi_app, txn_ref, status, order_id) VALUES(?,?,?,?,?,'Paid',?)",
                    [po.rid, po.player_email, po.amount, String(pay.payment_group || "online").slice(0, 20), String(pay.cf_payment_id || "").slice(0, 20), orderId]);
                await conn.commit();
                console.log("PAID + REGISTERED:", po.player_email, "-> tournament", po.rid, "order", orderId);
            } catch (e) {
                await conn.rollback();
                if (e.code !== "ER_DUP_ENTRY") throw e;
                // Player already registered (paid twice). Keep the record and flag it for a refund.
                await db.query("UPDATE payment_orders SET status='DUPLICATE', cf_payment_id=?, paid_at=NOW() WHERE order_id=?", [String(pay.cf_payment_id || ""), orderId]);
                console.log("DUPLICATE payment needs refund:", orderId);
            }
        } finally { conn.release(); }
    }

    app.post("/webhooks/cashfree", async function (req, resp) {
        if (!validSignature(req)) { console.log("Cashfree webhook rejected: bad signature"); return resp.status(401).send("invalid signature"); }
        try {
            var evt = req.body || {}, type = String(evt.type || ""), d = evt.data || {};
            if (type === "PAYMENT_SUCCESS_WEBHOOK") await onPaymentSuccess(d);
            else if (type === "PAYMENT_FAILED_WEBHOOK" || type === "PAYMENT_USER_DROPPED_WEBHOOK") {
                var oid = d.order && d.order.order_id;
                if (oid) await db.query("UPDATE payment_orders SET status='FAILED' WHERE order_id = ? AND status='CREATED'", [oid]);
            } else if (/VENDOR/i.test(type)) {
                var v = d.vendor_id ? d : (d.vendor || {});
                if (v.vendor_id && v.status) await db.query("UPDATE regorg SET cf_vendor_status = ? WHERE cf_vendor_id = ?", [String(v.status).toUpperCase(), v.vendor_id]);
            }
            resp.status(200).send("ok");
        } catch (e) { console.log("Webhook processing error:", e.message); resp.status(500).send("retry"); }   // Cashfree retries on non-2xx
    });

    // ============================================================ 4. ORGANIZER DASHBOARD DATA
    app.get("/api/org/payments", async function (req, resp) {
        try {
            var email = await requireOrg(req, resp); if (!email) return;
            var [sum] = await db.query(
                "SELECT COUNT(*) AS registrations, COALESCE(SUM(r.amount),0) AS gross, COALESCE(SUM(po.vendor_amount),0) AS net, SUM(r.amount > 0) AS paid " +
                "FROM registrations r JOIN post_event e ON e.rid = r.rid LEFT JOIN payment_orders po ON po.order_id = r.order_id WHERE e.emailid = ?", [email]);
            var [att] = await db.query(
                "SELECT SUM(po.status='CREATED' AND po.created_at > NOW() - INTERVAL 1 DAY) AS pending, SUM(po.status IN ('DUPLICATE','MISMATCH')) AS attention " +
                "FROM payment_orders po WHERE po.org_email = ?", [email]);
            var [rows] = await db.query(
                "SELECT r.reg_id, r.amount, r.status, r.registered_at, r.txn_ref, r.upi_app AS method, e.eventname, r.player_email, " +
                "p.name AS player_name, p.contact AS player_contact, po.vendor_amount " +
                "FROM registrations r JOIN post_event e ON e.rid = r.rid " +
                "LEFT JOIN player_details p ON p.emailid = r.player_email LEFT JOIN payment_orders po ON po.order_id = r.order_id " +
                "WHERE e.emailid = ? ORDER BY r.registered_at DESC LIMIT 300", [email]);
            var s = sum[0] || {}, a = att[0] || {};
            resp.json({
                summary: { registrations: Number(s.registrations || 0), paidRegistrations: Number(s.paid || 0), gross: Number(s.gross || 0), net: Number(s.net || 0),
                    pending: Number(a.pending || 0), attention: Number(a.attention || 0) },
                rows: rows
            });
        } catch (e) { console.log("org payments error:", e.message); send(resp, 500, "error", "Could not load payments."); }
    });

    return { ensureSchema: ensureSchema };
};