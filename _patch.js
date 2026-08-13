const fs = require("fs");
const f = "auth-server.js";
let s = fs.readFileSync(f, "utf8");
const orig = s;
function rep(find, repl) {
  if (!s.includes(find)) { console.error("PATTERN NOT FOUND:\n"+find.slice(0,80)); process.exit(2); }
  s = s.replace(find, repl);
}

// 1) Add mysql2 pool + verifier right after the auth.db is opened
rep(
"const db = new Database(dbPath);\n",
`const db = new Database(dbPath);

// ── Production credential delegation (Adlux Production users table) ──────────
// Logins are verified against the live production \`users\` table so the bridge
// uses the exact same email + password as the production Adlux app. The local
// auth.db still owns the pane mapping (home_path) and sessions; only the
// password check is delegated. bcrypt (\$2y\$) hashes verify fine under bcryptjs.
const mysql = require("mysql2/promise");
const prodPool = mysql.createPool({
  host: process.env.PROD_DB_HOST,
  port: +(process.env.PROD_DB_PORT || 3306),
  user: process.env.PROD_DB_USERNAME,
  password: process.env.PROD_DB_PASSWORD,
  database: process.env.PROD_DB_DATABASE,
  connectionLimit: 5,
  waitForConnections: true,
});

async function verifyProdPassword(email, password) {
  try {
    const [rows] = await prodPool.query("SELECT password FROM users WHERE email = ? LIMIT 1", [email]);
    if (!rows.length || !rows[0].password) return false;
    return bcrypt.compareSync(password, rows[0].password);
  } catch (err) {
    console.error("[auth] prod password check failed:", err.code || err.message);
    return false; // fail closed
  }
}
`);

// 2) Switch the login handler to async + delegated verification (username OR email)
rep(
`app.post(/auth/login, (req, res) => {
  const { username, password } = req.body;

  if (!username || !password) {
    return res.set(Content-Type, text/html).send(getLoginForm(Username and password are required));
  }

  const user = db.prepare(SELECT CHANGELOG.md CLAUDE.md CLAUDE.md.bak CastleDirectRestlet.php README.md accts.md accts2.md adlux-safety-hook after-approve.yml app artisan bianca-chat.yml bnacat.md bootstrap cc.md compose.md compose2.md composer.json composer.lock config custtab.md database details.md etr.md etr2.md flt1.md flt2.md image copy 2.png image copy 3.png image copy 4.png image copy 5.png image copy.png image.png james.md l54thread.md locarg.md logs netsuite-home.md node_modules ns-filters.md ns-scripts-all.md ns-scripts.md open1.md outlook1.yml package-lock.json package.json pdfsnap.md phpunit.xml pilar-chat.md playwright-screenshots public resources routes scripts settings.local.json snap-c68.yml snap-find.yml snap-nb.yml snap-tabs.yml snap-tabs2.yml snap_now.md storage tests thread2.md tk_may12.md vendor verify.md vite.config.js wa-bianca-result.yml wa-chat.yml wa-check.md wa-gianni.md wa-jan.yml wa-list2.yml wa-search.yml wa-search2.yml wa-search3.yml wa-unread.yml wa.md wa2.md westpac-balances.md westpac-results.txt westpac-txn.md wise-1318.txt wise-cal.md wise-filtered.md wise-filtered2.md FROM users WHERE username = ?).get(username);

  if (!user || !bcrypt.compareSync(password, user.password_hash)) {
    return res.set(Content-Type, text/html).send(getLoginForm(Invalid username or password));
  }`,
`app.post(/auth/login, async (req, res) => {
  const { username, password } = req.body;

  if (!username || !password) {
    return res.set(Content-Type, text/html).send(getLoginForm(Username and password are required));
  }

  // Accept either the bridge username or the production email as the identifier.
  const user = db.prepare(SELECT CHANGELOG.md CLAUDE.md CLAUDE.md.bak CastleDirectRestlet.php README.md accts.md accts2.md adlux-safety-hook after-approve.yml app artisan bianca-chat.yml bnacat.md bootstrap cc.md compose.md compose2.md composer.json composer.lock config custtab.md database details.md etr.md etr2.md flt1.md flt2.md image copy 2.png image copy 3.png image copy 4.png image copy 5.png image copy.png image.png james.md l54thread.md locarg.md logs netsuite-home.md node_modules ns-filters.md ns-scripts-all.md ns-scripts.md open1.md outlook1.yml package-lock.json package.json pdfsnap.md phpunit.xml pilar-chat.md playwright-screenshots public resources routes scripts settings.local.json snap-c68.yml snap-find.yml snap-nb.yml snap-tabs.yml snap-tabs2.yml snap_now.md storage tests thread2.md tk_may12.md vendor verify.md vite.config.js wa-bianca-result.yml wa-chat.yml wa-check.md wa-gianni.md wa-jan.yml wa-list2.yml wa-search.yml wa-search2.yml wa-search3.yml wa-unread.yml wa.md wa2.md westpac-balances.md westpac-results.txt westpac-txn.md wise-1318.txt wise-cal.md wise-filtered.md wise-filtered2.md FROM users WHERE username = ? OR email = ?).get(username, username);

  // Password is verified against the live production users table (single source of truth).
  if (!user || !(await verifyProdPassword(user.email, password))) {
    return res.set(Content-Type, text/html).send(getLoginForm(Invalid username or password));
  }`);

// 3) Point password resets at the production app instead of a (now-ignored) local reset
rep(
`    <div class="subtitle">Enter your email to receive a reset link</div>`,
`    <div class="subtitle">Manage your password in the Adlux Production app — the bridge uses the same login.</div>`);

if (s === orig) { console.error("NO CHANGES MADE"); process.exit(3); }
fs.writeFileSync(f, s);
console.log("Patched OK. Bytes:", orig.length, "->", s.length);
