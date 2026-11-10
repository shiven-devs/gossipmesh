/**
 * Discovery: which addresses do we try when we don't know anybody yet?
 *
 * legacy/index.js:26-31 inserted the seeds straight into the friend list as if
 * they were known members. That was a small lie: a seed is only an address we
 * hope somebody answers on - we don't know its node id, and it may well be
 * down. Here seeds stay a separate bootstrap list, and a node only becomes a
 * real member once it answers and tells us its own id.
 *
 * Two ways to get that list:
 *
 *   SEEDS     a fixed `host:port` list. Fine on a laptop and in Compose, where
 *             the set of nodes is written down in advance.
 *   SEED_DNS  the name of a Kubernetes headless Service, which resolves to one
 *             A record per pod. The seed list is then whatever is running right
 *             now, which is what lets a pod created by `kubectl scale` find the
 *             cluster, and what keeps bootstrap working when the two nodes you
 *             happened to name as seeds are the ones that died.
 */

import { promises as dnsPromises } from "node:dns";

/**
 * Addresses worth contacting this round.
 *
 * Three sources, in order of usefulness:
 *   1. live peers, chosen at random - the normal case;
 *   2. seeds, to top up fanout while we still know almost nobody;
 *   3. one member we have written off, as a revival probe.
 *
 * (3) is what makes a healed partition heal. Members marked dead are excluded
 * from normal peer selection - there is no point spending a round on a node
 * that is gone - but if that were the whole story the exclusion would be
 * permanent: two halves of a partition would each decide the other was dead
 * and then never speak again, so nothing could ever tell them otherwise. One
 * probe per round, aimed at a random written-off member, costs almost nothing
 * and makes recovery a matter of a round or two instead of luck. SWIM and
 * Cassandra keep pinging dead nodes at a reduced rate for exactly this reason.
 *
 * @param {object} options
 * @param {import("./membership.js").MemberList} options.members
 * @param {string[]} options.seeds   Bootstrap addresses.
 * @param {number} options.fanout    How many live peers we want.
 * @param {number} [options.revive]  Written-off members to re-probe.
 * @returns {Array<{id: string | null, address: string}>} id is null for a seed
 *   we have never spoken to.
 */
export function selectTargets({ members, seeds, fanout, revive = 1 }) {
  const peers = members.randomPeers(fanout);
  const targets = peers.map((peer) => ({ id: peer.id, address: peer.address }));
  const known = new Set([members.selfAddress, ...targets.map((t) => t.address)]);

  if (targets.length < fanout) {
    // Shuffled, not taken in order: the seed list from DNS is sorted by pod IP,
    // and always trying the first few would mean one side of a partition kept
    // probing its own half and never reached the other.
    for (const address of shuffle(seeds)) {
      if (targets.length >= fanout) break;
      if (known.has(address)) continue;
      targets.push({ id: null, address });
      known.add(address);
    }
  }

  // Deliberately beyond fanout: a revival probe must not take a slot away from
  // the live peers that carry the actual gossip.
  for (const entry of members.randomUnreachable(revive)) {
    if (known.has(entry.address)) continue;
    targets.push({ id: entry.id, address: entry.address });
    known.add(entry.address);
  }

  return targets;
}

/**
 * Fisher-Yates on a copy, so the caller's array is untouched.
 *
 * @param {string[]} values
 * @returns {string[]}
 */
function shuffle(values) {
  const copy = [...values];
  for (let i = copy.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy;
}

/**
 * The current seed list, from the fixed SEEDS list and/or SEED_DNS.
 *
 * Answers are cached for SEED_DNS_TTL_MS. Without that, every node would do
 * FANOUT lookups per second and CoreDNS would carry the whole cluster's
 * gossip schedule as DNS traffic - for information that changes only when a
 * pod is added or removed.
 */
export class SeedSource {
  #staticSeeds;
  #dnsName;
  #port;
  #ttlMs;
  #selfAddresses;
  #resolve;
  #now;
  #logger;

  /** @type {string[]} */
  #cache = [];
  #cachedAt = Number.NEGATIVE_INFINITY;

  /**
   * @param {object} options
   * @param {import("./config.js").Config} options.config
   * @param {import("pino").Logger} options.logger
   * @param {(name: string) => Promise<string[]>} [options.resolve] Injectable
   *   for tests; defaults to a DNS A-record lookup.
   * @param {() => number} [options.now] Monotonic clock, for the cache.
   */
  constructor({ config, logger, resolve = (name) => dnsPromises.resolve4(name), now = Date.now }) {
    this.#staticSeeds = config.seeds;
    this.#dnsName = config.seedDns;
    this.#port = config.port;
    this.#ttlMs = config.seedDnsTtlMs;
    // A headless Service resolves to every pod's IP, our own included. Both
    // spellings of "us" are filtered: the advertised name and the pod IP.
    this.#selfAddresses = new Set(
      [config.address, config.podIp ? `${config.podIp}:${config.port}` : null].filter(Boolean),
    );
    this.#resolve = resolve;
    this.#now = now;
    this.#logger = logger;
  }

  /**
   * @returns {Promise<string[]>} seed addresses to try this round.
   */
  async addresses() {
    if (!this.#dnsName) return this.#staticSeeds;

    const now = this.#now();
    if (now - this.#cachedAt < this.#ttlMs) {
      return dedupe([...this.#staticSeeds, ...this.#cache]);
    }

    try {
      const records = await this.#resolve(this.#dnsName);
      this.#cache = records
        .map((ip) => `${ip}:${this.#port}`)
        .filter((address) => !this.#selfAddresses.has(address));
      this.#cachedAt = now;

      this.#logger.debug(
        { name: this.#dnsName, peers: this.#cache.length },
        "resolved seeds from DNS",
      );
    } catch (err) {
      // A DNS failure is survivable: keep the previous answer, and fall back to
      // the static list. A node already in the cluster does not need seeds at
      // all - it has peers - so this must never be fatal.
      this.#cachedAt = now;
      this.#logger.warn(
        { name: this.#dnsName, err: err.code ?? err.message },
        "seed DNS lookup failed, using the last answer",
      );
    }

    return dedupe([...this.#staticSeeds, ...this.#cache]);
  }
}

/**
 * @param {string[]} values
 * @returns {string[]}
 */
function dedupe(values) {
  return [...new Set(values)];
}
