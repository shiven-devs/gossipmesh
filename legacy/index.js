import express from "express";
import axios from "axios";
import { readFileSync } from "node:fs";
import { registerFriend, getMyFriends, getRandomKFriends } from "./state.js";

// config.json padho aur usme se node_config nikaalo
const { node_config } = JSON.parse(
  readFileSync(new URL("./config.json", import.meta.url), "utf-8")
);

const HOSTNAME = "localhost";
const PORT = parseInt(process.argv[2], 10);
const GOSSIP_INTERVAL_MS = 10 * 1000;

if (Number.isNaN(PORT)) {
  console.error("Usage: node index.js <port>   e.g. node index.js 3001");
  process.exit(1);
}

// Kya ye address main khud hoon?
function isMe(hostname, port) {
  return hostname === HOSTNAME && Number(port) === PORT;
}

// STEP 1: seed nodes ko pehle dost bana lo
for (const seed of node_config.seed_nodes) {
  if (!seed) continue;
  const [hostname, port] = seed.split(":");
  if (isMe(hostname, port)) continue;
  registerFriend(hostname, port, Date.now());
}

const app = express();
app.use(express.json());

// STEP 2: har 10 second mein k random dosto se gossip karo
async function gossipRound() {
  const targets = getRandomKFriends(2);

  for (const f of targets) {
    try {
      const result = await axios.post(
        `http://${f.hostname}:${f.port}/gossip`,
        { hostname: HOSTNAME, port: PORT },
        { timeout: 2000 }
      );

      // Usne jawab diya, matlab woh abhi zinda hai
      registerFriend(f.hostname, f.port, Date.now());

      // Uske dosto ko bhi apni list mein jodo
      const friendsOfFriend = result.data.friends ?? [];
      for (const fof of friendsOfFriend) {
        if (isMe(fof.hostname, fof.port)) continue;
        registerFriend(fof.hostname, fof.port, fof.lastPingTimestamp);
      }
    } catch (err) {
      console.log(`[${PORT}] could not reach ${f.address}: ${err.code ?? err.message}`);
    }
  }

  const list = getMyFriends().map((f) => f.address).join(", ");
  console.log(`[${PORT}] friends: ${list || "(none yet)"}`);
}

setInterval(gossipRound, GOSSIP_INTERVAL_MS);

// STEP 3: jab koi aur node humse gossip kare
app.post("/gossip", (req, res) => {
  const { hostname, port } = req.body ?? {};

  if (!hostname || !port) {
    return res.status(400).json({ error: "hostname and port are required" });
  }
  if (isMe(hostname, port)) {
    return res.status(400).json({ error: "cannot gossip self" });
  }

  const existingFriends = getMyFriends();
  registerFriend(hostname, port, Date.now());
  return res.json({ friends: existingFriends });
});

// Debugging ke liye: browser mein /friends kholo
app.get("/friends", (req, res) => {
  res.json(getMyFriends());
});

app.listen(PORT, () => {
  console.log(`Server is running on PORT ${PORT}`);
});
