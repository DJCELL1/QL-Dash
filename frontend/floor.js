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
    make: "Make",
    press: "Press",
    cnc: "CNC",
    glazing: "Glazing",
    edge_strip: "Edge strip",
    finish: "Finish",
  };

  const FALLBACK_STAGES = ["make", "press", "cnc", "finish"];

  // Glazing and edge stripping only apply to doors whose description carries
  // the marker, so the server sends each job its own list and the card follows
  // that rather than assuming four.
  function stagesOf(row) {
    const keys = (row && row.stages && row.stages.length ? row.stages : FALLBACK_STAGES)
      .filter((k) => STAGE_LABELS[k]);
    return keys.map((key) => ({ key, label: STAGE_LABELS[key] }));
  }

  const state = {
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
    const [factory, schedule] = await Promise.all([
      getJSON("/api/factory"),
      // Not fatal — without it "Today" is simply empty and All open still works.
      getJSON("/api/schedule").catch(() => ({ entries: [] })),
    ]);
    state.rows = factory.rows || [];
    const key = todayKey();
    state.todayPros = new Set(
      (schedule.entries || [])
        .filter((e) => e.scheduled_date === key)
        .map((e) => e.prod_order_no)
    );
  }

  // ---------- helpers ----------

  const num = (v) => (Number.isInteger(v) ? String(v) : String(Math.round(v * 100) / 100));

  function doneFor(row, stage) {
    return row[`${stage}_done`] || 0;
  }

  // The API refuses a stage that would run ahead of the one before it, so grey
  // those out here too rather than letting someone tap into an error.
  function ceilingFor(row, index) {
    const st = stagesOf(row);
    return index === 0 ? row.total_qty || 0 : doneFor(row, st[index - 1].key);
  }

  function floorFor(row, index) {
    const st = stagesOf(row);
    return index === st.length - 1 ? 0 : doneFor(row, st[index + 1].key);
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
      ? `${rows.length} ${rows.length === 1 ? "job" : "jobs"} · ${num(doors)} doors`
      : "";

    // Headline for the wall screen — the two numbers worth reading from across
    // the room: how many doors are on today, and how many are through Make.
    const made = rows.reduce((s, r) => s + Math.min(doneFor(r, "make"), r.total_qty || 0), 0);
    $("#headline").textContent = rows.length
      ? `${num(made)} of ${num(doors)} made`
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
        <span class="job-qty">${num(row.total_qty)} ${row.total_qty === 1 ? "door" : "doors"}</span>
        <span class="job-customer">${esc(row.source_name || "Stock Door")}</span>
        <span class="job-item">${esc(row.item_summary || "")}</span>
        <span class="job-meta">
          ${row.sales_order_no ? `<span class="pill">${esc(row.sales_order_no)}</span>` : ""}
          ${due ? `<span class="pill ${due.late ? "late" : ""}">${esc(due.text)}</span>` : ""}
          ${complete ? '<span class="pill done">✓ Finished</span>' : ""}
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

  function stageHTML(row, stage, index) {
    const total = row.total_qty || 0;
    const done = doneFor(row, stage.key);
    const max = ceilingFor(row, index);
    const min = floorFor(row, index);
    const complete = total > 0 && done >= total;
    const locked = max <= 0 && done <= 0;
    const busy = state.busy.has(`${row.prod_order_no}|${stage.key}`);

    const note = locked
      ? `<p class="stage-note">Do ${stagesOf(row)[index - 1].label} first.</p>`
      : "";

    return `<div class="stage ${complete ? "is-complete" : ""} ${locked ? "is-locked" : ""}"
                 data-pro="${esc(row.prod_order_no)}" data-stage="${stage.key}">
      <div class="stage-top">
        <span class="stage-name">${stage.label}</span>
        <span class="stage-count">${num(done)} / ${num(total)}</span>
      </div>
      <div class="stage-controls">
        <button type="button" class="step" data-act="dec"
                ${busy || done <= min ? "disabled" : ""} aria-label="One less ${stage.label}">−</button>
        <input type="number" class="qty" inputmode="numeric" pattern="[0-9]*"
               value="${num(done)}" min="${num(min)}" max="${num(max)}" ${busy ? "disabled" : ""}
               aria-label="${stage.label} done">
        <button type="button" class="step" data-act="inc"
                ${busy || done >= max ? "disabled" : ""} aria-label="One more ${stage.label}">+</button>
        <button type="button" class="all-btn" data-act="all"
                ${busy || done >= max || max <= 0 ? "disabled" : ""}>All ${num(max)}</button>
      </div>
      ${note}
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

    document.querySelectorAll(".stage").forEach((el) => {
      const pro = el.dataset.pro;
      const stage = el.dataset.stage;
      const row = state.rows.find((r) => r.prod_order_no === pro);
      if (!row) return;
      const index = stagesOf(row).findIndex((s) => s.key === stage);

      el.querySelectorAll("[data-act]").forEach((btn) => {
        btn.addEventListener("click", () => {
          const done = doneFor(row, stage);
          const act = btn.dataset.act;
          const next =
            act === "inc" ? done + 1 : act === "dec" ? done - 1 : ceilingFor(row, index);
          save(row, stage, next);
        });
      });

      const input = el.querySelector(".qty");
      input.addEventListener("change", () => {
        const v = Number(input.value);
        if (Number.isNaN(v)) return render();
        save(row, stage, v);
      });
      // keep the on-screen keyboard from lingering after entry
      input.addEventListener("keydown", (e) => {
        if (e.key === "Enter") input.blur();
      });
    });
  }

  async function save(row, stage, done) {
    const key = `${row.prod_order_no}|${stage}`;
    if (state.busy.has(key)) return;
    state.busy.add(key);
    render();

    try {
      const res = await fetch("/api/factory/progress", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ prod_order_no: row.prod_order_no, stage, done: Math.max(0, done) }),
      });
      const body = await res.json().catch(() => ({}));
      if (res.status === 401) {
        openSignIn();
        throw new Error("Sorry Bruv — look but don't touch. Sign in first.");
      }
      if (!res.ok) throw new Error(body.detail || "Couldn't save that.");

      // Trust the server's numbers over ours — it clamps to the order quantity.
      for (const s of stagesOf(row)) {
        if (body[`${s.key}_done`] != null) row[`${s.key}_done`] = body[`${s.key}_done`];
      }
      // Mirror the server's own maths so the card doesn't disagree with the
      // dashboard: percent averages the four stages, and a job counts as
      // finished once Finish is done.
      const total = row.total_qty || 0;
      const st = stagesOf(row);
      const sum = st.reduce((t, s) => t + doneFor(row, s.key), 0);
      row.pct_complete = total > 0 ? Math.round((sum / (total * st.length)) * 1000) / 10 : 0;
      row.status = total > 0 && doneFor(row, "finish") >= total ? "completed" : "in_production";

      const label = STAGE_LABELS[stage] || stage;
      toast(`${row.prod_order_no} · ${label} ${num(doneFor(row, stage))} of ${num(total)}`, "good");
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
