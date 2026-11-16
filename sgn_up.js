// ============================================================================
//  PulsePoint server  (fixed version)
//  Run:  node sgn_up.js        then open  http://localhost:2400
//  Health check:  http://localhost:2400/health   (tells you if the DB works)
// ============================================================================
try { require("dotenv").config(); } catch (e) { /* dotenv optional */ }

var express = require("express");
var fs = require("fs");
var path = require("path");
var fileuploader = require("express-fileupload");
var mysql2 = require("mysql2");
var crypto = require("crypto");
var mountCashfree = require("./Cashfree");

var app = express();
var port = Number(process.env.PORT) || 2400;
app.disable("x-powered-by");
app.set("trust proxy", 1);

// ---------------------------------------------------------------- safety net
// A single unexpected error must never kill the server (that was making every
// later signup/login fail silently).
process.on("unhandledRejection", function (err) { console.log("UNHANDLED REJECTION:", err && err.message ? err.message : err); });
process.on("uncaughtException", function (err) { console.log("UNCAUGHT EXCEPTION:", err && err.message ? err.message : err); });

// ---------------------------------------------------------------- config
// DB_* is convenient locally. Railway provides the equivalent MYSQL* names,
// so both naming conventions are accepted without copying credentials into code.
var dbConfig = {
    host: process.env.DB_HOST || process.env.MYSQLHOST || "127.0.0.1",
    user: process.env.DB_USER || process.env.MYSQLUSER || "root",
    password: process.env.DB_PASSWORD || process.env.MYSQLPASSWORD || "",
    port: Number(process.env.DB_PORT || process.env.MYSQLPORT) || 3306,
    connectTimeout: 10000
};
var databaseName = process.env.DB_NAME || process.env.MYSQLDATABASE || "sports_portal";
var pool = mysql2.createPool(Object.assign({}, dbConfig, {
    database: databaseName,
    waitForConnections: true,
    connectionLimit: 10,
    queueLimit: 0
}));

// ---------------------------------------------------------------- middleware
app.use(function (req, resp, next) {
    resp.set({
        "X-Content-Type-Options": "nosniff",
        "X-Frame-Options": "SAMEORIGIN",
        "Referrer-Policy": "strict-origin-when-cross-origin",
        "Permissions-Policy": "camera=(), microphone=(), geolocation=()"
    });
    if (process.env.NODE_ENV === "production")
        resp.set("Strict-Transport-Security", "max-age=31536000; includeSubDomains");
    next();
});
app.use(express.urlencoded({ extended: false, limit: "100kb" }));
app.use(express.json({
    limit: "2mb",
    verify: function (req, res, buf) {
        if (req.path === "/webhooks/cashfree") req.rawBody = Buffer.from(buf);
    }
}));
app.use(fileuploader({
    limits: { fileSize: 5 * 1024 * 1024 },
    abortOnLimit: true,
    safeFileNames: true,
    preserveExtension: true
}));

// never let the browser cache API answers (stale login/signup responses)
app.use(function (req, resp, next) {
    if (!/\.(html|css|js|png|jpe?g|webp|avif|gif|mp4|webm|svg|ico)$/i.test(req.path)) resp.set("Cache-Control", "no-store");
    next();
});

app.use(express.static(path.join(__dirname, "public")));

// log every API request so you can SEE what is happening in the terminal
app.use(function (req, resp, next) {
    if (!/\.(html|css|js|png|jpe?g|webp|avif|gif|mp4|webm|svg|ico)$/i.test(req.path)) console.log(new Date().toLocaleTimeString(), req.method, req.path);
    next();
});

function dbFail(resp, err, asJson) {
    console.log("DB ERROR:", err.code, err.message);
    var msg = "Database error: " + (err.code || err.message);
    if (err.code === "ECONNREFUSED" || err.code === "ETIMEDOUT")
        msg = "Cannot connect to MySQL. Is MySQL running on the configured host/port?";
    else if (err.code === "ER_ACCESS_DENIED_ERROR")
        msg = "MySQL login failed: wrong DB_USER / DB_PASSWORD.";
    else if (err.code === "ER_BAD_DB_ERROR")
        msg = "Database '" + databaseName + "' does not exist and could not be created.";
    else if (err.code === "ER_NO_SUCH_TABLE")
        msg = "A required table is missing. Restart the server to auto-create tables.";
    if (asJson) return resp.status(500).json({ status: "error", message: msg });
    return resp.status(500).send(msg);
}

// ---------------------------------------------------------------- schema
// Creates any missing table (never drops data) and makes sure an admin exists.
function runSeries(list, done) {
    (function next(i) {
        if (i >= list.length) return done();
        pool.query(list[i], function (err) {
            if (err) return done(err);
            next(i + 1);
        });
    })(0);
}

function ensureColumn(table, column, definition, done) {
    pool.query(
        "SELECT COUNT(*) AS c FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND COLUMN_NAME = ?",
        [table, column],
        function (err, rows) {
            if (err) return done(err);
            if (rows[0].c > 0) return done();
            pool.query("ALTER TABLE `" + table + "` ADD COLUMN `" + column + "` " + definition, done);
        }
    );
}

