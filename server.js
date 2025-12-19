import express from "express";
import cors from "cors";
import { Connection, PublicKey } from "@solana/web3.js";
import nacl from "tweetnacl";
import Database from "better-sqlite3";

// ---- CONFIG ----
const PORT = process.env.PORT || 4000;
const SOLANA_RPC_URL =
  process.env.SOLANA_RPC_URL || "https://api.mainnet-beta.solana.com";
const TOKEN_MINT = process.env.TOKEN_MINT; // set to your mint (same as in frontend)
const MAX_ROOMS = 80; // how many rooms to show
const LANDLORD_TOP_N = 10;

// ---- SETUP ----
if (!TOKEN_MINT) {
  console.error("TOKEN_MINT environment variable is required");
  process.exit(1);
}

const connection = new Connection(SOLANA_RPC_URL, "confirmed");
const mintPubkey = new PublicKey(TOKEN_MINT);

const app = express();
app.use(cors());
app.use(express.json());

// SQLite for name registry
const db = new Database("rentfree.db");
db.exec(`
  CREATE TABLE IF NOT EXISTS display_names (
    wallet TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    updated_at INTEGER NOT NULL
  );
`);

const upsertNameStmt = db.prepare(`
  INSERT INTO display_names (wallet, name, updated_at)
  VALUES (@wallet, @name, @updated_at)
  ON CONFLICT(wallet) DO UPDATE SET
    name = excluded.name,
    updated_at = excluded.updated_at;
`);

const getNameStmt = db.prepare(
  "SELECT name FROM display_names WHERE wallet = ?"
);

function hashToRoom(wallet, maxRooms) {
  // simple deterministic hash -> 1..maxRooms
  let hash = 0;
  for (let i = 0; i < wallet.length; i++) {
    hash = (hash * 31 + wallet.charCodeAt(i)) >>> 0;
  }
  return (hash % maxRooms) + 1;
}

// ---- ROUTES ----

// GET /api/rooms?mint=<optional override>
app.get("/api/rooms", async (req, res) => {
  try {
    const mint = req.query.mint ? new PublicKey(req.query.mint) : mintPubkey;

    // SPL Token Program ID
    const TOKEN_PROGRAM_ID = new PublicKey(
      "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"
    );

    const accounts = await connection.getProgramAccounts(TOKEN_PROGRAM_ID, {
      filters: [
        { dataSize: 165 }, // token account size
        {
          memcmp: {
            offset: 0, // mint is at start of account data
            bytes: mint.toBase58()
          }
        }
      ]
    });

    // Decode balances manually from account data layout
    const holdersMap = new Map();
    for (const { account, pubkey } of accounts) {
      const data = account.data;
      // amount is at offset 64 (u64 little-endian) in SPL Token account
      const amountBytes = data.slice(64, 72);
      let amount = 0n;
      for (let i = 0; i < 8; i++) {
        amount |= BigInt(amountBytes[i]) << (8n * BigInt(i));
      }
      if (amount === 0n) continue;

      const ownerPubkey = new PublicKey(data.slice(32, 64)).toBase58();
      const current = holdersMap.get(ownerPubkey) || 0n;
      holdersMap.set(ownerPubkey, current + amount);
    }

    let holders = Array.from(holdersMap.entries()).map(([wallet, balance]) => ({
      walletAddress: wallet,
      balance: Number(balance) // assumes non-insane decimals; adjust if needed
    }));

    // sort by balance desc, take top MAX_ROOMS
    holders.sort((a, b) => b.balance - a.balance);
    const top = holders.slice(0, MAX_ROOMS);

    const withRooms = top.map((h, index) => {
      const role = index < LANDLORD_TOP_N ? "Landlord" : "Tenant";
      const roomNumber = hashToRoom(h.walletAddress, MAX_ROOMS);
      const nameRow = getNameStmt.get(h.walletAddress);
      const displayName = nameRow ? nameRow.name : null;
      // you might want to divide by 10**decimals here to show human balance
      return {
        walletAddress: h.walletAddress,
        roomNumber,
        role,
        balance: h.balance.toString(),
        displayName
      };
    });

    res.json({ rooms: withRooms });
  } catch (err) {
    console.error("Error in /api/rooms:", err);
    res.status(500).json({ error: "Failed to load rooms" });
  }
});

// POST /api/display-name
// { walletAddress, displayName, message, signature: number[] }
app.post("/api/display-name", (req, res) => {
  try {
    const { walletAddress, displayName, message, signature } = req.body || {};
    if (!walletAddress || !displayName || !message || !signature) {
      return res.status(400).json({ error: "Missing fields" });
    }

    if (!message.startsWith("RENTFREE_NAME_UPDATE_V1:")) {
      return res.status(400).json({ error: "Invalid message prefix" });
    }

    if (displayName.length < 1 || displayName.length > 24) {
      return res.status(400).json({ error: "Invalid name length" });
    }

    const pubkey = new PublicKey(walletAddress);
    const msgBytes = new TextEncoder().encode(message);
    const sigBytes = new Uint8Array(signature);

    const isValid = nacl.sign.detached.verify(
      msgBytes,
      sigBytes,
      pubkey.toBytes()
    );

    if (!isValid) {
      return res.status(401).json({ error: "Signature verification failed" });
    }

    upsertNameStmt.run({
      wallet: walletAddress,
      name: displayName,
      updated_at: Date.now()
    });

    res.json({ ok: true, walletAddress, displayName });
  } catch (err) {
    console.error("Error in /api/display-name:", err);
    res.status(500).json({ error: "Failed to save display name" });
  }
});

app.listen(PORT, () => {
  console.log(`RENTFREE backend listening on port ${PORT}`);
});
