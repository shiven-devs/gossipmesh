/**
 * The whole UI: poll one endpoint, redraw.
 *
 * No framework and no build step on purpose. The page reads /api/cluster once
 * per second and rebuilds the matrix from it, which keeps the only piece of
 * state in the browser the last response - nothing to get out of sync.
 *
 * The matrix is the point of the page: one row per observer, one column per
 * member, each cell that observer's own verdict. During a partition the rows
 * split into blocks; after a heal they go green again within a round or two.
 */

const STATUS_LABELS = {
  alive: "alive",
  suspect: "suspect",
  dead: "dead",
  left: "left",
  buried: "buried",
  unknown: "not heard of yet",
};

const els = {
  pollState: document.getElementById("poll-state"),
  broadcast: document.getElementById("broadcast"),
  tiles: document.getElementById("tiles"),
  legend: document.getElementById("legend"),
  matrix: document.querySelector("#matrix tbody"),
  rumors: document.getElementById("rumors"),
  footer: document.getElementById("footer-note"),
};

let pollIntervalMs = 1000;
let failures = 0;

drawLegend();

els.broadcast.addEventListener("click", async () => {
  els.broadcast.disabled = true;
  els.broadcast.textContent = "Broadcasting…";
  try {
    const res = await fetch("/api/broadcast", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ payload: { msg: "hello from the dashboard", at: new Date().toISOString() } }),
    });
    const body = await res.json();
    els.broadcast.textContent = res.ok ? `Sent via ${body.target}` : `Failed: ${body.error ?? res.status}`;
  } catch (err) {
    els.broadcast.textContent = `Failed: ${err.message}`;
  }
  setTimeout(() => {
    els.broadcast.disabled = false;
    els.broadcast.textContent = "Broadcast a rumor";
  }, 1500);
});

async function tick() {
  try {
    const res = await fetch("/api/cluster");
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();

    pollIntervalMs = data.pollIntervalMs ?? pollIntervalMs;
    failures = 0;
    render(data);
  } catch (err) {
    failures += 1;
    // The dashboard being unreachable says nothing about the cluster, so this
    // is reported as a dashboard problem rather than as nodes going down.
    els.pollState.className = "pill broken";
    els.pollState.textContent = `dashboard unreachable (${failures}): ${err.message}`;
  } finally {
    setTimeout(tick, pollIntervalMs);
  }
}

tick();

function render(data) {
  const { summary, columns, rows, rumors } = data;

  els.pollState.className = "pill live";
  els.pollState.textContent =
    `polling ${summary.observersReachable}/${summary.observers} nodes every ${data.pollIntervalMs} ms`;

  drawTiles(summary);
  drawMatrix(columns, rows);
  drawRumors(rumors, summary.members);

  els.footer.textContent =
    `Snapshot ${new Date(data.generatedAt).toLocaleTimeString()} · ` +
    `polling ${data.polling.join(", ")}`;
}

function drawTiles(summary) {
  const worst = summary.worstCase ?? {};
  const tiles = [
    { label: "Nodes answering", value: `${summary.observersReachable}/${summary.observers}`,
      tone: summary.observersReachable === summary.observers ? "good" : "bad" },
    { label: "Members known", value: summary.members, tone: "" },
    // The single most informative number here: how many members the cluster
    // does not yet agree about. Nonzero while converging, zero once settled.
    { label: "Columns in disagreement", value: summary.disagreements,
      tone: summary.disagreements === 0 ? "good" : "warn" },
    { label: "Someone calls suspect", value: worst.suspect ?? 0,
      tone: (worst.suspect ?? 0) > 0 ? "warn" : "" },
    { label: "Someone calls dead", value: worst.dead ?? 0,
      tone: (worst.dead ?? 0) > 0 ? "bad" : "" },
    { label: "Left gracefully", value: worst.left ?? 0, tone: "" },
  ];

  els.tiles.replaceChildren(
    ...tiles.map(({ label, value, tone }) => {
      const tile = document.createElement("div");
      tile.className = `tile ${tone}`.trim();
      tile.append(div("label", label), div("value", String(value)));
      return tile;
    }),
  );
}

