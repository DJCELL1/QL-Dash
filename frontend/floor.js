/* Factory floor tool.
 *
 * Deliberately its own page rather than a phone layout of the dashboard: the
 * people using this want one job — find my door, say how many I've done — and
 * nothing else on screen. It talks to the same API and the same database, so
 * anything ticked here shows on the dashboard straight away.
 */
(function () {
  "use strict";

  const $ = (sel) => document.querySelector(sel);

  const STAGE_LABELS = {
    picking: "Picking",
    machining: "Machining",
    build_wrap: "Build/Wrap",
    cav_prep: "Prep",
    cav_make: "Make",
    pc_pick: "Picking material",
    pc_prep: "Prep",
    pc_coat: "Coat",
    pc_pack: "Pack",
  };

  // The three lines the floor works, each read and ticked through its own pair
  // of endpoints, the same ones the dashboard's Factory floor tab uses.
  const LINES = {
    doors: {
      url: "/api/factory", progress: "/api/factory/progress",
      stages: ["picking", "machining", "build_wrap"], unit: ["door", "doors"],
    },
    cavities: {
      url: "/api/cavities", progress: "/api/cavities/progress",
      stages: ["cav_prep", "cav_make"], unit: ["unit", "units"],
    },
    powdercoat: {
      url: "/api/powdercoat", progress: "/api/powdercoat/progress",
      stages: ["pc_pick", "pc_prep", "pc_coat", "pc_pack"], unit: ["item", "items"],
    },
  };

  const savedLine = (() => {
    try { return localStorage.getItem("floorAppLine"); } catch (e) { return null; }
  })();
  const line = () => LINES[state.line] || LINES.doors;
  const unitWord = (n) => (n === 1 ? line().unit[0] : line().unit[1]);

  // Glazing and edge stripping only apply to doors whose description carries
  // the marker, so the server sends each job its own list and the card follows
  // that rather than assuming four.
  function stagesOf(row) {
    const keys = (row && row.stages && row.stages.length ? row.stages : line().stages)
      .filter((k) => STAGE_LABELS[k]);
    return keys.map((key) => ({ key, label: STAGE_LABELS[key] }));
  }

  const state = {
    line: LINES[savedLine] ? savedLine : "doors",
    work: [],        // who's started what, from /api/work/active
    rows: [],
    todayPros: new Set(),
    scope: "today",
    query: "",
    openPro: null,
    hitPro: null, // briefly outlined after a scan
    busy: new Set(), // "PRO|stage" while saving
    user: null,      // signed-in name; null means read only
  };

  // ---------- data ----------

  async function getJSON(url) {
    const res = await fetch(url, { headers: { Accept: "application/json" } });
    if (!res.ok) throw new Error(`${url} → ${res.status}`);
    return res.json();
  }

  function todayKey() {
    const d = new Date();
    const p = (n) => String(n).padStart(2, "0");
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
  }

  async function load() {
    const ln = line();
    const [data, schedule, subs, work] = await Promise.all([
      getJSON(ln.url).catch(() => ({ rows: [] })),
      // Not fatal — without it "Today" is simply empty and All open still works.
      getJSON("/api/schedule").catch(() => ({ entries: [] })),
      state.line === "powdercoat" ? getJSON("/api/subcontractors").catch(() => ({ jobs: [] })) : null,
      getJSON("/api/work/active").catch(() => ({ sessions: [] })),
    ]);
    state.rows = data.rows || [];
    state.work = work.sessions || [];
    state.paused = work.paused || [];
    const key = todayKey();
    // Powdercoat jobs carry their day on the job itself; doors and cavities
    // are booked in the schedule.
    state.todayPros = new Set(
      subs
        ? (subs.jobs || []).filter((j) => (j.scheduled_date || "").slice(0, 10) === key).map((j) => j.prod_order_no)
        : (schedule.entries || []).filter((e) => e.scheduled_date === key).map((e) => e.prod_order_no)
    );
  }

  function pausedOn(pro, stage) {
    return (state.paused || []).find((s) => s.prod_order_no === pro && s.stage === stage) || null;
  }

  async function refreshWork() {
    const w = await getJSON("/api/work/active").catch(() => null);
    if (w) {
      state.work = w.sessions || [];
      state.paused = w.paused || [];
    }
  }

  function workOn(pro, stage) {
    return state.work.filter((s) => s.prod_order_no === pro && s.stage === stage);
  }

  const isMine = (s) => state.user && s.username.toLowerCase() === state.user.toLowerCase();

  function clockOf(iso) {
    const d = new Date(iso);
    return Number.isNaN(d.getTime()) ? "" : d.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
  }

  // ---------- helpers ----------

  const num = (v) => (Number.isInteger(v) ? String(v) : String(Math.round(v * 100) / 100));

  function doneFor(row, stage) {
    return row[`${stage}_done`] || 0;
  }

  function dueLabel(row) {
    if (!row.due_date) return null;
    // The API sends "2026-08-11 00:00:00" — slice to the date so it parses the
    // same way in every browser rather than becoming an Invalid Date.
    const due = new Date(String(row.due_date).slice(0, 10) + "T00:00:00");
    if (Number.isNaN(due.getTime())) return null;
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const days = Math.round((due - today) / 86400000);
    const date = due.toLocaleDateString(undefined, { day: "numeric", month: "short" });
    if (days < 0) return { text: `${Math.abs(days)}d overdue`, late: true };
    if (days === 0) return { text: "Due today", late: true };
    return { text: `Due ${date}`, late: false };
  }

  function visibleRows() {
    const q = state.query.trim().toUpperCase();
    let rows = state.rows;

    if (q) {
      // A scan lands here as the full PRO. Search everything when one is typed,
      // so a job that isn't on today's list can still be found and ticked off.
      rows = rows.filter((r) =>
        [r.prod_order_no, r.sales_order_no, r.source_name, r.item_summary]
          .filter(Boolean)
          .some((v) => String(v).toUpperCase().includes(q))
      );
    } else if (state.scope === "today") {
      rows = rows.filter((r) => state.todayPros.has(r.prod_order_no) && r.status !== "completed");
    } else if (state.scope === "open") {
      rows = rows.filter((r) => r.status !== "completed");
    } else {
      rows = rows.filter((r) => r.status === "completed");
    }

    return rows.sort((a, b) => {
      if ((a.status === "completed") !== (b.status === "completed")) {
        return a.status === "completed" ? 1 : -1;
      }
      return (a.due_date || "9999").localeCompare(b.due_date || "9999");
    });
  }

  // ---------- render ----------

  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"]/g, (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c])
    );
  }

  function render() {
    const rows = visibleRows();
    const listEl = $("#list");
    const emptyEl = $("#empty");

    const doors = rows.reduce((s, r) => s + (r.total_qty || 0), 0);
    $("#summary").textContent = rows.length
      ? `${rows.length} ${rows.length === 1 ? "job" : "jobs"} · ${num(doors)} ${unitWord(doors)}`
      : "";

    // Headline for the wall screen: what's being worked on right now, then how
    // far today's list is through its last step.
    const last = line().stages[line().stages.length - 1];
    const through = rows.reduce((s, r) => s + Math.min(doneFor(r, last), r.total_qty || 0), 0);
    const working = new Set(state.work.filter((s) => line().stages.includes(s.stage)).map((s) => s.prod_order_no)).size;
    $("#headline").textContent = rows.length
      ? `${working ? `▶ ${working} in progress · ` : ""}${num(through)} of ${num(doors)} finished`
      : "";

    if (!rows.length) {
      listEl.innerHTML = "";
      emptyEl.hidden = false;
      emptyEl.textContent = state.query
        ? `Nothing found for “${state.query}”. Check the number on the job card.`
        : state.scope === "today"
        ? "Nothing scheduled for today yet."
        : state.scope === "done"
        ? "No finished jobs yet."
        : "No open jobs.";
      return;
    }

    emptyEl.hidden = true;
    listEl.innerHTML = rows.map(jobHTML).join("");
    wireList();
  }

  function jobHTML(row) {
    const open = state.openPro === row.prod_order_no;
    const complete = row.status === "completed";
    const due = dueLabel(row);
    const pct = Math.max(0, Math.min(100, row.pct_complete || 0));

    const cls = [
      "job",
      open ? "is-open" : "",
      complete ? "is-done" : "",
      state.hitPro === row.prod_order_no ? "is-hit" : "",
    ].filter(Boolean).join(" ");

    return `<section class="${cls}" id="job-${esc(row.prod_order_no)}">
      <button type="button" class="job-head" data-pro="${esc(row.prod_order_no)}"
              aria-expanded="${open ? "true" : "false"}">
        <span class="job-pro">${esc(row.prod_order_no)}</span>
        <span class="job-qty">${num(row.total_qty)} ${unitWord(row.total_qty)}</span>
        <span class="job-customer">${esc(row.source_name || "Stock")}</span>
        <span class="job-item">${esc(row.item_summary || "")}</span>
        <span class="job-meta">
          ${row.sales_order_no ? `<span class="pill">${esc(row.sales_order_no)}</span>` : ""}
          ${due ? `<span class="pill ${due.late ? "late" : ""}">${esc(due.text)}</span>` : ""}
          ${complete ? '<span class="pill done">✓ Finished</span>' : ""}
          ${stagesOf(row).filter((s) => workOn(row.prod_order_no, s.key).length)
            .map((s) => `<span class="pill working">▶ ${esc(s.label)}</span>`).join("")}
        </span>
        <span class="job-stages">${stagesOf(row).map((s) => stageChipHTML(row, s)).join("")}</span>
      </button>
      <div class="job-strip"><span style="width:${pct}%"></span></div>
      ${open ? `<div class="stages">${stagesOf(row).map((s, i) => stageHTML(row, s, i)).join("")}</div>` : ""}
    </section>`;
  }

  // Read-at-a-distance summary of where a job is up to. Hidden on a phone,
  // where the screen is inches away and the tap-to-open panel does this job.
  function stageChipHTML(row, stage) {
    const total = row.total_qty || 0;
    const done = doneFor(row, stage.key);
    const state = done <= 0 ? "none" : done >= total ? "full" : "part";
    const pct = total > 0 ? Math.min(100, (done / total) * 100) : 0;
    return `<span class="chip is-${state}">
      <span class="chip-fill" style="width:${pct}%"></span>
      <span class="chip-text">${stage.label}<b>${num(done)}/${num(total)}</b></span>
    </span>`;
  }

  // One button per step. Start on a step finishes every step before it, so the
  // job moves along as the floor does; the last step, once started, finishes
  // the job. Part quantities are kept to the dashboard's Factory floor tab.
  function stageHTML(row, stage, index) {
    const steps = stagesOf(row);
    const total = row.total_qty || 0;
    const done = doneFor(row, stage.key);
    const complete = total > 0 && done >= total;
    const busy = state.busy.has(row.prod_order_no);
    const on = workOn(row.prod_order_no, stage.key);
    const last = index === steps.length - 1;
    const part = !complete && done > 0 ? `<span class="stage-count">${num(done)} / ${num(total)}</span>` : "";

    // Start, then Pause while you're on it, Resume to carry on. The last step
    // also has Finish once it's going.
    const mine = on.some(isMine);
    const paused = !on.length ? pausedOn(row.prod_order_no, stage.key) : null;
    const btn = (work, text, cls) =>
      `<button type="button" class="work-btn ${cls || ""}" data-work="${work}" ${busy ? "disabled" : ""}>${text}</button>`;
    let action;
    if (complete) {
      action = '<span class="stage-done">✓ Done</span>';
    } else if (on.length) {
      action = (mine ? btn("pause", "⏸ Pause", "is-pause") : "") + (last ? btn("finish", "■ Finish", "is-finish") : "");
    } else if (paused) {
      action = btn("start", "▶ Resume");
    } else {
      action = btn("start", "▶ Start");
    }
    const who = on.length
      ? `<span class="work-who">▶ ${esc(on.map((s) => (isMine(s) ? "You" : s.username)).join(", "))} since ${esc(clockOf(on[0].started_at))}</span>`
      : paused
        ? `<span class="work-who is-paused">⏸ Paused by ${esc(isMine(paused) ? "you" : paused.username)} at ${esc(clockOf(paused.ended_at))}</span>`
        : "";

    return `<div class="stage ${complete ? "is-complete" : ""} ${on.length ? "is-working" : ""}"
                 data-pro="${esc(row.prod_order_no)}" data-stage="${stage.key}">
      <div class="stage-top">
        <span class="stage-name">${stage.label}</span>
        ${part}
      </div>
      <div class="work-row">${action}${who}</div>
    </div>`;
  }

  // ---------- interaction ----------

  function wireList() {
    document.querySelectorAll(".job-head").forEach((btn) => {
      btn.addEventListener("click", () => {
        const pro = btn.dataset.pro;
        state.openPro = state.openPro === pro ? null : pro;
        state.hitPro = null;
        render();
      });
    });

    document.querySelectorAll(".stage .work-btn").forEach((btn) => {
      const el = btn.closest(".stage");
      const row = state.rows.find((r) => r.prod_order_no === el.dataset.pro);
      if (!row) return;
      btn.addEventListener("click", () =>
        btn.dataset.work === "pause" ? pause(row, el.dataset.stage) : advance(row, el.dataset.stage, btn.dataset.work === "finish"));
    });
  }

  async function advance(row, stage, finish) {
    const steps = stagesOf(row);
    const index = steps.findIndex((s) => s.key === stage);
    const total = row.total_qty || 0;
    // Starting further on than the next step finishes more than one; say so.
    const skipped = steps.slice(0, index).filter((s) => doneFor(row, s.key) < total);
    if (!finish && skipped.length > 1 &&
        !confirm(`Starting ${steps[index].label} marks ${skipped.map((s) => s.label).join(" and ")} as done. Carry on?`)) return;

    const key = row.prod_order_no;
    if (state.busy.has(key)) return;
    state.busy.add(key);
    render();
    try {
      const res = await fetch("/api/work/advance", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ prod_order_no: row.prod_order_no, stage, finish }),
      });
      const body = await res.json().catch(() => ({}));
      if (res.status === 401) {
        openSignIn();
        throw new Error("Sign in first, so we know who's on it.");
      }
      if (!res.ok) throw new Error(body.detail || "Couldn't save that.");

      for (const s of steps) {
        if (body.progress && body.progress[`${s.key}_done`] != null) row[`${s.key}_done`] = body.progress[`${s.key}_done`];
      }
      const sum = steps.reduce((t, s) => t + doneFor(row, s.key), 0);
      row.pct_complete = total > 0 ? Math.round((sum / (total * steps.length)) * 1000) / 10 : 0;
      row.status = total > 0 && doneFor(row, steps[steps.length - 1].key) >= total ? "completed" : "in_production";
      await refreshWork();

      const label = STAGE_LABELS[stage] || stage;
      toast(`${row.prod_order_no} · ${finish ? `${label} finished` : `${label} started`}`, "good");
    } catch (err) {
      toast(err.message, "bad");
    } finally {
      state.busy.delete(key);
      render();
    }
  }

  async function pause(row, stage) {
    const key = row.prod_order_no;
    if (state.busy.has(key)) return;
    state.busy.add(key);
    render();
    try {
      const res = await fetch("/api/work/pause", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ prod_order_no: row.prod_order_no, stage }),
      });
      const body = await res.json().catch(() => ({}));
      if (res.status === 401) {
        openSignIn();
        throw new Error("Sign in first, so we know who's on it.");
      }
      if (!res.ok) throw new Error(body.detail || "Couldn't save that.");
      await refreshWork();
      toast(`${row.prod_order_no} · ${STAGE_LABELS[stage] || stage} paused`, "good");
    } catch (err) {
      toast(err.message, "bad");
    } finally {
      state.busy.delete(key);
      render();
    }
  }

  let toastTimer = null;
  function toast(message, kind) {
    const el = $("#toast");
    el.textContent = message;
    el.className = `toast ${kind || ""}`;
    el.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { el.hidden = true; }, kind === "bad" ? 5000 : 2200);
  }

  // ---------- scanning ----------

  // A scan gun is just a keyboard: it types the PRO and presses Enter into
  // whatever has focus. So the plain text box handles hardware scanners with no
  // extra work, and the camera below is only for phones without one.
  function applyScan(text) {
    const value = String(text || "").trim().toUpperCase();
    if (!value) return;

    $("#scan").value = value;
    state.query = value;

    const matches = visibleRows();
    if (matches.length === 1) {
      state.openPro = matches[0].prod_order_no;
      state.hitPro = matches[0].prod_order_no;
    } else {
      state.openPro = null;
      state.hitPro = null;
    }
    render();

    if (matches.length === 1) {
      const el = document.getElementById(`job-${matches[0].prod_order_no}`);
      if (el) el.scrollIntoView({ block: "center", behavior: "smooth" });
    } else if (matches.length === 0) {
      toast(`No job found for ${value}`, "bad");
    }
  }

  function wireScan() {
    const input = $("#scan");
    let debounce = null;

    input.addEventListener("input", () => {
      clearTimeout(debounce);
      debounce = setTimeout(() => {
        state.query = input.value;
        state.hitPro = null;
        render();
      }, 120);
    });

    input.addEventListener("keydown", (e) => {
      if (e.key !== "Enter") return;
      e.preventDefault();
      clearTimeout(debounce);
      applyScan(input.value);
      input.blur(); // a scan gun sends Enter — drop the keyboard so the job is visible
    });

    document.querySelectorAll("#lineToggle .seg").forEach((btn) => {
      btn.classList.toggle("is-active", btn.dataset.line === state.line);
      btn.addEventListener("click", () => {
        if (btn.dataset.line === state.line) return;
        state.line = btn.dataset.line;
        try { localStorage.setItem("floorAppLine", state.line); } catch (e) { /* private mode */ }
        document.querySelectorAll("#lineToggle .seg").forEach((b) => b.classList.toggle("is-active", b === btn));
        state.rows = [];
        state.openPro = null;
        state.hitPro = null;
        render();
        load().then(render).catch(() => toast("Couldn't load that line.", "bad"));
      });
    });

    document.querySelectorAll("#scope .seg").forEach((btn) => {
      btn.addEventListener("click", () => {
        document.querySelectorAll("#scope .seg").forEach((b) => b.classList.remove("is-active"));
        btn.classList.add("is-active");
        state.scope = btn.dataset.scope;
        state.query = "";
        input.value = "";
        state.openPro = null;
        state.hitPro = null;
        render();
      });
    });
  }

  // ---------- camera ----------

  let stream = null;
  let scanLoop = null;

  async function openCamera() {
    const overlay = $("#camera");
    const video = $("#video");
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: "environment" },
      });
      video.srcObject = stream;
      await video.play();
      overlay.hidden = false;

      const detector = new window.BarcodeDetector({
        formats: ["code_128", "code_39", "ean_13", "qr_code", "codabar", "itf"],
      });

      scanLoop = setInterval(async () => {
        try {
          const found = await detector.detect(video);
          if (found && found.length) {
            const value = found[0].rawValue;
            closeCamera();
            applyScan(value);
          }
        } catch (e) {
          /* a dropped frame is normal — keep looking */
        }
      }, 300);
    } catch (err) {
      closeCamera();
      toast("Couldn't open the camera. Type the PRO instead.", "bad");
    }
  }

  function closeCamera() {
    clearInterval(scanLoop);
    scanLoop = null;
    if (stream) {
      stream.getTracks().forEach((t) => t.stop());
      stream = null;
    }
    $("#video").srcObject = null;
    $("#camera").hidden = true;
  }

  function wireCamera() {
    // Only offer it where the browser can actually read a barcode. Chrome on
    // Android can; Safari on iOS can't, and there a scan gun or typing is the
    // way in rather than a button that leads nowhere.
    if (!("BarcodeDetector" in window) || !navigator.mediaDevices) return;
    const btn = $("#cameraBtn");
    btn.hidden = false;
    btn.addEventListener("click", openCamera);
    $("#cameraClose").addEventListener("click", closeCamera);
  }

  // ---------- signing in ----------

  async function loadWhoAmI() {
    try {
      const me = await getJSON("/api/me");
      state.user = me.username || null;
    } catch (e) {
      state.user = null;
    }
    paintSignedIn();
  }

  function paintSignedIn() {
    const signedIn = !!state.user;
    document.body.classList.toggle("is-readonly", !signedIn);
    const btn = $("#signBtn");
    btn.title = signedIn ? `Signed in as ${state.user} — tap to sign out` : "Sign in";
    btn.querySelector("span").textContent = signedIn ? "🔓" : "🔒";
  }

  function openSignIn() {
    $("#signinErr").hidden = true;
    $("#signin").hidden = false;
    $("#signinUser").focus();
  }

  function closeSignIn() {
    $("#signin").hidden = true;
    $("#signinForm").reset();
  }

  function wireSignIn() {
    $("#signBtn").addEventListener("click", async () => {
      if (!state.user) return openSignIn();
      await fetch("/api/logout", { method: "POST" }).catch(() => {});
      await loadWhoAmI();
      toast("Signed out", "good");
      render();
    });
    $("#signinCancel").addEventListener("click", closeSignIn);

    $("#signinForm").addEventListener("submit", async (e) => {
      e.preventDefault();
      const go = $("#signinGo");
      go.disabled = true;
      try {
        const res = await fetch("/api/login", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            username: $("#signinUser").value.trim(),
            password: $("#signinPass").value,
          }),
        });
        const body = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(body.detail || "Couldn't sign in.");
        closeSignIn();
        await loadWhoAmI();
        toast(`Signed in as ${state.user}`, "good");
        render();
      } catch (err) {
        $("#signinErr").hidden = false;
        $("#signinErr").textContent = err.message;
      } finally {
        go.disabled = false;
      }
    });
  }

  // ---------- full screen (wall display) ----------

  function wireFullscreen() {
    const btn = $("#fullBtn");
    const root = document.documentElement;
    if (!root.requestFullscreen && !root.webkitRequestFullscreen) return;
    btn.hidden = false;

    btn.addEventListener("click", () => {
      const on = document.fullscreenElement || document.webkitFullscreenElement;
      if (on) {
        (document.exitFullscreen || document.webkitExitFullscreen).call(document);
      } else {
        (root.requestFullscreen || root.webkitRequestFullscreen).call(root);
      }
    });

    // A wall screen shouldn't sleep mid-shift. Only some browsers allow this,
    // and it's dropped whenever the tab is hidden, so re-take it on return.
    let lock = null;
    const keepAwake = async () => {
      if (!navigator.wakeLock || document.visibilityState !== "visible") return;
      try { lock = await navigator.wakeLock.request("screen"); } catch (e) { /* not permitted */ }
    };
    document.addEventListener("visibilitychange", keepAwake);
    keepAwake();
  }

  // ---------- boot ----------

  $("#today").textContent = new Date().toLocaleDateString(undefined, {
    weekday: "short", day: "numeric", month: "short",
  });

  wireScan();
  wireSignIn();
  wireCamera();
  wireFullscreen();

  loadWhoAmI();

  load()
    .then(render)
    .catch((err) => {
      $("#empty").hidden = false;
      $("#empty").textContent = "Couldn't load jobs. Check the connection and pull to refresh.";
      console.error(err);
    });

  // Someone else may tick the same job off on the dashboard; keep in step
  // without wiping what's open or half-typed.
  setInterval(() => {
    if (state.busy.size || $("#camera").hidden === false) return;
    load().then(render).catch(() => {});
  }, 30000);
})();