// Databases created before this change have no username column. Add it once,
// fill it from the email (so existing accounts keep working), then make it required and unique.
function ensureUsernameColumn(done) {
    pool.query("SELECT COUNT(*) AS c FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'users2025' AND COLUMN_NAME = 'username'", function (err, rows) {
        if (err) return done(err);
        if (rows[0].c > 0) return done();
        console.log("Migrating users2025: adding username column...");
        runSeries([
            "ALTER TABLE users2025 ADD COLUMN username VARCHAR(30) NULL AFTER txtEmail",
            "UPDATE users2025 SET username = txtEmail WHERE username IS NULL",
            "UPDATE users2025 SET username = 'admin' WHERE txtEmail = 'ad23@gmail.com' AND username = 'ad23@gmail.com'",
            "ALTER TABLE users2025 MODIFY username VARCHAR(30) NOT NULL, ADD UNIQUE KEY uq_users2025_username (username)"
        ], function (err2) {
            if (!err2) console.log("users2025 migration complete.");
            done(err2);
        });
    });
}

function ensureSchema(done) {
    var tables = [
        "CREATE TABLE IF NOT EXISTS users2025(txtEmail varchar(30) primary key, username varchar(30) unique, txtPwd varchar(200), comboUser varchar(20), status int, dos date)",
        "CREATE TABLE IF NOT EXISTS player_details(name varchar(30), adhaar_number varchar(30), gender varchar(20), dob varchar(20), emailid varchar(30) primary key, picurl1 text, picurl2 text, plyname varchar(20), games varchar(100), address text, city varchar(80), state varchar(40), zip varchar(20), otherinfo varchar(100), contact bigint)",
        "CREATE TABLE IF NOT EXISTS regorg(emailid VARCHAR(30) PRIMARY KEY, picurl TEXT, orgname VARCHAR(20), regnumber VARCHAR(20), address VARCHAR(40), sports VARCHAR(255), website VARCHAR(30), insta VARCHAR(20), head VARCHAR(20), contact BIGINT, dos DATE)",
        "CREATE TABLE IF NOT EXISTS post_event(rid int auto_increment primary key, emailid VARCHAR(30), eventname VARCHAR(30), doe DATE, Address VARCHAR(100), toe time, inputState VARCHAR(30), Category VARCHAR(30), minage INT, contact BIGINT, maxage INT, lastDate DATE, fee BIGINT, pMny BIGINT, otherinfo VARCHAR(100))",
        "CREATE TABLE IF NOT EXISTS registrations(reg_id INT AUTO_INCREMENT PRIMARY KEY, rid INT NOT NULL, player_email VARCHAR(30) NOT NULL, amount BIGINT DEFAULT 0, upi_app VARCHAR(20), txn_ref VARCHAR(20), status VARCHAR(20) DEFAULT 'Paid', registered_at DATETIME DEFAULT CURRENT_TIMESTAMP, UNIQUE KEY uq_reg_player (rid, player_email), UNIQUE KEY uq_reg_txn (txn_ref))"
    ];
    function fail(err) { console.log("Schema check FAILED:", err.code, err.message); return done(err); }
    function ensureAdmin(doneAdmin) {
        var email = String(process.env.ADMIN_EMAIL || "").trim().toLowerCase();
        var username = String(process.env.ADMIN_USERNAME || "").trim();
        var password = String(process.env.ADMIN_PASSWORD || "");
        if (!email || !username || !password) return doneAdmin();
        if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email) || !passwordIsValid(password))
            return doneAdmin(new Error("ADMIN_EMAIL, ADMIN_USERNAME or ADMIN_PASSWORD is invalid."));
        pool.query(
            "INSERT IGNORE INTO users2025(txtEmail, username, txtPwd, comboUser, status, dos) VALUES(?,?,?,?,1,CURDATE())",
            [email, username, hashPassword(password), "Admin"], doneAdmin);
    }
    runSeries(tables, function (err) {
        if (err) return fail(err);
        ensureUsernameColumn(function (err2) {
            if (err2) return fail(err2);
            ensureColumn("regorg", "otherinfo", "TEXT", function (err3) {
                if (err3) return fail(err3);
                ensureColumn("regorg", "city", "VARCHAR(80)", function (err4) {
                    if (err4) return fail(err4);
                    ensureColumn("regorg", "state", "VARCHAR(40)", function (err5) {
                        if (err5) return fail(err5);
                        ensureColumn("regorg", "zip", "VARCHAR(20)", function (err6) {
                            if (err6) return fail(err6);
                            ensureColumn("player_details", "city", "VARCHAR(80)", function (err7) {
                                if (err7) return fail(err7);
                                ensureColumn("player_details", "state", "VARCHAR(40)", function (err8) {
                                    if (err8) return fail(err8);
                                    ensureColumn("player_details", "zip", "VARCHAR(20)", function (err9) {
                                        if (err9) return fail(err9);
                                        runSeries(["ALTER TABLE users2025 MODIFY txtPwd VARCHAR(200)", "ALTER TABLE regorg MODIFY sports VARCHAR(255)"], function (err10) {
                                            if (err10) return fail(err10);
                                            ensureAdmin(function (err11) {
                                                if (err11) return fail(err11);
                                                console.log("Schema check OK (tables exist).");
                                                done();
                                            });
                                        });
                                    });
                                });
                            });
                        });
                    });
                });
            });
        });
    });
}

