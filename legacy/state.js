// KNOWN_FRIENDS = is node ki "address book"
// key   -> "hostname:port"  (jaise "localhost:3002")
// value -> { hostname, port, lastPingTimestamp }
const KNOWN_FRIENDS = new Map();

export function registerFriend(hostname, port, lastPingTimestamp) {
  const key = `${hostname}:${port}`;
  const existing = KNOWN_FRIENDS.get(key);

  // Purani khabar se nayi khabar overwrite mat karo
  if (existing && existing.lastPingTimestamp >= lastPingTimestamp) {
    return;
  }

  KNOWN_FRIENDS.set(key, {
    hostname,
    port: Number(port),
    lastPingTimestamp,
  });
}

export function getMyFriends() {
  const friends = [];
  for (const [key, value] of KNOWN_FRIENDS.entries()) {
    friends.push({
      address: key,
      hostname: value.hostname,
      port: value.port,
      lastPingTimestamp: value.lastPingTimestamp,
    });
  }
  return friends;
}

export function getRandomKFriends(k = 2) {
  const allFriends = getMyFriends();

  // Fisher-Yates shuffle: list ko randomly mix karo
  for (let i = allFriends.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [allFriends[i], allFriends[j]] = [allFriends[j], allFriends[i]];
  }

  // Shuffle ke baad pehle k utha lo (duplicate kabhi nahi aayega)
  return allFriends.slice(0, k);
}
