const bcrypt = require('bcryptjs');
const Database = require('better-sqlite3');

const db = new Database('./auth.db');

// Create hassan
const hasanHash = bcrypt.hashSync('TestPassword123', 10);
const hasanStmt = db.prepare('INSERT OR IGNORE INTO users (username, email, password_hash, home_path) VALUES (?, ?, ?, ?)');
hasanStmt.run('hassan', 'hassan@castle-global.com', hasanHash, '/hassan');
console.log('✓ Hassan created');

// Create user3
const user3Hash = bcrypt.hashSync('TestPassword456', 10);
const user3Stmt = db.prepare('INSERT OR IGNORE INTO users (username, email, password_hash, home_path) VALUES (?, ?, ?, ?)');
user3Stmt.run('user3', 'user3@castle-global.com', user3Hash, '/user3');
console.log('✓ User3 created');

// List all users
const users = db.prepare('SELECT id, username, email, home_path FROM users').all();
console.log('\nAll users:');
users.forEach(u => {
  console.log(`  ${u.id}: ${u.username} (${u.email}) → ${u.home_path}`);
});

db.close();