function drawMatrix(columns, rows) {
  const head = document.createElement("tr");
  head.append(th("observer \\ member", "observer"));
  for (const id of columns) head.append(th(id, "col"));

  const body = rows.map((row) => {
    const tr = document.createElement("tr");
    if (!row.reachable) tr.className = "stale";

    const label = th(row.observer, "observer");
    label.title = row.reachable
      ? `${row.address}, polled ${row.ageMs} ms ago`
      : `${row.address}: ${row.error}`;
    tr.append(label);

    for (const cell of row.cells) {
      const td = document.createElement("td");
      td.className = `${cell.status}${cell.self ? " self" : ""}`;

      // Heartbeat in the cell: a number that climbs is the clearest possible
      // proof the member is still running, and a frozen one shows why the
      // verdict is about to change.
      td.textContent = cell.heartbeat === undefined ? "–" : String(cell.heartbeat);

      const parts = [`${row.observer} sees ${cell.id}: ${STATUS_LABELS[cell.status] ?? cell.status}`];
      if (cell.selfStatus) parts.push(`${cell.id} says it is "${cell.selfStatus}"`);
      if (cell.generation !== undefined) parts.push(`generation ${cell.generation}`);
      if (cell.self) parts.push("this is the observer's own entry");
      td.title = parts.join("\n");

      tr.append(td);
    }
    return tr;
  });

  els.matrix.replaceChildren(head, ...body);
}

function drawRumors(rumors, clusterSize) {
  if (!rumors || rumors.length === 0) {
    const empty = document.createElement("div");
    empty.className = "empty";
    empty.textContent = "No rumors yet. Press “Broadcast a rumor” and watch it reach every node.";
    els.rumors.replaceChildren(empty);
    return;
  }

  els.rumors.replaceChildren(
    ...rumors.slice(0, 8).map((rumor) => {
      const card = document.createElement("div");
      card.className = "rumor";

      const top = document.createElement("div");
      top.className = "top";

      const left = document.createElement("div");
      const id = document.createElement("code");
      id.textContent = rumor.id.slice(0, 8);
      left.append(id, document.createTextNode(` from ${rumor.origin}`));

      const meta = div(
        "meta",
        [
          `${rumor.holderCount}/${rumor.clusterSize || clusterSize} nodes`,
          rumor.observedSpreadMs === null
            ? `spread: ${rumor.spreadNote}`
            : `spread (dashboard clock): ${rumor.observedSpreadMs} ms`,
          `max hops: ${rumor.maxHops}`,
        ].join(" · "),
      );

      top.append(left, meta);

      const bar = document.createElement("div");
      bar.className = "bar";
      // One segment per holder, in the order THIS dashboard first saw them -
      // which is the only ordering it can honestly claim.
      for (const holder of rumor.holders) {
        const seg = document.createElement("div");
        seg.className = "seg has";
        seg.textContent = `${holder.nodeId} · ${holder.hops}h`;
        seg.title =
          `${holder.nodeId}: ${holder.hops} hops from the origin\n` +
          `first seen holding it by the dashboard at ${new Date(holder.observedAt).toLocaleTimeString()}\n` +
          `the node's own receivedAt: ${new Date(holder.receivedAt).toLocaleTimeString()} (its clock, display only)`;
        bar.append(seg);
      }

      const payload = div("meta", `payload: ${JSON.stringify(rumor.payload)}`);
      card.append(top, bar, payload);
      return card;
    }),
  );
}

function drawLegend() {
  els.legend.replaceChildren(
    ...Object.entries(STATUS_LABELS).map(([status, label]) => {
      const wrap = document.createElement("span");
      const swatch = document.createElement("span");
      swatch.className = "swatch";
      swatch.style.background = `var(--${status})`;
      wrap.append(swatch, document.createTextNode(label));
      return wrap;
    }),
  );
}

function div(className, text) {
  const el = document.createElement("div");
  el.className = className;
  el.textContent = text;
  return el;
}

function th(text, className) {
  const el = document.createElement("th");
  el.className = className;
  el.textContent = text;
  return el;
}
