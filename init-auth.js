#!/usr/bin/env node

const Database = require('better-sqlite3');
const bcrypt = require('bcryptjs');
const path = require('path');

const dbPath = path.join(__dirname, 'auth.db');
const db = new Database(dbPath);

function createSchema() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT UNIQUE NOT NULL,
      email TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS password_reset_tokens (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      token TEXT UNIQUE NOT NULL,
      expires_at DATETIME NOT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS sessions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      token TEXT UNIQUE NOT NULL,
      expires_at DATETIME NOT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    );
  `);
  console.log('✓ Database schema created');
}

function createUser(username, password, email, homePath = '/peter') {
  const passwordHash = bcrypt.hashSync(password, 10);

  try {
    const stmt = db.prepare(`
      INSERT INTO users (username, email, password_hash, home_path)
      VALUES (?, ?, ?, ?)
    `);
    const result = stmt.run(username, email, passwordHash, homePath);
    console.log(`✓ User created: ${username} (ID: ${result.lastInsertRowid}, home: ${homePath})`);
    return result.lastInsertRowid;
  } catch (err) {
    if (err.message.includes('UNIQUE constraint failed')) {
      console.log(`✗ User '${username}' already exists`);
    } else {
      throw err;
    }
  }
}

function main() {
  const args = process.argv.slice(2);

  if (args.length === 0) {
    console.log('Usage: node init-auth.js [options]');
    console.log('');
    console.log('Options:');
    console.log('  init-schema                    Initialize database schema only');
    console.log('  create-user <username> <password> <email>  Create a new user');
    console.log('  list-users                     List all users');
    process.exit(1);
  }

  const command = args[0];

  if (command === 'init-schema') {
    createSchema();
  } else if (command === 'create-user') {
    if (args.length < 4) {
      console.error('Error: create-user requires username, password, and email');
      process.exit(1);
    }
    // Parse optional --home-path flag
    let homePath = '/peter';
    const homePathIdx = args.indexOf('--home-path');
    if (homePathIdx !== -1 && homePathIdx + 1 < args.length) {
      homePath = args[homePathIdx + 1];
    }
    createSchema();
    createUser(args[1], args[2], args[3], homePath);
  } else if (command === 'list-users') {
    createSchema();
    const users = db.prepare('SELECT id, username, email, home_path, created_at FROM users').all();
    if (users.length === 0) {
      console.log('No users found');
    } else {
      console.log('Users:');
      users.forEach(user => {
        console.log(`  ${user.id}: ${user.username} (${user.email}) → ${user.home_path} - ${user.created_at}`);
      });
    }
  } else {
    console.error(`Unknown command: ${command}`);
    process.exit(1);
  }

  db.close();
}

main();