function initializeDatabase(done) {
    var connection = mysql2.createConnection(dbConfig);
    var safeName = databaseName.replace(/`/g, "``");
    connection.query("CREATE DATABASE IF NOT EXISTS `" + safeName + "`", function (createErr) {
        connection.end();
        if (createErr) return done(createErr);
        pool.getConnection(function (err, dbConnection) {
            if (err) return done(err);
            console.log("Local MySQL Connected Successfully! Host:", dbConnection.config.host);
            dbConnection.release();
            ensureSchema(function (schemaErr) {
                if (schemaErr) return done(schemaErr);
                done();
            });
        });
    });
}

// ---------------------------------------------------------------- pages
app.get("/", function (req, resp) {
    resp.sendFile(path.join(__dirname, "public", "index.html"));
});
app.get("/dash_admin.html", function (req, resp) {
    resp.sendFile(path.join(__dirname, "public", "dash_admin.html"));
});
app.get("/tournament-finder", function (req, resp) {
    resp.sendFile(path.join(__dirname, "public", "tournament-finder.html"));
});
app.get("/my-registrations", function (req, resp) {
    resp.sendFile(path.join(__dirname, "public", "player-registrations.html"));
});

// ---------------------------------------------------------------- sports media (hero slideshow + welcome clip)
// Drop real sports clips/images into:
//   public/pics/hero/      -> any number of files, shown as the top-banner slideshow (sorted by file name)
//   public/pics/welcome/   -> one small clip/image for the welcome (Our Mission) section
// No code change is needed when you add or remove files; the page asks this endpoint for the list.
var MEDIA_EXT = { ".mp4": "video/mp4", ".webm": "video/webm", ".gif": "image/gif", ".webp": "image/webp",
    ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".png": "image/png", ".avif": "image/avif" };
function listMedia(folder, limit) {
    var dir = path.join(__dirname, "public", "pics", folder);
    try {
        return fs.readdirSync(dir)
            .filter(function (f) { return MEDIA_EXT[path.extname(f).toLowerCase()]; })
            .sort(function (a, b) { return a.localeCompare(b, undefined, { numeric: true }); })
            .slice(0, limit)
            .map(function (f) {
                return { src: "/pics/" + folder + "/" + encodeURIComponent(f), type: MEDIA_EXT[path.extname(f).toLowerCase()] };
            });
    } catch (e) { return []; }
}
app.get("/api/sports-media", function (req, resp) {
    resp.set("Cache-Control", "no-cache");
    resp.json({ hero: listMedia("hero", 12), welcome: listMedia("welcome", 1) });
});

app.get("/health", function (req, resp) {
    pool.query("select count(*) as users from users2025", function (err, rows) {
        if (err) return dbFail(resp, err, true);
        resp.json({ status: "ok", db: "connected", users: rows[0].users });
    });
});

// ---------------------------------------------------------------- signup / login
function passwordIsValid(p) {
    return p.length >= 6 && p.length <= 20 &&
        /\d/.test(p) && /[^A-Za-z0-9\s]/.test(p);
}

function hashPassword(password) {
    var salt = crypto.randomBytes(16).toString("hex");
    var derived = crypto.scryptSync(password, salt, 64).toString("hex");
    return "scrypt$" + salt + "$" + derived;
}

function passwordMatches(password, stored) {
    var parts = String(stored || "").split("$");
    if (parts.length !== 3 || parts[0] !== "scrypt") return stored === password;
    var actual = crypto.scryptSync(password, parts[1], 64);
    var expected = Buffer.from(parts[2], "hex");
    return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
}

app.post("/server-signup", function (req, resp) {
    let username = String(req.body.username || "").trim();
    let txtEmail = String(req.body.id || "").trim().toLowerCase();
    let txtPwd = String(req.body.txtPwd || "");
    let comboUser = String(req.body.comboUser || "").trim();

    if (!username || !txtEmail || !txtPwd || !comboUser)
        return resp.send("Username, email, password and account type are required.");
    if (!/^[A-Za-z0-9_.]{3,30}$/.test(username))
        return resp.send("Username must be 3 to 30 letters, numbers, dots or underscores.");
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(txtEmail))
        return resp.send("Please enter a valid email address.");
    if (txtEmail.length > 30)
        return resp.send("Email must be 30 characters or fewer.");
    if (!passwordIsValid(txtPwd))
        return resp.send("Password must be 6 to 20 characters, with at least one number and one special character.");
    if (comboUser !== "participant" && comboUser !== "org")
        return resp.send("Invalid account type selected.");

    pool.query("SELECT txtEmail FROM users2025 WHERE txtEmail = ? LIMIT 1", [txtEmail], function (lookupErr, existingRows) {
        if (lookupErr) return dbFail(resp, lookupErr, false);
        if (existingRows.length > 0) return resp.send("Mail already exists.");

        pool.query("insert into users2025(username, txtEmail, txtPwd, comboUser, status, dos) values(?,?,?,?,1,current_date())",
            [username, txtEmail, hashPassword(txtPwd), comboUser], function (err) {
                if (err == null) {
                    console.log("SIGNUP SAVED:", username, txtEmail);
                    return resp.send("recorded successfully");
                }
                console.log("SIGNUP FAILED:", err.code, err.message);
                if (err.code === "ER_DUP_ENTRY") {
                    if (/username/i.test(err.message)) return resp.send("This username is already taken. Please choose another.");
                    return resp.send("Mail already exists.");
                }
                if (err.code === "ER_DATA_TOO_LONG") return resp.send("Username, email or password is too long.");
                return dbFail(resp, err, false);
            });
    });
});

app.post("/do_login", function (req, resp) {
    let username = String(req.body.username || "").trim();
    let txtPwd2 = String(req.body.txtPwd2 || "");
    let requestedRole = String(req.body.accountType || "").trim().toLowerCase();

    if (!username || !txtPwd2)
        return resp.json({ status: "error", message: "Please enter your username and password." });

    pool.query("select * from users2025 where username = ? or txtEmail = ? LIMIT 1", [username, username.toLowerCase()], function (err, records) {
        if (err) return dbFail(resp, err, true);

        if (records.length !== 1 || !passwordMatches(txtPwd2, records[0].txtPwd))
            return resp.json({ status: "error", message: "Invalid username or password." });

        let user = records[0];
        if (String(user.txtPwd || "").indexOf("scrypt$") !== 0)
            pool.query("UPDATE users2025 SET txtPwd = ? WHERE txtEmail = ?", [hashPassword(txtPwd2), user.txtEmail], function () { });
        if (user.status != 1)
            return resp.json({ status: "error", message: "Your account is blocked. Please contact the admin." });

        let userType = String(user.comboUser || "").trim();
        let t = userType.toLowerCase();
        function sendLogin(role) {
            resp.json({ status: "success", email: user.txtEmail, username: user.username, userType: role });
        }

        if (t === "admin" && String(user.txtEmail).toLowerCase() === "ad23@gmail.com")
            return sendLogin("Admin");
        if (t === "org" || t === "organizer" || t === "organiser")
            if (requestedRole && requestedRole !== "org")
                return resp.json({ status: "error", message: "Login failed: these are organizer credentials. Select Organizer and try again." });
        if (t === "org" || t === "organizer" || t === "organiser")
            return sendLogin("org");
        if (t === "participant" || t === "player")
            if (requestedRole && requestedRole !== "participant")
                return resp.json({ status: "error", message: "Login failed: these are participant credentials. Select Participant and try again." });
        if (t === "participant" || t === "player")
            return sendLogin("participant");

        // Never allow a stale or incorrect role value to route a non-admin
        // account to the administrator dashboard.
        pool.query("SELECT emailid FROM regorg WHERE emailid = ? LIMIT 1", [user.txtEmail], function (orgErr, orgRows) {
            if (orgErr) return dbFail(resp, orgErr, true);
            if (orgRows.length > 0) return sendLogin("org");

            pool.query("SELECT emailid FROM player_details WHERE emailid = ? LIMIT 1", [user.txtEmail], function (playerErr, playerRows) {
                if (playerErr) return dbFail(resp, playerErr, true);
                if (playerRows.length > 0) return sendLogin("participant");
                return resp.json({ status: "error", message: "Your account type is not configured. Please contact the admin." });
            });
        });
    });
});

app.post("/change-password", function (req, resp) {
    const email = String(req.body.email || "").trim();
    const oldPassword = req.body.oldPassword;
    const newPassword = req.body.newPassword;

    if (!email || !oldPassword || !newPassword) return resp.send("All fields are required.");
    if (!passwordIsValid(newPassword))
        return resp.send("New password must be 6 to 20 characters, with at least one number and one special character.");

    pool.query("SELECT * FROM users2025 WHERE txtEmail = ? LIMIT 1", [email], function (err, result) {
        if (err) return dbFail(resp, err, false);
        if (result.length !== 1 || !passwordMatches(oldPassword, result[0].txtPwd)) return resp.send("Incorrect old password.");

        pool.query("UPDATE users2025 SET txtPwd = ? WHERE txtEmail = ?", [hashPassword(newPassword), email], function (err2, updateResult) {
            if (err2) return dbFail(resp, err2, false);
            if (updateResult.affectedRows !== 1) return resp.status(404).send("Password was not updated. Account not found.");
            resp.send("Password updated successfully!");
        });
    });
});

// ---------------------------------------------------------------- uploads
var uploadDir = path.join(__dirname, "public", "uploads");
fs.mkdirSync(uploadDir, { recursive: true });       // folder must exist or uploads crash

// Save uploads locally so the application has no external service dependency.
async function saveUpload(file) {
    let safeName = Date.now() + "_" + file.name.replace(/[^\w.\-]/g, "_");
    let fullPath = path.join(uploadDir, safeName);
    await file.mv(fullPath);
    return "/uploads/" + safeName;
}

async function extractAadhaarDetails(file) {
    let apiKey = String(process.env.GOOGLE_API_KEY || "").trim();
    if (!apiKey) {
        console.log("Aadhaar scan skipped: GOOGLE_API_KEY is not configured.");
        return {};
    }

    if (typeof fetch !== "function") {
        console.log("Aadhaar scan skipped: this Node.js version does not provide fetch().");
        return {};
    }

    let mimeType = String(file.mimetype || "").toLowerCase();
    if (mimeType !== "image/jpeg" && mimeType !== "image/png" && mimeType !== "image/webp")
        return {};

    let model = String(process.env.GEMINI_AADHAAR_MODEL || "gemini-3-flash-preview")
        .replace(/^models\//, "");
    let endpoint = "https://generativelanguage.googleapis.com/v1beta/models/" +
        encodeURIComponent(model) + ":generateContent?key=" + encodeURIComponent(apiKey);
    let requestBody = {
        contents: [{
            parts: [
                {
                    text: "Read this Aadhaar card image and return only valid JSON with exactly these string fields: " +
                        "{\"name\":\"\",\"dob\":\"\",\"adhaar_number\":\"\",\"gender\":\"\"}. " +
                        "Extract the card holder's full name, date of birth, 12-digit Aadhaar number, and gender. " +
                        "Return the Aadhaar number without spaces or dashes when it is readable. " +
                        "Do not guess or invent values; use an empty string when a field is not readable."
                },
                {
                    inline_data: {
                        mime_type: mimeType,
                        data: file.data.toString("base64")
                    }
                }
            ]
        }],
        generationConfig: { responseMimeType: "application/json", temperature: 0 }
    };

    try {
        let response = await fetch(endpoint, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(requestBody)
        });
        let payload = await response.json();
        if (!response.ok)
            throw new Error(payload.error && payload.error.message ? payload.error.message : "Gemini request failed");

        let text = payload.candidates && payload.candidates[0] &&
            payload.candidates[0].content && payload.candidates[0].content.parts &&
            payload.candidates[0].content.parts[0] && payload.candidates[0].content.parts[0].text;
        if (!text) throw new Error("Gemini returned no Aadhaar details.");

        let details = JSON.parse(String(text).replace(/^```json\s*|\s*```$/gi, "").trim());
        return {
            name: typeof details.name === "string" ? details.name.trim() : "",
            dob: typeof details.dob === "string" ? details.dob.trim() : "",
            adhaar_number: typeof details.adhaar_number === "string"
                ? details.adhaar_number.trim()
                : (typeof details.aadhaar_number === "string" ? details.aadhaar_number.trim() : ""),
            gender: typeof details.gender === "string" ? details.gender.trim() : ""
        };
    } catch (err) {
        console.log("Aadhaar scan failed:", err.message);
        return {};
    }
}

async function extractSavedAadhaarDetails(photoUrl) {
    if (!photoUrl || photoUrl === "nopic.jpg" || photoUrl.indexOf("/uploads/") !== 0)
        return {};

    let filePath = path.join(__dirname, "public", photoUrl.replace(/^\/+/, ""));
    if (!fs.existsSync(filePath))
        return {};

    let extension = path.extname(filePath).toLowerCase();
    let mimeTypes = { ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".png": "image/png", ".webp": "image/webp" };
    if (!mimeTypes[extension])
        return {};

    return extractAadhaarDetails({
        mimetype: mimeTypes[extension],
        data: fs.readFileSync(filePath)
    });
}

app.post("/do_registration", async function (req, resp) {
    try {
        let picurl = "nopic.jpg";
        if (req.files && req.files.picupload)
            picurl = await saveUpload(req.files.picupload);

        let b = req.body;
        pool.query(
            "INSERT INTO regorg(emailid, picurl, orgname, regnumber, address, city, state, zip, sports, website, insta, head, contact, otherinfo, dos) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,current_date()) " +
            "ON DUPLICATE KEY UPDATE picurl=IF(VALUES(picurl)='nopic.jpg',picurl,VALUES(picurl)), orgname=VALUES(orgname), regnumber=VALUES(regnumber), address=VALUES(address), city=VALUES(city), state=VALUES(state), zip=VALUES(zip), sports=VALUES(sports), website=VALUES(website), insta=VALUES(insta), head=VALUES(head), contact=VALUES(contact), otherinfo=VALUES(otherinfo)",
            [b.emailid, picurl, b.orgname, b.regnumber, b.address, b.inputCity, b.inputState, b.inputZip, b.sports, b.website, b.insta, b.head, b.contact, b.otherinfo || ""],
            function (err) {
                if (err == null) resp.send("recorded successfully");
                else dbFail(resp, err, false);
            });
    } catch (e) {
        console.log("do_registration error:", e.message);
        resp.status(500).send("Upload failed: " + e.message);
    }
});

app.post("/update-user", async function (req, resp) {
    try {
        let b = req.body;
        let emailid = String(b.emailid || "").trim();
        if (!emailid) return resp.status(400).send("Email is required.");

        function updatePlayer() {
            pool.query("SELECT * FROM player_details WHERE emailid = ? LIMIT 1", [emailid], async function (playerErr, playerRows) {
                if (playerErr) return dbFail(resp, playerErr, false);
                if (playerRows.length === 0) return resp.status(404).send("Invalid email Id");
                let old = playerRows[0];
                let value = function (name, oldName) {
                    return b[name] !== undefined ? b[name] : old[oldName || name];
                };
                let picurl1 = b.removePic1 === "1" ? "nopic.jpg" : (b.hdn || old.picurl1 || "nopic.jpg");
                let picurl2 = old.picurl2 || "nopic.jpg";
                let scannedDetails = {};
                if (b.removePic2 === "1") picurl2 = "nopic.jpg";
                if (req.files && req.files.adhaarupload) {
                    picurl1 = await saveUpload(req.files.adhaarupload);
                    scannedDetails = await extractAadhaarDetails(req.files.adhaarupload);
                }
                if (req.files && req.files.pic_upload)
                    picurl2 = await saveUpload(req.files.pic_upload);

                pool.query(
                    "UPDATE player_details SET name=?, adhaar_number=?, gender=?, dob=?, picurl1=?, picurl2=?, plyname=?, games=?, address=?, city=?, state=?, zip=?, otherinfo=?, contact=? WHERE emailid=?",
                    [scannedDetails.name || value("name"), scannedDetails.adhaar_number || value("adhaar_number"),
                        scannedDetails.gender || value("gender"), scannedDetails.dob || value("dob"), picurl1, picurl2,
                        value("plyname"), value("games"), value("address"), value("inputCity", "city"),
                        value("inputState", "state"), value("inputZip", "zip"), value("otherinfo"), value("contact"), emailid],
                    function (err, result) {
                        if (err) return dbFail(resp, err, false);
                        if (result.affectedRows > 0 || result.changedRows === 0) return resp.send("updated Successfulllyyy");
                        return resp.status(500).send("Player details could not be updated.");
                    }
                );
            });
        }

        if (b.recordType === "player") return updatePlayer();

        pool.query("SELECT * FROM regorg WHERE emailid = ? LIMIT 1", [emailid], async function (orgErr, orgRows) {
            if (orgErr) return dbFail(resp, orgErr, false);
            if (orgRows.length > 0) {
                let picurl = b.removePic === "1" ? "nopic.jpg" : (b.hdn || orgRows[0].picurl || "nopic.jpg");
                if (req.files && req.files.picupload)
                    picurl = await saveUpload(req.files.picupload);
                let old = orgRows[0];
                let value = function (name, oldName) {
                    return b[name] !== undefined ? b[name] : old[oldName || name];
                };
                return pool.query(
                    "UPDATE regorg SET orgname=?, picurl=?, regnumber=?, address=?, city=?, state=?, zip=?, sports=?, website=?, insta=?, head=?, contact=?, otherinfo=? WHERE emailid=?",
                    [value("orgname"), picurl, value("regnumber"), value("address"), value("inputCity", "city"),
                        value("inputState", "state"), value("inputZip", "zip"), value("sports"), value("website"),
                        value("insta"), value("head"), value("contact"), value("otherinfo"), emailid],
                    function (err, result) {
                        if (err) return dbFail(resp, err, false);
                        if (result.affectedRows > 0 || result.changedRows === 0) return resp.send("updated Successfulllyyy");
                        return resp.status(500).send("Organization details could not be updated.");
                    }
                );
            }

            return updatePlayer();
        });
    } catch (e) {
        console.log("update-user error:", e.message);
        resp.status(500).send("Upload failed: " + e.message);
    }
});

app.get("/get-one", function (req, resp) {
    let emailid = String(req.query.emailid || "").trim();
    if (!emailid) return resp.status(400).send("Email is required.");

    pool.query("select * from regorg where emailid=? LIMIT 1", [emailid], function (err, orgRecords) {
        if (err) return dbFail(resp, err, false);
        if (orgRecords.length > 0) { orgRecords.forEach(function (o) { delete o.cf_vendor_id; }); return resp.json(orgRecords); }
        return resp.status(404).send("No saved organization details found for this email.");
    });
});

app.get("/get-organization-details", function (req, resp) {
    let emailid = String(req.query.emailid || "").trim();
    if (!emailid) return resp.status(400).send("Email is required.");

    pool.query("SELECT * FROM regorg WHERE emailid=? LIMIT 1", [emailid], function (err, records) {
        if (err) return dbFail(resp, err, false);
        if (records.length === 0) return resp.status(404).send("No saved organization details found for this email.");
        records.forEach(function (o) { delete o.cf_vendor_id; });
        resp.json(records);
    });
});

app.get("/get-player-details", function (req, resp) {
    let emailid = String(req.query.emailid || "").trim();
    if (!emailid) return resp.status(400).send("Email is required.");

    pool.query("SELECT * FROM player_details WHERE emailid=? LIMIT 1", [emailid], function (err, records) {
        if (err) return dbFail(resp, err, false);
        if (records.length === 0) return resp.status(404).send("No saved player details found for this email.");

        let player = records[0];
        resp.json({
            emailid: player.emailid,
            name: player.name || "",
            adhaar_number: player.adhaar_number || "",
            gender: player.gender || "",
            dob: player.dob || "",
            plyname: player.plyname || "",
            games: player.games || "",
            address: player.address || "",
            city: String(player.city || "").trim(),
            state: String(player.state || "").trim().toUpperCase(),
            zip: String(player.zip || "").trim(),
            contact: player.contact || "",
            otherinfo: player.otherinfo || "",
            aadhaarPhoto: player.picurl1 || "",
            profilePhoto: player.picurl2 || ""
        });
    });
});

// ---------------------------------------------------------------- events
app.post("/Post_event", async function (req, resp) {
    var b = req.body || {};
    try {
        var fee = Number(b.fee || 0);
        if (!b.emailid || !b.eventname || !b.date || !b.inputState || !b.Category)
            return resp.status(400).send("Please fill in all required event fields.");
        if (!Number.isFinite(fee) || fee < 0)
            return resp.status(400).send("Registration fee must be zero or a valid positive amount.");

        var orgRows = await pool.promise().query("SELECT sports FROM regorg WHERE emailid = ? LIMIT 1", [String(b.emailid).trim()]);
        if (!orgRows[0].length)
            return resp.status(404).send("Please save your organization details before posting an event.");
        var allowedSports = String(orgRows[0][0].sports || "").split(",").map(function (sport) {
            return sport.trim().toLowerCase();
        }).filter(Boolean);
        if (allowedSports.indexOf(String(b.Category).trim().toLowerCase()) === -1)
            return resp.status(400).send("Choose a sport listed in your Organization Details.");

        var result = await pool.promise().query(
            "INSERT INTO post_event(emailid,eventname,doe,Address,toe,inputState,Category,minage,contact,maxage,lastDate,fee,pMny,otherinfo) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
            [String(b.emailid).trim(), b.eventname, b.date, b.Address, b.time, b.inputState, b.Category,
                b.minage || null, b.contact || null, b.maxage || null, b.lastDate || null, fee,
                b.pMny || 0, b.otherinfo || ""]
        );
        if (result[0].affectedRows !== 1)
            return resp.status(500).send("The event could not be published.");
        return resp.send("published Successfulllyyy");
    } catch (error) {
        console.log("Post_event error:", error.code || error.message);
        if (error.code === "ER_NO_SUCH_TABLE")
            return resp.status(500).send("The tournament table is missing. Restart the server to run database setup.");
        return resp.status(500).send("Could not publish the event. Please check the event details and try again.");
    }
});

app.get("/do-fetch-all-users", function (req, resp) {
    pool.query("select * from post_event where emailid = ?", [req.query.data], function (err, rows) {
        if (err) return dbFail(resp, err, false);
        resp.json(rows);
    });
});

app.get("/delete-one", function (req, resp) {
    pool.query("delete from post_event where rid=?", [req.query.rid], function (err, result) {
        if (err) return resp.send(err.message);
        if (result.affectedRows == 1) resp.send("Deleted Successfully");
        else resp.send("invalid");
    });
});

app.get("/filter-tournaments", function (req, resp) {
    pool.query("SELECT * FROM post_event WHERE inputState = ? AND Category = ?", [req.query.city, req.query.sport], function (err, results) {
        if (err) return dbFail(resp, err, false);
        resp.json(results);
    });
});

app.get("/get-distinct-games", function (req, resp) {
    var games = [
        "Athletics", "Badminton", "Basketball", "Boxing", "Chess", "Cricket",
        "Cycling", "Football", "Golf", "Hockey", "Kabaddi", "Kho Kho",
        "Swimming", "Table Tennis", "Tennis", "Volleyball", "Wrestling"
    ];
    pool.query("SELECT DISTINCT Category FROM post_event WHERE Category IS NOT NULL AND Category <> ''", function (err, rows) {
        if (err) return dbFail(resp, err, true);
        rows.forEach(function (row) {
            if (games.indexOf(row.Category) === -1) games.push(row.Category);
        });
        resp.json(games.sort());
    });
});

// ---------------------------------------------------------------- admin
app.get("/admin/get-all-users", function (req, resp) {
    pool.query("SELECT txtEmail, comboUser, status, dos FROM users2025", function (err, results) {
        if (err) return dbFail(resp, err, false);
        resp.json(results);
    });
});

app.get("/admin/get-all-orgs", function (req, resp) {
    pool.query("SELECT * FROM regorg", function (err, results) {
        if (err) return dbFail(resp, err, false);
        resp.json(results);
    });
});

app.get("/admin/get-all-players", function (req, resp) {
    pool.promise().query("SELECT * FROM player_details").then(async function (result) {
        let players = result[0];
        for (let player of players) {
            if ((player.name && player.dob && player.adhaar_number && player.gender) || !player.picurl1)
                continue;

            let scannedDetails = await extractSavedAadhaarDetails(player.picurl1);
            if (!scannedDetails.name && !scannedDetails.dob &&
                !scannedDetails.adhaar_number && !scannedDetails.gender)
                continue;

            player.name = scannedDetails.name || player.name || "";
            player.dob = scannedDetails.dob || player.dob || "";
            player.adhaar_number = scannedDetails.adhaar_number || player.adhaar_number || "";
            player.gender = scannedDetails.gender || player.gender || "";
            await pool.promise().query(
                "UPDATE player_details SET name=?, dob=?, adhaar_number=?, gender=? WHERE emailid=?",
                [player.name, player.dob, player.adhaar_number, player.gender, player.emailid]
            );
        }
        resp.json(players);
    }).catch(function (err) {
        dbFail(resp, err, false);
    });
});

app.get("/admin/update-user-status", function (req, resp) {
    pool.query("UPDATE users2025 SET status = ? WHERE txtEmail = ?", [req.query.status, req.query.email], function (err, result) {
        if (err) return dbFail(resp, err, false);
        if (result.affectedRows > 0) resp.send("Status updated successfully");
        else resp.send("User not found.");
    });
});

app.post("/do_player-details", async function (req, resp) {
    try {
        let b = req.body;
        if (!b.emailid) return resp.status(400).send("Email is required.");

        let existing = await pool.promise().query("SELECT * FROM player_details WHERE emailid = ? LIMIT 1", [b.emailid]);
        let old = existing[0][0] || {};

        let picurl1 = old.picurl1 || "nopic.jpg";
        let picurl2 = old.picurl2 || "nopic.jpg";
        let scannedDetails = {};
        if (req.files && req.files.adhaarupload) {
            picurl1 = await saveUpload(req.files.adhaarupload);
            scannedDetails = await extractAadhaarDetails(req.files.adhaarupload);
        }
        if (req.files && req.files.pic_upload)
            picurl2 = await saveUpload(req.files.pic_upload);

        pool.query(
            "INSERT INTO player_details(name, adhaar_number, gender, dob, emailid, picurl1, picurl2, games, address, city, state, zip, otherinfo, contact) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?) " +
            "ON DUPLICATE KEY UPDATE name=VALUES(name), adhaar_number=VALUES(adhaar_number), gender=VALUES(gender), dob=VALUES(dob), picurl1=VALUES(picurl1), picurl2=VALUES(picurl2), games=VALUES(games), address=VALUES(address), city=VALUES(city), state=VALUES(state), zip=VALUES(zip), otherinfo=VALUES(otherinfo), contact=VALUES(contact)",
            [scannedDetails.name || b.name || old.name || "", scannedDetails.adhaar_number || b.adhaar_number || old.adhaar_number || "", scannedDetails.gender || b.gender || old.gender || "", scannedDetails.dob || b.dob || old.dob || "", b.emailid, picurl1, picurl2,
                b.games || old.games || "", b.address || old.address || "", b.inputCity || old.city || "", b.inputState || old.state || "",
                b.inputZip || old.zip || "", b.otherinfo || old.otherinfo || "", b.contact || old.contact || ""],
            function (err) {
                if (err == null) resp.send("recorded successfully");
                else dbFail(resp, err, false);
            });
    } catch (e) {
        console.log("do_player-details error:", e.message);
        resp.status(500).send("Could not process the details: " + e.message);
    }
});

// ---------------------------------------------------------------- free tournament registrations

// One tournament (used by the tournament finder). The fee always comes from the database.
app.get("/get-tournament", function (req, resp) {
    let rid = parseInt(req.query.rid, 10);
    let email = String(req.query.email || "").trim();
    if (!rid) return resp.status(400).json({ status: "error", message: "Tournament id is required." });

    pool.query(
        "SELECT e.*, o.orgname, o.cf_vendor_status AS org_pay_status, (COALESCE(e.lastDate, e.doe) >= CURDATE() AND e.doe >= CURDATE()) AS is_open " +
        "FROM post_event e LEFT JOIN regorg o ON o.emailid = e.emailid WHERE e.rid = ? LIMIT 1", [rid],
        function (err, rows) {
            if (err) return dbFail(resp, err, true);
            if (rows.length === 0) return resp.status(404).json({ status: "error", message: "This tournament is no longer available." });
            let t = rows[0];
            t.is_open = Number(t.is_open) === 1;
            pool.query("SELECT reg_id FROM registrations WHERE rid = ? AND player_email = ? LIMIT 1", [rid, email], function (err2, regRows) {
                if (err2) return dbFail(resp, err2, true);
                resp.json({ tournament: t, registered: regRows.length > 0});
            });
        });
});

// Free tournaments only: save the registration directly.
app.post("/register-tournament", function (req, resp) {
    let rid = parseInt(req.body.rid, 10);
    let email = String(req.body.email || "").trim();
    function bad(msg, code) { return resp.status(code || 400).json({ status: "error", message: msg }); }

    if (!rid || !email) return bad("Tournament and player are required.");

    pool.query("SELECT comboUser, status FROM users2025 WHERE txtEmail = ? LIMIT 1", [email], function (err, users) {
        if (err) return dbFail(resp, err, true);
        if (users.length === 0) return bad("Account not found. Please log in again.", 401);
        let role = String(users[0].comboUser || "").toLowerCase();
        if (users[0].status != 1) return bad("Your account is blocked. Please contact the admin.", 403);
        if (role !== "participant" && role !== "player") return bad("Only player accounts can register for tournaments.", 403);

        pool.query(
            "SELECT rid, fee, (COALESCE(lastDate, doe) >= CURDATE() AND doe >= CURDATE()) AS is_open FROM post_event WHERE rid = ? LIMIT 1", [rid],
            function (err2, rows) {
                if (err2) return dbFail(resp, err2, true);
                if (rows.length === 0) return bad("This tournament is no longer available.", 404);
                if (Number(rows[0].is_open) !== 1) return bad("Registration for this tournament is closed.");

                let amount = Number(rows[0].fee || 0);
                if (amount > 0) return bad("Paid tournament registration is temporarily unavailable.", 402);

                pool.query(
                    "INSERT INTO registrations(rid, player_email, amount, upi_app, txn_ref, status) VALUES(?,?,?,NULL,NULL,'Registered')",
                    [rid, email, amount],
                    function (err3, result) {
                        if (err3) {
                            if (err3.code === "ER_DUP_ENTRY") return bad("You are already registered for this tournament.");
                            return dbFail(resp, err3, true);
                        }
                        console.log("REGISTERED:", email, "-> tournament", rid, "amount", amount);
                        resp.json({
                            status: "success", regId: result.insertId,
                            reference: "PP-" + String(result.insertId).padStart(6, "0"),
                            amount: amount
                        });
                    });
            });
    });
});

// All tournaments a player is registered for (the page splits upcoming / past).
app.get("/get-my-registrations", function (req, resp) {
    let email = String(req.query.email || "").trim();
    if (!email) return resp.status(400).json({ status: "error", message: "Email is required." });
    pool.query(
        "SELECT r.reg_id, r.rid, r.amount, r.status, r.registered_at, " +
        "e.eventname, e.Category, e.doe, e.toe, e.Address, e.inputState, e.contact, e.minage, e.maxage, e.pMny, e.otherinfo, " +
        "o.orgname, (e.doe >= CURDATE()) AS upcoming " +
        "FROM registrations r JOIN post_event e ON e.rid = r.rid LEFT JOIN regorg o ON o.emailid = e.emailid " +
        "WHERE r.player_email = ? ORDER BY e.doe ASC", [email],
        function (err, rows) {
            if (err) return dbFail(resp, err, true);
            resp.json(rows);
        });
});

// last-resort error handler: always answers instead of hanging
app.use(function (err, req, resp, next) {
    console.log("EXPRESS ERROR:", err.message);
    resp.status(500).send("Server error: " + err.message);
});

initializeDatabase(function (err) {
    if (err) {
        console.log("Database startup failed:", err.code, err.message);
        console.log(">>> Start MySQL and check DB_HOST/DB_USER/DB_PASSWORD/DB_NAME.");
        return;
    }
    var cashfree = mountCashfree(app, pool, { dbFail: dbFail, ensureColumn: ensureColumn });
    cashfree.ensureSchema(function (cashfreeErr) {
        if (cashfreeErr) {
            console.log("Cashfree schema setup failed:", cashfreeErr.code, cashfreeErr.message);
            return;
        }
        app.listen(port, function () {
        console.log("Server Started at Port no: " + port + "  ->  open http://localhost:" + port);
        });
    });
});