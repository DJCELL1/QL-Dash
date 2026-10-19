(() => {
  "use strict";

  const state = {
    view: "joinery",
    // Hosted there's no Downloads folder, so "no data" messages have to point at
    // the Upload button instead. Assumed true until /api/status says otherwise.
    hasWatchFolder: true,
    huddle: false, // full-screen morning-meeting view of the schedule
    holdingSearch: { schedule: "", cavities: "" },
    user: null,        // signed-in username, null for a reader
    anyAccounts: true, // false means nobody can sign in yet
    isAdmin: false,    // admins keep the door numbers
    adminsSet: true,   // false means nobody is an admin, so everyone counts as one
    subLaneExpanded: new Set(), // "<contractor>|<lane>" shown in full
    cavities: { rows: [], as_of: null, search: "", windowStart: null },
    data: { joinery: null, subcontractors: null, factory: null, subBoard: null },
    history: { joinery: null, subcontractors: null },
    filters: {
      joinery: { search: "", chips: new Set(), sort: { key: "operation_due_date", dir: "asc" } },
      subcontractors: { search: "", chips: new Set(), sort: { key: "operation_due_date", dir: "asc" } },
      factory: {
        search: "",
        chips: new Set(),
        status: localStorage.getItem("factoryStatusFilter") || "in_production",
        viewMode: localStorage.getItem("factoryViewMode") || "day",
        line: localStorage.getItem("factoryLine") === "cavities" ? "cavities" : "doors",
      },
      subboard: { search: "", chips: new Set(), viewMode: localStorage.getItem("subViewMode") || "board" },
    },
    expanded: new Set(),
    selectedGroups: new Set(),
    selectedCards: new Map(),
    selectedDays: new Set(),
    selectedPros: new Set(),
    factoryByPro: new Map(),
    factoryDay: null,
    labelPro: null, // PRO being previewed on the Labels tab
    capacity: {
      doorsPerDay: Number(localStorage.getItem("capacityDoorsPerDay")) || 20,
      leadTimeDays: Number(localStorage.getItem("capacityLeadTime")) || 3,
      stage: localStorage.getItem("capacityStage") || null,
    },
    schedule: { entries: [], dayPlans: {}, priorities: {} },
    scheduleOffsets: {
      press: Number(localStorage.getItem("scheduleOffsetPress")) || 0,
      cnc: Number(localStorage.getItem("scheduleOffsetCnc")) || 1,
      finish: Number(localStorage.getItem("scheduleOffsetFinish")) || 2,
    },
    scheduleWindowStart: null,
  };

  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

  // ---------- data fetching ----------

  async function fetchJSON(url, opts) {
    const res = await fetch(url, opts);
    if (!res.ok) {
      if (res.status === 404) return null;
      throw new Error(`${url} -> ${res.status}`);
    }
    return res.json();
  }

  async function loadDataset(dataset) {
    const [snap, hist] = await Promise.all([
      fetchJSON(`/api/snapshot/${dataset}`),
      fetchJSON(`/api/history/${dataset}`),
    ]);
    state.data[dataset] = snap;
    state.history[dataset] = hist;
  }

  async function loadStatus() {
    const status = await fetchJSON("/api/status");
    renderUpdatedAt(status);
    state.hasWatchFolder = !!status.watch_folder;
    // Hosted there's no Downloads folder to watch, so hide the button that scans it.
    $("#rescanBtn").hidden = !state.hasWatchFolder;
    for (const [id, what] of [
      ["#joinery-empty", "Production Scheduler export (Joinery)"],
      ["#sub-empty", "Production Scheduler export (Subcontractors)"],
      ["#schedule-empty", "Production Scheduler export (Joinery)"],
    ]) {
      const el = $(id);
      if (el) el.textContent = noDataMessage(what);
    }
  }

  function noDataMessage(what) {
    return state.hasWatchFolder
      ? `No data yet — drop today's ${what} into Downloads.`
      : `No data yet — click Upload export and pick today's ${what}.`;
  }

  async function postJSON(url, body) {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      let detail = `${url} -> ${res.status}`;
      try {
        const errBody = await res.json();
        if (errBody && errBody.detail) detail = errBody.detail;
      } catch (e) {
        // response wasn't JSON — keep the generic detail
      }
      throw signInError(res.status, detail);
    }
    return res.json();
  }

  // A blocked change is a different thing from a failed one. Marking it here,
  // at the one place every write goes through, means each caller doesn't have
  // to recognise it — and a dragged group of five doesn't stack five identical
  // "sign in" boxes, because the dialog only opens once.
  function signInError(status, detail) {
    const err = new Error(detail);
    if (status === 401) {
      err.needsSignIn = true;
      showNoTouch();
    }
    return err;
  }

  let noTouchOpen = false;

  function showNoTouch() {
    if (noTouchOpen) return;
    noTouchOpen = true;
    $("#noTouchBackdrop").hidden = false;
  }

  function hideNoTouch() {
    noTouchOpen = false;
    $("#noTouchBackdrop").hidden = true;
  }

  // Report a failure, unless it was simply "you're not signed in" — that's
  // already been said, more entertainingly.
  function notifyError(err, fallback) {
    if (err && err.needsSignIn) return;
    console.error(err);
    alert((err && err.message) || fallback);
  }

  function wireNoTouch() {
    $("#noTouchClose").addEventListener("click", hideNoTouch);
    $("#noTouchBackdrop").addEventListener("click", (e) => {
      if (e.target === $("#noTouchBackdrop")) hideNoTouch();
    });
    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape" && noTouchOpen) hideNoTouch();
    });
    $("#noTouchSignIn").addEventListener("click", () => {
      hideNoTouch();
      openSignIn();
    });
    // Only show the picture if one has been dropped in; a broken image icon
    // would undercut the joke. The browser starts fetching as soon as the tag
    // is parsed, so by now it may already have finished — a listener alone
    // would miss that and leave the broken icon sitting there.
    const img = $("#noTouchImg");
    const settle = () => {
      if (!img.isConnected) return;
      if (img.naturalWidth > 0) img.hidden = false;
      else img.remove();
    };
    if (img.complete) settle();
    img.addEventListener("load", settle);
    img.addEventListener("error", settle);
  }

  /* ---------- warehouse movement number ---------- */
  // The flag on an SO card only says a movement exists. What anyone actually
  // needs is the number itself, to paste into BC or a pick note — so clicking
  // the flag hands it over rather than sending them off to look it up.

  let wmOpen = false;

  // The old execCommand route is tried first on purpose. It's synchronous, so
  // it runs inside the click itself, and it works on the plain-HTTP LAN address
  // as well as on HTTPS — navigator.clipboard needs a secure context and is
  // absent there. It can also sit unresolved behind a permission decision,
  // which leaves the button silent and the user unsure whether it worked.
  function copyViaSelection(text) {
    try {
      const ta = document.createElement("textarea");
      ta.value = text;
      ta.setAttribute("readonly", "");
      ta.style.position = "fixed";
      ta.style.top = "-1000px";
      document.body.appendChild(ta);
      ta.select();
      const ok = document.execCommand("copy");
      ta.remove();
      return ok;
    } catch (err) {
      return false;
    }
  }

  async function copyText(text) {
    if (copyViaSelection(text)) return true;
    try {
      if (!navigator.clipboard) return false;
      // Don't wait forever on a prompt that may never be answered — the caller
      // needs to say something either way.
      await Promise.race([
        navigator.clipboard.writeText(text),
        new Promise((_, reject) => setTimeout(() => reject(new Error("timeout")), 1500)),
      ]);
      return true;
    } catch (err) {
      return false;
    }
  }

  // Last resort: if neither copy route worked, highlight the number so Ctrl+C
  // still gets it. Better than a button that says it failed and stops there.
  function selectContents(el) {
    try {
      const range = document.createRange();
      range.selectNodeContents(el);
      const sel = window.getSelection();
      sel.removeAllRanges();
      sel.addRange(range);
    } catch (err) {
      /* selection isn't available — the number is still on screen to read */
    }
  }

  function showWm(numbers, so) {
    const list = numbers.map((n) => String(n).trim()).filter(Boolean);
    if (list.length === 0) return;

    $("#wmTitle").textContent = list.length === 1 ? "Warehouse movement" : "Warehouse movements";
    const forLine = $("#wmFor");
    forLine.textContent = so ? `On ${so}` : "";
    forLine.hidden = !so;

    $("#wmList").innerHTML = list
      .map(
        (n) => `<div class="wm-row">
          <span class="wm-number">${escapeAttr(n)}</span>
          <button type="button" class="btn btn-primary wm-copy" data-wm="${escapeAttr(n)}">COPY WM #</button>
        </div>`,
      )
      .join("");

    $$("#wmList .wm-copy").forEach((btn) => {
      btn.addEventListener("click", async () => {
        const ok = await copyText(btn.dataset.wm);
        if (!ok) selectContents(btn.parentElement.querySelector(".wm-number"));
        btn.textContent = ok ? "COPIED ✓" : "PRESS CTRL+C";
        btn.classList.toggle("is-copied", ok);
        // back to normal so a second person at the same screen sees a button
        // that still offers to copy, not one stuck on someone else's success
        setTimeout(() => {
          btn.textContent = "COPY WM #";
          btn.classList.remove("is-copied");
        }, 2500);
      });
    });

    wmOpen = true;
    $("#wmBackdrop").hidden = false;
  }

  function hideWm() {
    wmOpen = false;
    $("#wmBackdrop").hidden = true;
  }

  function wireWm() {
    $("#wmClose").addEventListener("click", hideWm);
    $("#wmBackdrop").addEventListener("click", (e) => {
      if (e.target === $("#wmBackdrop")) hideWm();
    });
    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape" && wmOpen) hideWm();
    });
  }

  // Re-run after every board render, because the flags are drawn fresh. Scoped
  // to one board, so rendering one never wires the other's flags twice.
  function wireWmFlags(root = "#view-scheduling") {
    $$(`${root} .wm-flag`).forEach((flag) => {
      const open = (e) => {
        // the flag sits on the SO header, which collapses on click and drags on
        // drag — neither is what someone reaching for the number wants
        e.stopPropagation();
        e.preventDefault();
        showWm((flag.dataset.wm || "").split(","), flag.dataset.wmSo);
      };
      flag.addEventListener("click", open);
      flag.addEventListener("keydown", (e) => {
        if (e.key === "Enter" || e.key === " ") open(e);
      });
    });
  }

  async function loadFactory() {
    state.data.factory = await fetchJSON("/api/factory");
    state.factoryByPro = new Map((state.data.factory?.rows || []).map((r) => [r.prod_order_no, r]));
  }

  async function loadSchedule() {
    const data = await fetchJSON("/api/schedule");
    state.schedule.entries = (data && data.entries) || [];
    state.schedule.dayPlans = (data && data.day_plans) || {};
    state.schedule.priorities = (data && data.day_priorities) || {};
  }

  async function loadSubBoard() {
    state.data.subBoard = await fetchJSON("/api/subcontractors");
  }

  async function refreshScheduleAndFactory() {
    // job totals/done-qty (factory) and where things are scheduled can each go
    // stale independently (e.g. a new CSV import, or progress logged on another
    // tab) — refresh both together so the board never shows phantom cards for
    // jobs the server no longer recognizes.
    await Promise.all([loadFactory(), loadSchedule()]);
    renderScheduling();
  }

  async function apiDelete(url) {
    const res = await fetch(url, { method: "DELETE" });
    if (!res.ok) {
      let detail = `${url} -> ${res.status}`;
      try {
        const errBody = await res.json();
        if (errBody && errBody.detail) detail = errBody.detail;
      } catch (e) {
        // response wasn't JSON — keep the generic detail
      }
      throw signInError(res.status, detail);
    }
    return res.json();
  }

  async function refreshAll() {
    await Promise.all([
      loadDataset("joinery"),
      loadDataset("subcontractors"),
      loadFactory(),
      loadSchedule(),
      loadSubBoard(),
      loadCavities(),
      loadStatus(),
      loadWhoAmI(),
    ]);
    render();
    maybeAskForDoorNumbers();
  }

  // ---------- formatting helpers ----------

  function fmtDate(iso) {
    if (!iso) return "—";
    const d = new Date(iso);
    if (isNaN(d)) return "—";
    return d.toLocaleDateString(undefined, { day: "2-digit", month: "short", year: "numeric" });
  }

  function fmtNum(n) {
    if (n === null || n === undefined) return "—";
    return Number(n).toLocaleString(undefined, { maximumFractionDigits: 1 });
  }

  const NO_SO_LABEL = "Stock Door";

  function customerLabel(name) {
    return name && String(name).trim() ? name : "Stock Door";
  }

  // A stock door has no customer, so "Stock Door" in that slot says nothing you
  // don't already know. Its item number does — TDOOR249235SCP is a
  // 2400 x 920 x 35mm — which is what tells you which door it is on the board.
  function boardCustomerLabel(row) {
    const name = row && row.source_name && String(row.source_name).trim();
    if (name) return name;
    return (row && row.item_no) || "Stock Door";
  }

  function soLabel(so) {
    return so && String(so).trim() ? so : NO_SO_LABEL;
  }

  function dueLabel(rec) {
    if (!rec.operation_due_date) return { text: "—", cls: "cell-muted" };
    const days = rec.due_in_days;
    const dateText = fmtDate(rec.operation_due_date);
    if (days === null || days === undefined) return { text: dateText, cls: "" };
    if (rec.overdue) return { text: `${dateText} · ${Math.abs(days)}d overdue`, cls: "text-critical" };
    if (rec.is_open && days <= 2) return { text: `${dateText} · due in ${days}d`, cls: "text-warning" };
    return { text: dateText, cls: "cell-muted" };
  }

  // ---------- badges ----------

  function badgesFor(rec) {
    const badges = [];
    if (rec.overdue) badges.push(["critical", "Overdue"]);
    if (rec.urgent) badges.push(["serious", "Urgent"]);
    if (rec.shortage) badges.push(["warning", "Shortage"]);
    if (rec.potential_back_order) badges.push(["critical", "Back order"]);
    if (!rec.is_open) badges.push(["good", "Finished"]);
    const factory = state.factoryByPro.get(rec.prod_order_no);
    if (factory && factory.status === "completed") badges.push(["good", "Factory done"]);
    return badges;
  }

  function badgeRowHTML(rec) {
    const badges = badgesFor(rec);
    if (badges.length === 0) return '<span class="badge badge-neutral">In progress</span>';
    return badges.map(([cls, label]) => `<span class="badge badge-${cls}">${label}</span>`).join("");
  }

  function factoryMiniHTML(rec) {
    const f = state.factoryByPro.get(rec.prod_order_no);
    if (!f) return '<span class="cell-muted">—</span>';
    const stages = [
      ["M", "make"],
      ["P", "press"],
      ["C", "cnc"],
      ["F", "finish"],
    ];
    const dots = stages
      .map(([label, key]) => {
        const done = f[`${key}_done`] || 0;
        const total = f.total_qty || 0;
        const cls = total > 0 && done >= total ? "stage-dot-complete" : done > 0 ? "stage-dot-partial" : "stage-dot-pending";
        return `<span class="stage-dot ${cls}" title="${label === "M" ? "Make" : label === "P" ? "Press" : label === "C" ? "CNC" : "Finish"}: ${fmtNum(done)} / ${fmtNum(total)}">${label}</span>`;
      })
      .join("");
    return `<div class="factory-mini"><span class="stage-dots">${dots}</span><span class="progress-pct">${f.pct_complete.toFixed(0)}%</span></div>`;
  }

  // ---------- stat tiles ----------

  function computeStats(records) {
    const open = records.filter((r) => r.is_open);
    return {
      total: records.length,
      open: open.length,
      openPros: new Set(open.map((r) => r.prod_order_no)).size,
      overdue: records.filter((r) => r.overdue).length,
      urgent: records.filter((r) => r.urgent).length,
      shortage: records.filter((r) => r.shortage).length,
      backOrder: records.filter((r) => r.potential_back_order).length,
    };
  }

  function renderStats(container, records, options = {}) {
    const s = computeStats(records);
    const openLabel = options.showDistinctPro ? "Open lines" : "Open orders";
    const tiles = [
      ...(options.showDistinctPro ? [["Open production orders", s.openPros, ""]] : []),
      [openLabel, s.open, ""],
      ["Overdue", s.overdue, "status-critical"],
      ["Urgent", s.urgent, "status-serious"],
      ["Shortage", s.shortage, "status-warning"],
      ["Back order", s.backOrder, "status-critical"],
      ["Total lines", s.total, ""],
    ];
    container.innerHTML = tiles
      .map(
        ([label, value, cls]) => `
      <div class="stat-tile ${cls}">
        <div class="stat-label">${label}</div>
        <div class="stat-value">${fmtNum(value)}</div>
      </div>`
      )
      .join("");
  }

  // ---------- filtering / sorting ----------

  function applyFilters(records, filterState) {
    let out = records;
    const q = filterState.search.trim().toLowerCase();
    if (q) {
      out = out.filter((r) =>
        [r.prod_order_no, r.sales_order_no, r.source_name, r.item_no, r.item_description, r.comments, r.colour_description]
          .filter(Boolean)
          .some((v) => String(v).toLowerCase().includes(q))
      );
    }
    for (const chip of filterState.chips) {
      if (chip === "open") out = out.filter((r) => r.is_open);
      else out = out.filter((r) => r[chip]);
    }
    return out;
  }

  function applySort(records, sort) {
    const { key, dir } = sort;
    const mul = dir === "asc" ? 1 : -1;
    return [...records].sort((a, b) => {
      let av = a[key];
      let bv = b[key];
      if (av === null || av === undefined) av = "";
      if (bv === null || bv === undefined) bv = "";
      if (typeof av === "number" || typeof bv === "number") {
        return ((av || 0) - (bv || 0)) * mul;
      }
      return String(av).localeCompare(String(bv)) * mul;
    });
  }

  // ---------- table rendering (grouped by Sales Order) ----------

  const JOINERY_CHILD_COLUMNS = [
    { key: "flags", label: "Status", sortable: false, render: (r) => `<div class="badge-row">${badgeRowHTML(r)}</div>` },
    { key: "prod_order_no", label: "PRO", sortable: true, render: (r) => `<span class="cell-primary">${r.prod_order_no || "—"}</span>` },
    {
      key: "item_description",
      label: "Item",
      sortable: true,
      render: (r) => `<div>${r.item_description || "—"}</div><div class="cell-muted">${r.item_no || ""}</div>`,
    },
    {
      key: "work_centre_no",
      label: "Work centre",
      sortable: true,
      render: (r) => `<div>${r.work_centre_description || r.work_centre_no || "—"}</div>`,
    },
    {
      key: "operation_due_date",
      label: "Due",
      sortable: true,
      render: (r) => {
        const d = dueLabel(r);
        return `<span class="${d.cls}">${d.text}</span>`;
      },
    },
    {
      key: "operation_remaining_qty",
      label: "Remaining / Qty",
      sortable: true,
      cls: "cell-num",
      render: (r) => `${fmtNum(r.operation_remaining_qty)} / ${fmtNum(r.quantity)}`,
    },
    {
      key: "operation_pct_finished",
      label: "% done",
      sortable: true,
      cls: "cell-num",
      render: (r) => `${fmtNum(r.operation_pct_finished)}%`,
    },
    {
      key: "factory",
      label: "Factory floor",
      sortable: false,
      render: (r) => factoryMiniHTML(r),
    },
    { key: "comments", label: "Comments", sortable: false, render: (r) => r.comments || "—" },
  ];

  const SUB_CHILD_COLUMNS = [
    { key: "flags", label: "Status", sortable: false, render: (r) => `<div class="badge-row">${badgeRowHTML(r)}</div>` },
    { key: "prod_order_no", label: "PRO", sortable: true, render: (r) => `<span class="cell-primary">${r.prod_order_no || "—"}</span>` },
    {
      key: "item_description",
      label: "Item",
      sortable: true,
      render: (r) => `<div>${r.item_description || "—"}</div><div class="cell-muted">${r.item_no || ""}</div>`,
    },
    { key: "colour_description", label: "Colour / finish", sortable: true, render: (r) => r.colour_description || "—" },
    { key: "comments", label: "Sub PO", sortable: true, render: (r) => r.comments || "—" },
    {
      key: "operation_due_date",
      label: "Due",
      sortable: true,
      render: (r) => {
        const d = dueLabel(r);
        return `<span class="${d.cls}">${d.text}</span>`;
      },
    },
    {
      key: "days_in_stage",
      label: "Days there",
      sortable: true,
      cls: "cell-num",
      render: (r) => (r.days_in_stage === null || r.days_in_stage === undefined ? "—" : `${r.days_in_stage}d`),
    },
    {
      key: "operation_remaining_qty",
      label: "Remaining / Qty",
      sortable: true,
      cls: "cell-num",
      render: (r) => `${fmtNum(r.operation_remaining_qty)} / ${fmtNum(r.quantity)}`,
    },
  ];

  function groupBySalesOrder(records) {
    const map = new Map();
    for (const r of records) {
      const key = soLabel(r.sales_order_no);
      if (!map.has(key)) map.set(key, { so: key, customer: customerLabel(r.source_name), records: [] });
      map.get(key).records.push(r);
    }
    return Array.from(map.values());
  }

  function groupAggregate(group) {
    const records = group.records;
    const dueDates = records.map((r) => r.due_in_days).filter((d) => d !== null && d !== undefined);
    return {
      total: records.length,
      openCount: records.filter((r) => r.is_open).length,
      overdue: records.filter((r) => r.overdue).length,
      urgent: records.filter((r) => r.urgent).length,
      shortage: records.filter((r) => r.shortage).length,
      backOrder: records.filter((r) => r.potential_back_order).length,
      minDue: dueDates.length ? Math.min(...dueDates) : null,
      remainingTotal: records.reduce((s, r) => s + (r.operation_remaining_qty || 0), 0),
    };
  }

  function sortGroups(groups) {
    return [...groups].sort((a, b) => {
      const aggA = groupAggregate(a);
      const aggB = groupAggregate(b);
      const aMin = aggA.minDue === null ? Infinity : aggA.minDue;
      const bMin = aggB.minDue === null ? Infinity : aggB.minDue;
      if (aMin !== bMin) return aMin - bMin;
      return a.so.localeCompare(b.so);
    });
  }

  function renderGroupedTableInto(tableEl, records, childColumns, sort, onSort, groupPrefix, onToggle) {
    const thead = tableEl.querySelector("thead");
    const tbody = tableEl.querySelector("tbody");

    thead.innerHTML =
      "<tr>" +
      childColumns
        .map((c) => {
          const sortedCls = c.sortable && sort.key === c.key ? `sorted ${sort.dir}` : "";
          return `<th data-key="${c.key}" class="${sortedCls}" ${c.sortable ? "" : 'style="cursor:default"'}>${c.label}</th>`;
        })
        .join("") +
      "</tr>";

    if (records.length === 0) {
      tbody.innerHTML = `<tr><td colspan="${childColumns.length}" class="cell-muted" style="padding:24px;text-align:center;">No matching rows</td></tr>`;
    } else {
      const groups = sortGroups(groupBySalesOrder(records));
      tbody.innerHTML = groups
        .map((g) => {
          const agg = groupAggregate(g);
          const groupKey = `${groupPrefix}|${g.so}`;
          const isExpanded = state.expanded.has(groupKey);

          const badges = [];
          if (agg.overdue) badges.push(["critical", `${agg.overdue} overdue`]);
          if (agg.urgent) badges.push(["serious", `${agg.urgent} urgent`]);
          if (agg.shortage) badges.push(["warning", `${agg.shortage} shortage`]);
          if (agg.backOrder) badges.push(["critical", `${agg.backOrder} back order`]);
          const badgeHtml = badges.length
            ? badges.map(([cls, label]) => `<span class="badge badge-${cls}">${label}</span>`).join("")
            : '<span class="badge badge-neutral">On track</span>';

          let dueCls = "cell-muted";
          let dueText = "—";
          if (agg.minDue !== null) {
            if (agg.minDue < 0) {
              dueCls = "text-critical";
              dueText = `${Math.abs(agg.minDue)}d overdue`;
            } else if (agg.minDue <= 2) {
              dueCls = "text-warning";
              dueText = `due in ${agg.minDue}d`;
            } else {
              dueText = `due in ${agg.minDue}d`;
            }
          }

          const groupRow = `
            <tr class="group-row" data-group-key="${groupKey}">
              <td colspan="${childColumns.length}">
                <div class="group-row-inner">
                  <span class="group-chevron">${isExpanded ? "▾" : "▸"}</span>
                  <span class="group-so">${g.so}</span>
                  <span class="group-customer">${g.customer || "—"}</span>
                  <span class="badge-row">${badgeHtml}</span>
                  <span class="group-count">${agg.total} PO${agg.total === 1 ? "" : "s"}</span>
                  <span class="${dueCls}">${dueText}</span>
                  <span class="cell-muted group-remaining">${fmtNum(agg.remainingTotal)} remaining</span>
                </div>
              </td>
            </tr>`;

          const childRows = isExpanded
            ? applySort(g.records, sort)
                .map(
                  (r) =>
                    `<tr class="child-row">` +
                    childColumns.map((c) => `<td class="${c.cls || ""}">${c.render(r)}</td>`).join("") +
                    `</tr>`
                )
                .join("")
            : "";

          return groupRow + childRows;
        })
        .join("");
    }

    $$("th[data-key]", thead).forEach((th) => {
      const col = childColumns.find((c) => c.key === th.dataset.key);
      if (!col || !col.sortable) return;
      th.addEventListener("click", () => onSort(th.dataset.key));
    });

    $$(".group-row", tbody).forEach((tr) => {
      tr.addEventListener("click", () => {
        const key = tr.dataset.groupKey;
        if (state.expanded.has(key)) state.expanded.delete(key);
        else state.expanded.add(key);
        onToggle();
      });
    });
  }

  function expandCollapseAll(records, prefixFn, expand, onToggle) {
    for (const r of records) {
      const so = soLabel(r.sales_order_no);
      const key = `${prefixFn(r)}|${so}`;
      if (expand) state.expanded.add(key);
      else state.expanded.delete(key);
    }
    onToggle();
  }

  // ---------- SVG line chart ----------

  function renderHistoryChart(container, history, seriesKey = "row_count", label = "open lines") {
    if (!history || !history.history || history.history.length === 0) {
      container.innerHTML = '<div class="chart-empty">Not enough history yet — this fills in as you drop in daily exports.</div>';
      return;
    }
    const points = history.history;
    const w = 900;
    const h = 220;
    const padL = 40;
    const padR = 16;
    const padT = 16;
    const padB = 30;
    const plotW = w - padL - padR;
    const plotH = h - padT - padB;

    const values = points.map((p) => p[seriesKey] || 0);
    const maxV = Math.max(1, ...values);
    const n = points.length;

    const x = (i) => padL + (n === 1 ? plotW / 2 : (i / (n - 1)) * plotW);
    const y = (v) => padT + plotH - (v / maxV) * plotH;

    const linePath = points.map((p, i) => `${i === 0 ? "M" : "L"} ${x(i).toFixed(1)} ${y(p[seriesKey] || 0).toFixed(1)}`).join(" ");

    const gridLines = [0, 0.25, 0.5, 0.75, 1].map((f) => {
      const yy = padT + plotH * (1 - f);
      return `<line class="svg-grid" x1="${padL}" y1="${yy.toFixed(1)}" x2="${w - padR}" y2="${yy.toFixed(1)}"></line>`;
    });

    const labelEvery = Math.ceil(n / 8) || 1;
    const xLabels = points
      .map((p, i) => {
        if (i % labelEvery !== 0 && i !== n - 1) return "";
        const d = new Date(p.snapshot_date);
        const txt = isNaN(d) ? p.snapshot_date : d.toLocaleDateString(undefined, { day: "2-digit", month: "short" });
        return `<text class="svg-label" x="${x(i).toFixed(1)}" y="${h - 8}" text-anchor="middle">${txt}</text>`;
      })
      .join("");

    const dots = points
      .map((p, i) => `<circle class="svg-dot" cx="${x(i).toFixed(1)}" cy="${y(p[seriesKey] || 0).toFixed(1)}" r="3"><title>${p.snapshot_date}: ${p[seriesKey] || 0} ${label}</title></circle>`)
      .join("");

    container.innerHTML = `
      <svg viewBox="0 0 ${w} ${h}" role="img" aria-label="${label} over time">
        ${gridLines.join("")}
        <line class="svg-axis" x1="${padL}" y1="${padT + plotH}" x2="${w - padR}" y2="${padT + plotH}"></line>
        <path class="svg-line" d="${linePath}"></path>
        ${dots}
        ${xLabels}
      </svg>`;
  }

  // ---------- capacity planning ----------

  function isWeekday(d) {
    const day = d.getDay();
    return day !== 0 && day !== 6;
  }

  function fmtDayDate(d) {
    return d.toLocaleDateString(undefined, { weekday: "short", day: "2-digit", month: "short" });
  }

  // The Make+Press line is the constraint this card answers for, so the backlog is
  // whatever still has to be MADE — one row per PRO, cleared by Factory floor
  // progress. Doors already made but waiting on CNC sit in a different queue and
  // don't hold up starting a new lot.
  function makeBacklogJobs() {
    const rows = (state.data.factory && state.data.factory.rows) || [];
    return rows
      .filter((r) => r.status !== "completed")
      .map((r) => ({
        pro: r.prod_order_no,
        so: r.sales_order_no,
        customer: r.source_name,
        item: r.item_summary,
        due_date: r.due_date,
        remaining: Math.max(0, (r.total_qty || 0) - (r.make_done || 0)),
      }))
      .filter((j) => j.remaining > 0.001);
  }

  function computeCapacitySchedule(doorsPerDay) {
    const stageRecords = makeBacklogJobs();
    const totalBacklog = stageRecords.reduce((s, r) => s + r.remaining, 0);

    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const cursor = new Date(today);
    while (!isWeekday(cursor)) cursor.setDate(cursor.getDate() + 1);

    const points = [{ date: new Date(cursor), remaining: totalBacklog }];
    let remaining = totalBacklog;
    let clearDate = remaining <= 0 ? new Date(cursor) : null;
    const maxDays = 130;
    let count = 0;

    while (remaining > 0 && count < maxDays) {
      remaining = Math.max(0, remaining - doorsPerDay);
      points.push({ date: new Date(cursor), remaining });
      if (remaining <= 0) {
        clearDate = new Date(cursor);
        break;
      }
      do {
        cursor.setDate(cursor.getDate() + 1);
      } while (!isWeekday(cursor));
      count++;
    }

    if (clearDate) {
      for (let k = 0; k < 3; k++) {
        do {
          cursor.setDate(cursor.getDate() + 1);
        } while (!isWeekday(cursor));
        points.push({ date: new Date(cursor), remaining: 0 });
      }
    }

    return {
      points,
      totalBacklog,
      doorsPerDay,
      businessDaysNeeded: points.length > 1 ? points.findIndex((p) => p.remaining <= 0) : 0,
      clearDate,
      openCount: stageRecords.length,
    };
  }

  function renderCapacitySummary(container, schedule) {
    if (schedule.openCount === 0) {
      container.innerHTML = `
        <div class="summary-item">
          <span class="summary-label">Backlog</span>
          <span class="summary-value text-good">None — open</span>
        </div>`;
      return;
    }
    const clearText = schedule.clearDate ? fmtDayDate(schedule.clearDate) : "—";
    const clearCls = schedule.businessDaysNeeded <= 1 ? "text-good" : "";
    container.innerHTML = `
      <div class="summary-item">
        <span class="summary-label">Still to make</span>
        <span class="summary-value">${fmtNum(schedule.totalBacklog)} doors · ${schedule.openCount} jobs</span>
      </div>
      <div class="summary-item">
        <span class="summary-label">At ${fmtNum(schedule.doorsPerDay)} / workday</span>
        <span class="summary-value">${schedule.businessDaysNeeded} business day${schedule.businessDaysNeeded === 1 ? "" : "s"}</span>
      </div>
      <div class="summary-item">
        <span class="summary-label">Next available start</span>
        <span class="summary-value ${clearCls}">${clearText}</span>
      </div>`;
  }

  function renderCapacityChart(container, schedule) {
    if (schedule.openCount === 0) {
      container.innerHTML = '<div class="chart-empty">Nothing left to make — a new lot can start right away.</div>';
      return;
    }

    const points = schedule.points;
    const w = 900;
    const h = 220;
    const padL = 44;
    const padR = 16;
    const padT = 16;
    const padB = 30;
    const plotW = w - padL - padR;
    const plotH = h - padT - padB;

    const maxV = Math.max(1, schedule.totalBacklog);
    const n = points.length;
    const x = (i) => padL + (n === 1 ? plotW / 2 : (i / (n - 1)) * plotW);
    const y = (v) => padT + plotH - (v / maxV) * plotH;

    const clearIdx = points.findIndex((p) => p.remaining <= 0);

    const gridLines = [0, 0.25, 0.5, 0.75, 1].map((f) => {
      const yy = padT + plotH * (1 - f);
      return `<line class="svg-grid" x1="${padL}" y1="${yy.toFixed(1)}" x2="${w - padR}" y2="${yy.toFixed(1)}"></line>`;
    });

    const areaPath =
      `M ${x(0).toFixed(1)} ${(padT + plotH).toFixed(1)} ` +
      points.map((p, i) => `L ${x(i).toFixed(1)} ${y(p.remaining).toFixed(1)}`).join(" ") +
      ` L ${x(n - 1).toFixed(1)} ${(padT + plotH).toFixed(1)} Z`;

    const linePath = points.map((p, i) => `${i === 0 ? "M" : "L"} ${x(i).toFixed(1)} ${y(p.remaining).toFixed(1)}`).join(" ");

    const labelEvery = Math.ceil(n / 8) || 1;
    const xLabels = points
      .map((p, i) => {
        if (i % labelEvery !== 0 && i !== n - 1) return "";
        return `<text class="svg-label" x="${x(i).toFixed(1)}" y="${h - 8}" text-anchor="middle">${fmtDayDate(p.date)}</text>`;
      })
      .join("");

    const dots = points
      .map(
        (p, i) =>
          `<circle class="svg-dot" cx="${x(i).toFixed(1)}" cy="${y(p.remaining).toFixed(1)}" r="3"><title>${fmtDayDate(p.date)}: ${fmtNum(p.remaining)} doors remaining</title></circle>`
      )
      .join("");

    let freeZone = "";
    let marker = "";
    if (clearIdx >= 0) {
      const mx = x(clearIdx);
      freeZone = `<rect class="svg-free-zone" x="${mx.toFixed(1)}" y="${padT}" width="${(w - padR - mx).toFixed(1)}" height="${plotH}"></rect>`;
      marker = `
        <line class="svg-marker-line" x1="${mx.toFixed(1)}" y1="${padT}" x2="${mx.toFixed(1)}" y2="${padT + plotH}"></line>
        <text class="svg-marker-label" x="${mx.toFixed(1)}" y="${padT - 4}" text-anchor="middle">Open from ${fmtDayDate(points[clearIdx].date)}</text>`;
    }

    container.innerHTML = `
      <svg viewBox="0 0 ${w} ${h + 14}" role="img" aria-label="Backlog burn-down at ${schedule.doorsPerDay} doors per workday">
        ${freeZone}
        ${gridLines.join("")}
        <line class="svg-axis" x1="${padL}" y1="${padT + plotH}" x2="${w - padR}" y2="${padT + plotH}"></line>
        <path class="svg-area" d="${areaPath}"></path>
        <path class="svg-line" d="${linePath}"></path>
        ${dots}
        ${marker}
        ${xLabels}
      </svg>`;
  }

  // ---------- start-date smoothing ----------

  function addBusinessDays(date, n) {
    const d = new Date(date);
    d.setHours(0, 0, 0, 0);
    const step = n >= 0 ? 1 : -1;
    let remaining = Math.abs(n);
    while (remaining > 0) {
      d.setDate(d.getDate() + step);
      if (isWeekday(d)) remaining--;
    }
    return d;
  }

  function dateKey(d) {
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  }

  function businessDaysBetween(a, b) {
    if (dateKey(a) === dateKey(b)) return 0;
    const sign = b > a ? 1 : -1;
    let d = new Date(a);
    let count = 0;
    while (dateKey(d) !== dateKey(b)) {
      d = addBusinessDays(d, sign);
      count++;
    }
    return count * sign;
  }

  function forEachBusinessDay(start, end, cb) {
    let d = new Date(start);
    while (d <= end) {
      cb(new Date(d));
      d = addBusinessDays(d, 1);
    }
  }

  function computeLeveling(doorsPerDay, leadTimeDays) {
    const today0 = new Date();
    today0.setHours(0, 0, 0, 0);
    while (!isWeekday(today0)) today0.setDate(today0.getDate() + 1);

    // same basis as the backlog above: what's still to be made, per PRO
    const backlog = makeBacklogJobs();
    const eligible = backlog.filter((j) => j.due_date);
    const skippedNoDueDate = backlog.filter((j) => !j.due_date).length;

    const lines = eligible
      .map((r) => ({
        rec: r,
        qty: r.remaining,
        idealStart: addBusinessDays(new Date(r.due_date), -leadTimeDays),
      }))
      .sort((a, b) => new Date(a.rec.due_date) - new Date(b.rec.due_date) || a.idealStart - b.idealStart);

    const capacityUsed = new Map();
    const capacityAt = (d) => capacityUsed.get(dateKey(d)) || 0;
    const canFit = (d, qty) => {
      const used = capacityAt(d);
      return used === 0 || used + qty <= doorsPerDay;
    };
    const book = (d, qty) => capacityUsed.set(dateKey(d), capacityAt(d) + qty);

    const results = [];
    for (const line of lines) {
      const windowStart = today0;
      const windowEnd = line.idealStart > today0 ? line.idealStart : today0;

      let assigned = null;
      forEachBusinessDay(windowStart, windowEnd, (d) => {
        if (!assigned && canFit(d, line.qty)) assigned = d;
      });

      if (!assigned) {
        let d = addBusinessDays(windowEnd, 1);
        for (let i = 0; i < 250 && !assigned; i++) {
          if (canFit(d, line.qty)) assigned = d;
          else d = addBusinessDays(d, 1);
        }
      }

      book(assigned, line.qty);
      results.push({
        rec: line.rec,
        qty: line.qty,
        idealStart: line.idealStart,
        suggestedStart: assigned,
        shiftDays: businessDaysBetween(line.idealStart, assigned),
      });
    }

    return { results, skippedNoDueDate, leadTimeDays, doorsPerDay };
  }

  function renderLevelingNote(container, leveling) {
    const moved = leveling.results.filter((r) => r.shiftDays !== 0);
    const later = moved.filter((r) => r.shiftDays > 0);
    const earlier = moved.filter((r) => r.shiftDays < 0);
    const parts = [
      `${leveling.results.length} jobs still to make with a due date, working back ${leveling.leadTimeDays} business day${leveling.leadTimeDays === 1 ? "" : "s"} for the start of manufacturing.`,
    ];
    if (moved.length === 0) {
      parts.push("Already smooth at this rate — no start dates need to move.");
    } else {
      parts.push(`${earlier.length} could start earlier, ${later.length} would need to move later to stay at ${leveling.doorsPerDay}/day${later.length ? " (shown as late below)" : ""}.`);
    }
    if (leveling.skippedNoDueDate) {
      parts.push(`${leveling.skippedNoDueDate} job${leveling.skippedNoDueDate === 1 ? "" : "s"} skipped — no due date set.`);
    }
    container.textContent = parts.join(" ");
  }

  function renderLevelingChart(container, leveling) {
    if (leveling.results.length === 0) {
      container.innerHTML = '<div class="chart-empty">No open lines with a due date for this stage.</div>';
      return;
    }

    const rawByDate = new Map();
    const leveledByDate = new Map();
    for (const r of leveling.results) {
      const rk = dateKey(r.idealStart);
      const lk = dateKey(r.suggestedStart);
      rawByDate.set(rk, (rawByDate.get(rk) || 0) + r.qty);
      leveledByDate.set(lk, (leveledByDate.get(lk) || 0) + r.qty);
    }

    const allDates = [...leveling.results.map((r) => r.idealStart), ...leveling.results.map((r) => r.suggestedStart)];
    const minDate = new Date(Math.min(...allDates));
    const maxDate = new Date(Math.max(...allDates));

    const days = [];
    forEachBusinessDay(minDate, maxDate, (d) => days.push(d));

    const w = 900;
    const h = 240;
    const padL = 44;
    const padR = 16;
    const padT = 16;
    const padB = 30;
    const plotW = w - padL - padR;
    const plotH = h - padT - padB;

    const n = days.length;
    const maxV = Math.max(leveling.doorsPerDay, ...days.map((d) => rawByDate.get(dateKey(d)) || 0), ...days.map((d) => leveledByDate.get(dateKey(d)) || 0));
    const slotW = plotW / n;
    const groupPad = slotW * 0.18;
    const barW = (slotW - groupPad * 2) / 2;

    const y = (v) => padT + plotH - (v / maxV) * plotH;
    const capY = y(leveling.doorsPerDay);

    const gridLines = [0, 0.25, 0.5, 0.75, 1].map((f) => {
      const yy = padT + plotH * (1 - f);
      return `<line class="svg-grid" x1="${padL}" y1="${yy.toFixed(1)}" x2="${w - padR}" y2="${yy.toFixed(1)}"></line>`;
    });

    const bars = days
      .map((d, i) => {
        const key = dateKey(d);
        const rawV = rawByDate.get(key) || 0;
        const levV = leveledByDate.get(key) || 0;
        const slotX = padL + i * slotW;
        const rawX = slotX + groupPad;
        const levX = rawX + barW;
        const rawCls = rawV > leveling.doorsPerDay ? "svg-bar-over" : "svg-bar-raw";
        const levCls = levV > leveling.doorsPerDay ? "svg-bar-over" : "svg-bar-leveled";
        const rawY = y(rawV);
        const levY = y(levV);
        return `
          <rect class="${rawCls}" x="${rawX.toFixed(1)}" y="${rawY.toFixed(1)}" width="${barW.toFixed(1)}" height="${(padT + plotH - rawY).toFixed(1)}"><title>${fmtDayDate(d)} — as due: ${fmtNum(rawV)} doors</title></rect>
          <rect class="${levCls}" x="${levX.toFixed(1)}" y="${levY.toFixed(1)}" width="${barW.toFixed(1)}" height="${(padT + plotH - levY).toFixed(1)}"><title>${fmtDayDate(d)} — suggested: ${fmtNum(levV)} doors</title></rect>`;
      })
      .join("");

    const labelEvery = Math.ceil(n / 10) || 1;
    const xLabels = days
      .map((d, i) => {
        if (i % labelEvery !== 0 && i !== n - 1) return "";
        const cx = padL + i * slotW + slotW / 2;
        return `<text class="svg-label" x="${cx.toFixed(1)}" y="${h - 8}" text-anchor="middle">${fmtDayDate(d)}</text>`;
      })
      .join("");

    container.innerHTML = `
      <div class="chart-legend">
        <span class="legend-item"><span class="legend-swatch" style="background:var(--gridline)"></span>As due (working back ${leveling.leadTimeDays}bd)</span>
        <span class="legend-item"><span class="legend-swatch" style="background:var(--series-1)"></span>Suggested (smoothed)</span>
        <span class="legend-item"><span class="legend-swatch" style="background:var(--status-critical)"></span>Over ${leveling.doorsPerDay}/day</span>
      </div>
      <svg viewBox="0 0 ${w} ${h}" role="img" aria-label="Doors needed to start manufacturing by day, raw vs smoothed">
        ${gridLines.join("")}
        <line class="svg-axis" x1="${padL}" y1="${padT + plotH}" x2="${w - padR}" y2="${padT + plotH}"></line>
        ${bars}
        <line class="svg-capacity-line" x1="${padL}" y1="${capY.toFixed(1)}" x2="${w - padR}" y2="${capY.toFixed(1)}"></line>
        ${xLabels}
      </svg>`;
  }

  const LEVELING_COLUMNS = [
    {
      key: "order",
      label: "Order",
      render: (r) => `<div class="cell-primary">${r.rec.pro || "—"}</div><div class="cell-muted">${soLabel(r.rec.so)}</div>`,
    },
    { key: "customer", label: "Customer", render: (r) => customerLabel(r.rec.customer) },
    {
      key: "item",
      label: "Item",
      render: (r) => `<div>${r.rec.item || "—"}</div>`,
    },
    { key: "qty", label: "To make", cls: "cell-num", render: (r) => fmtNum(r.qty) },
    { key: "due", label: "Due", render: (r) => fmtDate(r.rec.due_date) },
    { key: "ideal", label: "Ideal start", render: (r) => fmtDate(r.idealStart) },
    { key: "suggested", label: "Suggested start", render: (r) => fmtDate(r.suggestedStart) },
    {
      key: "shift",
      label: "Shift",
      render: (r) =>
        r.shiftDays < 0
          ? `<span class="badge badge-good">${Math.abs(r.shiftDays)} bd earlier</span>`
          : `<span class="badge badge-critical">${r.shiftDays} bd late</span>`,
    },
  ];

  function renderLevelingTable(tableEl, leveling) {
    const thead = tableEl.querySelector("thead");
    const tbody = tableEl.querySelector("tbody");
    const moved = leveling.results.filter((r) => r.shiftDays !== 0).sort((a, b) => new Date(a.rec.operation_due_date) - new Date(b.rec.operation_due_date));

    thead.innerHTML = "<tr>" + LEVELING_COLUMNS.map((c) => `<th style="cursor:default">${c.label}</th>`).join("") + "</tr>";

    if (moved.length === 0) {
      tbody.innerHTML = `<tr><td colspan="${LEVELING_COLUMNS.length}" class="cell-muted" style="padding:24px;text-align:center;">No suggested movements</td></tr>`;
      return;
    }

    tbody.innerHTML = moved
      .map((r) => "<tr>" + LEVELING_COLUMNS.map((c) => `<td class="${c.cls || ""}">${c.render(r)}</td>`).join("") + "</tr>")
      .join("");
  }

  function renderLevelingCard(doorsPerDay, leadTimeDays) {
    const noteEl = $("#leveling-note");
    const chartEl = $("#leveling-chart");
    const tableEl = $("#leveling-table");
    const leveling = computeLeveling(doorsPerDay, leadTimeDays);
    renderLevelingNote(noteEl, leveling);
    renderLevelingChart(chartEl, leveling);
    renderLevelingTable(tableEl, leveling);
  }

  function renderCapacityCard() {
    const snap = state.data.joinery;
    const summaryEl = $("#capacity-summary");
    const chartEl = $("#capacity-chart");
    const stageWrap = $("#capacity-stage-wrap");
    const stageSelect = $("#capacity-stage");
    const rateInput = $("#capacity-rate");
    const leadTimeInput = $("#capacity-leadtime");

    if (!snap || snap.records.length === 0) {
      summaryEl.innerHTML = "";
      chartEl.innerHTML = '<div class="chart-empty">No data yet.</div>';
      stageWrap.hidden = true;
      $("#leveling-note").textContent = "";
      $("#leveling-chart").innerHTML = "";
      $("#leveling-table").querySelector("thead").innerHTML = "";
      $("#leveling-table").querySelector("tbody").innerHTML = "";
      return;
    }

    // this card answers for the Make+Press line only, so there's no per-work-centre
    // choice to make any more
    stageWrap.hidden = true;

    rateInput.value = state.capacity.doorsPerDay;
    rateInput.onchange = () => {
      const v = Math.max(1, Math.round(Number(rateInput.value) || 1));
      state.capacity.doorsPerDay = v;
      rateInput.value = v;
      localStorage.setItem("capacityDoorsPerDay", String(v));
      renderCapacityCard();
    };

    leadTimeInput.value = state.capacity.leadTimeDays;
    leadTimeInput.onchange = () => {
      const v = Math.max(0, Math.round(Number(leadTimeInput.value) || 0));
      state.capacity.leadTimeDays = v;
      leadTimeInput.value = v;
      localStorage.setItem("capacityLeadTime", String(v));
      renderCapacityCard();
    };

    const schedule = computeCapacitySchedule(state.capacity.doorsPerDay);
    renderCapacitySummary(summaryEl, schedule);
    renderCapacityChart(chartEl, schedule);

    renderLevelingCard(state.capacity.doorsPerDay, state.capacity.leadTimeDays);
  }

  // ---------- top-level render per view ----------

  function wireFilterBar(prefix, dataset, onChange) {
    const searchEl = $(`#${prefix}-search`);
    searchEl.value = state.filters[dataset].search;
    searchEl.oninput = () => {
      state.filters[dataset].search = searchEl.value;
      onChange();
    };

    $$(`#${prefix}-chips .chip`).forEach((chip) => {
      const key = chip.dataset.filter;
      chip.classList.toggle("is-active", state.filters[dataset].chips.has(key));
      chip.onclick = () => {
        const set = state.filters[dataset].chips;
        if (set.has(key)) set.delete(key);
        else set.add(key);
        chip.classList.toggle("is-active");
        onChange();
      };
    });
  }

  function wireExpandControls(prefix, dataset, allRecords, onChange) {
    const fs = state.filters[dataset];
    const visibleRecords = applyFilters(allRecords, fs);
    const prefixFn = dataset === "subcontractors" ? (r) => `sub:${r.work_centre_no || "Unknown"}` : () => prefix;
    $(`#${prefix}-expandAll`).onclick = () => expandCollapseAll(visibleRecords, prefixFn, true, onChange);
    $(`#${prefix}-collapseAll`).onclick = () => expandCollapseAll(visibleRecords, prefixFn, false, onChange);
  }

  function renderJoinery() {
    const snap = state.data.joinery;
    const statsEl = $("#joinery-stats");
    const tableWrap = $("#joinery-table").closest(".table-wrap");
    const emptyEl = $("#joinery-empty");
    const tableEl = $("#joinery-table");

    if (!snap) {
      statsEl.innerHTML = "";
      tableEl.hidden = true;
      emptyEl.hidden = false;
      renderHistoryChart($("#joinery-chart"), null);
      renderCapacityCard();
      return;
    }
    tableEl.hidden = false;
    emptyEl.hidden = true;

    renderStats(statsEl, snap.records, { showDistinctPro: true });
    renderHistoryChart($("#joinery-chart"), state.history.joinery);
    renderCapacityCard();

    wireFilterBar("joinery", "joinery", renderJoinery);
    wireExpandControls("joinery", "joinery", snap.records, renderJoinery);

    const fs = state.filters.joinery;
    const rows = applyFilters(snap.records, fs);

    renderGroupedTableInto(tableEl, rows, JOINERY_CHILD_COLUMNS, fs.sort, (key) => {
      if (fs.sort.key === key) fs.sort.dir = fs.sort.dir === "asc" ? "desc" : "asc";
      else fs.sort = { key, dir: "asc" };
      renderJoinery();
    }, "joinery", renderJoinery);
  }

  // ---------- subcontractor scheduling board ----------

  // how many orders a lane shows before it needs unfolding
  const SUB_LANE_PREVIEW = 5;

  const SUB_LANES = [
    { id: "waiting_material", label: "Waiting on material" },
    { id: "ready_despatch", label: "Ready to despatch" },
    { id: "at_sub", label: "At subcontractor" },
    { id: "ready", label: "Ready / back" },
  ];

  // the two lanes that feed the run sheet — the running order here drives despatch
  // sequence, so it's settable straight from the collapsed SO header
  const PRIORITY_LANES = new Set(["ready_despatch", "at_sub"]);

  const CONTRACTOR_LOGOS = {
    "SUB-ANODISERS": "assets/WAANO.png",
    POWDERLINE: "assets/POWDERLINE.png",
  };

  function subEtaCell(job) {
    if (!job.eta_date) return "";
    const eta = new Date(job.eta_date);
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const late = eta < today;
    // flag when the date came straight from BC's PO rather than being confirmed by us
    const src = job.eta_from_po ? '<span class="sub-eta-src" title="From the purchase order — not yet confirmed with the sub">PO</span>' : "";
    return `<span class="${late ? "sub-eta-late" : ""}">ETA ${fmtDate(job.eta_date)}</span>${src}`;
  }

  function subCardHTML(job) {
    const dueTxt = job.due_date
      ? job.overdue
        ? `<span class="text-critical">Due ${fmtDate(job.due_date)} · ${Math.abs(job.due_in_days)}d overdue</span>`
        : `<span class="cell-muted">Due ${fmtDate(job.due_date)}</span>`
      : '<span class="cell-muted">No due date</span>';

    const showEta = job.status === "at_sub";
    const noteHtml = job.eta_note ? `<div class="sub-card-note" title="${escapeAttr(job.eta_note)}">${job.eta_note}</div>` : "";

    // BC says this PO is fully received, but the board still has it out at the sub
    const receivedFlag =
      job.po_received && job.status === "at_sub"
        ? '<div class="sub-card-alert">BC says this PO is fully received — move to Ready?</div>'
        : "";
    // only chase paperwork where it still matters — a closed PO ageing out of the
    // export on an already-finished job isn't worth flagging
    const chaseable = job.status === "ready_despatch" || job.status === "at_sub";
    const unmatchedFlag =
      chaseable && (job.po_unmatched || []).length
        ? `<div class="sub-card-warn">${job.po_unmatched.join(", ")} not in the PO export</div>`
        : "";
    const noPoFlag = chaseable && !job.sub_po ? '<div class="sub-card-warn">No PO raised</div>' : "";

    const poLine = job.po
      ? `<div class="sub-card-muted">Raised ${fmtDate(job.po.order_date)}${
          job.days_out !== null && job.days_out !== undefined ? ` · <b>${job.days_out}d out</b>` : ""
        }${job.po.value_incl_gst ? ` · $${fmtNum(job.po.value_incl_gst)}` : ""}</div>`
      : "";

    return `<div class="sub-card" draggable="true"
      data-pro="${job.prod_order_no}" data-wc="${job.work_centre_no}" data-status="${job.status}">
      <div class="sub-card-top">
        <span class="sub-card-pro">${job.prod_order_no}</span>
        <span class="sub-card-so">${soLabel(job.sales_order_no)}</span>
        <span class="sub-card-qty">${fmtNum(job.remaining_qty || job.qty)} ${job.uom || "EA"}</span>
      </div>
      <div class="sub-card-line">${customerLabel(job.source_name)}</div>
      <div class="sub-card-muted">${job.item_description || ""}</div>
      ${job.colour_description ? `<div class="sub-card-muted">${job.colour_description}</div>` : ""}
      <div class="sub-card-muted">${job.sub_po ? job.sub_po + " · " : ""}${job.operation_name || ""}</div>
      ${poLine}
      <div class="sub-card-muted">${dueTxt} ${showEta ? "· " + subEtaCell(job) : ""}</div>
      ${receivedFlag}${unmatchedFlag}${noPoFlag}
      ${noteHtml}
      ${
        showEta
          ? `<div class="sub-card-controls">
              <input type="date" class="sub-eta" data-pro="${job.prod_order_no}" data-wc="${job.work_centre_no}" value="${job.eta_date || ""}" title="ETA back from subcontractor">
            </div>`
          : ""
      }
    </div>`;
  }

  // Powderline is measured in lengths (LTHS) while doors are each (EA) — summing
  // them into one number would be meaningless, so total per unit instead.
  function qtyByUom(jobs) {
    const totals = new Map();
    for (const j of jobs) {
      const u = j.uom || "EA";
      totals.set(u, (totals.get(u) || 0) + (j.remaining_qty || j.qty || 0));
    }
    return totals;
  }

  function fmtQtyTotals(jobs) {
    const totals = qtyByUom(jobs);
    if (totals.size === 0) return "0";
    return Array.from(totals.entries())
      .sort((a, b) => b[1] - a[1])
      .map(([u, n]) => `${fmtNum(n)} ${u}`)
      .join(" · ");
  }

  function sortSubJobs(jobs) {
    return [...jobs].sort(
      (a, b) =>
        a.priority - b.priority ||
        (a.due_date || "9999-99-99").localeCompare(b.due_date || "9999-99-99") ||
        a.prod_order_no.localeCompare(b.prod_order_no)
    );
  }

  function renderSubLaneCards(laneJobs, wc, laneId) {
    if (laneJobs.length === 0) return '<div class="sub-lane-empty">Nothing here</div>';

    const groups = new Map();
    for (const j of laneJobs) {
      const so = soLabel(j.sales_order_no);
      if (!groups.has(so)) groups.set(so, []);
      groups.get(so).push(j);
    }

    // running order: whatever number you've set, then soonest due for anything unranked
    const ordered = Array.from(groups.entries()).sort((a, b) => {
      const [, ja] = a;
      const [, jb] = b;
      const pa = Math.min(...ja.map((j) => j.priority));
      const pb = Math.min(...jb.map((j) => j.priority));
      if (pa !== pb) return pa - pb;
      const da = ja.map((j) => j.due_date || "9999-99-99").sort()[0];
      const db = jb.map((j) => j.due_date || "9999-99-99").sort()[0];
      return da.localeCompare(db) || a[0].localeCompare(b[0]);
    });

    // A busy lane can run to dozens of orders, which buries the ones that matter.
    // Show the first few — they're already in running order — and let the rest be
    // unfolded. The rank still counts through the hidden ones, so the numbers on
    // screen stay the real running order rather than restarting at the cut.
    const laneKey = `${wc}|${laneId}`;
    const showAll = state.subLaneExpanded.has(laneKey);
    const visible = showAll ? ordered : ordered.slice(0, SUB_LANE_PREVIEW);
    const hidden = ordered.length - visible.length;

    const moreToggle =
      ordered.length > SUB_LANE_PREVIEW
        ? `<button type="button" class="sub-lane-more" data-lane-key="${escapeAttr(laneKey)}">${
            showAll ? "▴ Show fewer" : `▾ ${hidden} more`
          }</button>`
        : "";

    return visible
      .map(([so, jobs], groupIndex) => {
        const groupKey = `sub:${wc}|${laneId}|${so}`;
        const isExpanded = state.expanded.has(groupKey);
        const sorted = sortSubJobs(jobs);
        const qtyLabel = fmtQtyTotals(sorted);
        const anyOverdue = sorted.some((j) => j.overdue);
        const payload = sorted.map((j) => ({ pro: j.prod_order_no, wc: j.work_centre_no }));

        const isRanked = PRIORITY_LANES.has(laneId);
        const rank = groupIndex + 1;
        const rankBadge = isRanked ? `<span class="sub-rank" title="Running order — drag to reorder">${rank}</span>` : "";
        const rankControl = isRanked
          ? `<div class="sub-group-controls" draggable="false">
              <span class="sub-group-prilabel">Order</span>
              <input type="number" class="sub-group-rank" draggable="false" min="1" step="1" value="${rank}"
                     data-group-jobs="${escapeAttr(JSON.stringify(payload))}" data-lane="${laneId}" data-wc="${wc}"
                     title="Type a position to move ${so} in the running order">
            </div>`
          : "";

        const body = isExpanded ? `<div class="sub-group-body">${sorted.map(subCardHTML).join("")}</div>` : "";

        return `<div class="sub-group" data-group-key="${groupKey}" data-lane="${laneId}" data-wc="${wc}"
                     data-group-jobs="${escapeAttr(JSON.stringify(payload))}">
          <div class="sub-group-head" draggable="true" data-group-key="${groupKey}"
               data-group-jobs="${escapeAttr(JSON.stringify(payload))}" data-wc="${wc}"
               title="Drag to reorder, or onto another lane to move the whole sales order">
            <div class="sub-group-top">
              ${rankBadge}
              <span class="sub-group-chevron">${isExpanded ? "▾" : "▸"}</span>
              <span class="sub-group-so">${so}</span>
              <span class="sub-group-count">${qtyLabel} · ${sorted.length} PRO${sorted.length === 1 ? "" : "s"}</span>
            </div>
            <div class="sub-group-customer">${customerLabel(sorted[0].source_name)}</div>
            ${anyOverdue ? '<div class="sub-group-flag text-critical">Overdue</div>' : ""}
            ${rankControl}
          </div>
          ${body}
        </div>`;
      })
      .join("") + moreToggle;
  }

  function filterSubJobs(jobs, search) {
    const q = search.trim().toLowerCase();
    if (!q) return jobs;
    return jobs.filter((j) =>
      [j.prod_order_no, j.sales_order_no, j.source_name, j.item_description, j.sub_po, j.colour_description]
        .filter(Boolean)
        .some((v) => String(v).toLowerCase().includes(q))
    );
  }

  function laneGroupOrder(wc, laneId) {
    return $$(`.sub-group[data-wc="${wc}"][data-lane="${laneId}"]`).map((el) => ({
      key: el.dataset.groupKey,
      jobs: JSON.parse(el.dataset.groupJobs || "[]"),
    }));
  }

  async function saveLaneOrder(orderedGroups, laneId) {
    const items = [];
    orderedGroups.forEach((g, i) => {
      for (const j of g.jobs) {
        items.push({ prod_order_no: j.pro, work_centre_no: j.wc, priority: i + 1, status: laneId });
      }
    });
    if (!items.length) return;
    try {
      await postJSON("/api/subcontractors/reorder", { items });
    } catch (e) {
      console.error(e);
      showSubError(e.message || "Couldn't save the new order.");
    }
    await loadSubBoard();
    renderSubBoard();
  }

  function moveGroupToPosition(lane, fromIdx, toIdx, laneId) {
    const next = [...lane];
    const [moved] = next.splice(fromIdx, 1);
    next.splice(Math.max(0, Math.min(toIdx, next.length)), 0, moved);
    return saveLaneOrder(next, laneId);
  }

  function showSubError(msg) {
    const el = $("#subboard-error");
    el.textContent = msg;
    el.hidden = false;
    clearTimeout(el._t);
    el._t = setTimeout(() => (el.hidden = true), 4000);
  }

  async function saveSubStatus(target, fields) {
    // target is either {pro, wc} or an array of them
    const jobs = Array.isArray(target) ? target : [target];
    const failures = [];
    // sequential, so each write sees the one before it
    for (const j of jobs) {
      try {
        await postJSON("/api/subcontractors/status", { prod_order_no: j.pro, work_centre_no: j.wc, ...fields });
      } catch (e) {
        failures.push(e);
      }
    }
    await loadSubBoard();
    renderSubBoard();

    if (failures.length) {
      console.error(failures);
      showSubError(
        jobs.length === 1
          ? failures[0].message || "Couldn't save that change."
          : `Updated ${jobs.length - failures.length} of ${jobs.length} — ${failures[0].message || "some couldn't save."}`
      );
    }
  }

  function wireSubBoardInteractions() {
    $$(".sub-lane-more").forEach((btn) => {
      btn.addEventListener("click", (e) => {
        e.stopPropagation();
        const key = btn.dataset.laneKey;
        if (state.subLaneExpanded.has(key)) state.subLaneExpanded.delete(key);
        else state.subLaneExpanded.add(key);
        renderSubBoard();
      });
    });

    $$(".sub-card[draggable='true']").forEach((card) => {
      card.addEventListener("dragstart", (e) => {
        e.stopPropagation();
        e.dataTransfer.setData("text/plain", JSON.stringify({ jobs: [{ pro: card.dataset.pro, wc: card.dataset.wc }] }));
        e.dataTransfer.effectAllowed = "move";
      });
    });

    $$(".sub-group-head").forEach((head) => {
      head.addEventListener("dragstart", (e) => {
        e.stopPropagation();
        let jobs = [];
        try {
          jobs = JSON.parse(head.dataset.groupJobs || "[]");
        } catch (err) {
          jobs = [];
        }
        e.dataTransfer.setData("text/plain", JSON.stringify({ jobs }));
        e.dataTransfer.effectAllowed = "move";
      });
      head.addEventListener("click", () => {
        const key = head.dataset.groupKey;
        if (state.expanded.has(key)) state.expanded.delete(key);
        else state.expanded.add(key);
        renderSubBoard();
      });
    });

    $$(".sub-lane-body").forEach((lane) => {
      lane.addEventListener("dragover", (e) => {
        e.preventDefault();
        lane.classList.add("is-dragover");
      });
      lane.addEventListener("dragleave", () => lane.classList.remove("is-dragover"));
      lane.addEventListener("drop", async (e) => {
        e.preventDefault();
        lane.classList.remove("is-dragover");
        let d;
        try {
          d = JSON.parse(e.dataTransfer.getData("text/plain"));
        } catch (err) {
          return;
        }
        const jobs = (d && d.jobs) || [];
        // don't move between contractors
        const movable = jobs.filter((j) => j.wc === lane.dataset.contractor);
        if (movable.length === 0) return;
        await saveSubStatus(movable, { status: lane.dataset.status });
      });
    });

    $$(".sub-group-rank").forEach((inp) => {
      // keep clicks off the header so editing the number doesn't collapse/drag the group
      inp.addEventListener("click", (e) => e.stopPropagation());
      inp.addEventListener("mousedown", (e) => e.stopPropagation());
      inp.addEventListener("dragstart", (e) => e.preventDefault());
      inp.addEventListener("change", (e) => {
        e.stopPropagation();
        const target = Math.max(1, Math.round(Number(inp.value) || 1));
        const lane = laneGroupOrder(inp.dataset.wc, inp.dataset.lane);
        const from = lane.findIndex((g) => g.key === inp.closest(".sub-group").dataset.groupKey);
        if (from < 0) return;
        moveGroupToPosition(lane, from, target - 1, inp.dataset.lane);
      });
    });

    // drop onto another group in the same lane = reorder to that position
    $$(".sub-group").forEach((grp) => {
      grp.addEventListener("dragover", (e) => {
        if (!PRIORITY_LANES.has(grp.dataset.lane)) return;
        e.preventDefault();
        e.stopPropagation();
        const rect = grp.getBoundingClientRect();
        const below = e.clientY > rect.top + rect.height / 2;
        grp.classList.toggle("drop-below", below);
        grp.classList.toggle("drop-above", !below);
      });
      grp.addEventListener("dragleave", () => grp.classList.remove("drop-above", "drop-below"));
      grp.addEventListener("drop", async (e) => {
        if (!PRIORITY_LANES.has(grp.dataset.lane)) return;
        e.preventDefault();
        e.stopPropagation();
        const below = grp.classList.contains("drop-below");
        grp.classList.remove("drop-above", "drop-below");

        let d;
        try {
          d = JSON.parse(e.dataTransfer.getData("text/plain"));
        } catch (err) {
          return;
        }
        const jobs = (d && d.jobs) || [];
        if (!jobs.length || jobs[0].wc !== grp.dataset.wc) return;

        const lane = laneGroupOrder(grp.dataset.wc, grp.dataset.lane);
        const targetIdx = lane.findIndex((g) => g.key === grp.dataset.groupKey);
        const fromIdx = lane.findIndex((g) => g.jobs.some((j) => j.pro === jobs[0].pro));

        if (fromIdx >= 0) {
          // reordering inside the lane
          let to = below ? targetIdx + 1 : targetIdx;
          if (fromIdx < to) to -= 1;
          moveGroupToPosition(lane, fromIdx, to, grp.dataset.lane);
        } else {
          // arriving from another lane — insert at this position
          const insertAt = below ? targetIdx + 1 : targetIdx;
          const incoming = { key: "incoming", jobs };
          const next = [...lane];
          next.splice(insertAt, 0, incoming);
          await saveLaneOrder(next, grp.dataset.lane);
        }
      });
    });

    $$(".sub-eta").forEach((inp) => {
      inp.addEventListener("click", (e) => e.stopPropagation());
      inp.addEventListener("change", (e) => {
        e.stopPropagation();
        if (inp.value) saveSubStatus({ pro: inp.dataset.pro, wc: inp.dataset.wc }, { eta_date: inp.value });
      });
    });

    $$(".sub-runsheet-btn").forEach((btn) => {
      btn.addEventListener("click", () => buildSubRunSheet(btn.dataset.wc, btn.dataset.contractor));
    });
  }

  function renderSubBoard() {
    const boardsEl = $("#sub-contractor-boards");
    const updatedEl = $("#subboard-updated");
    const data = state.data.subBoard;

    if (!data || !data.jobs) {
      boardsEl.innerHTML = `<div class="empty-state">${escapeAttr(noDataMessage("subcontractor export"))}</div>`;
      updatedEl.textContent = "";
      return;
    }
    updatedEl.textContent = `Planner as of ${fmtDate(data.as_of)}`;

    wireFilterBar("subboard", "subboard", renderSubBoard);
    const jobs = filterSubJobs(data.jobs, state.filters.subboard.search);

    const byContractor = new Map();
    for (const j of jobs) {
      if (!byContractor.has(j.work_centre_no)) byContractor.set(j.work_centre_no, { name: j.contractor, wc: j.work_centre_no, jobs: [] });
      byContractor.get(j.work_centre_no).jobs.push(j);
    }

    if (byContractor.size === 0) {
      boardsEl.innerHTML = '<div class="empty-state">No jobs match your search.</div>';
      return;
    }

    boardsEl.innerHTML = Array.from(byContractor.values())
      .sort((a, b) => a.name.localeCompare(b.name))
      .map((c) => {
        const lanes = SUB_LANES.map((lane) => {
          const laneJobs = sortSubJobs(c.jobs.filter((j) => j.status === lane.id));
          const laneQty = fmtQtyTotals(laneJobs);
          const body = renderSubLaneCards(laneJobs, c.wc, lane.id);
          return `<div class="sub-lane sub-lane-${lane.id}">
            <div class="sub-lane-head"><span>${lane.label}</span><span class="lane-count">${laneJobs.length} · ${laneQty}</span></div>
            <div class="sub-lane-body" data-status="${lane.id}" data-contractor="${c.wc}">${body}</div>
          </div>`;
        }).join("");

        const outCount = c.jobs.filter((j) => j.status === "at_sub").length;
        const receivedStale = c.jobs.filter((j) => j.status === "at_sub" && j.po_received).length;
        const outstandingValue = c.jobs
          .filter((j) => j.status === "at_sub" && j.po)
          .reduce((s, j) => s + (j.po.value_incl_gst || 0), 0);

        const logo = CONTRACTOR_LOGOS[c.wc];
        return `<div class="sub-contractor">
          <div class="sub-contractor-head">
            ${logo ? `<span class="sub-logo"><img src="${logo}" alt="${escapeAttr(c.name)} logo"></span>` : ""}
            <h3>${c.name}</h3>
            <span class="sub-meta">${c.jobs.length} jobs · ${outCount} out at sub${
              outstandingValue ? ` · $${fmtNum(Math.round(outstandingValue))} out` : ""
            }</span>
            ${
              receivedStale
                ? `<span class="sub-badge-alert" title="BC shows these purchase orders as fully received">${receivedStale} received in BC</span>`
                : ""
            }
            <button class="btn sub-runsheet-btn" data-wc="${c.wc}" data-contractor="${escapeAttr(c.name)}">Print run sheet</button>
          </div>
          <div class="sub-lanes">${lanes}</div>
        </div>`;
      })
      .join("");

    wireSubBoardInteractions();
  }

  const RUN_SHEET_SECTIONS = [
    { id: "at_sub", label: "In production" },
    { id: "ready_despatch", label: "Material ready for manufacture" },
    { id: "waiting_material", label: "Coming — waiting on material" },
  ];

  function printHeaderHTML(kicker, title, metaRows) {
    return `<div class="print-header">
      <div>
        <div class="print-sheet-kicker">${kicker}</div>
        <div class="print-sheet-title">${title}</div>
      </div>
      <div class="print-header-meta">${metaRows.join("")}</div>
    </div>`;
  }

  function printFooterHTML(signoffLabels) {
    return `<div class="print-footer">
      <div>Queensland Production Dashboard · figures reflect quantities still outstanding</div>
      <div class="print-signoff">${signoffLabels.map((l) => `<span>${l}: </span>`).join("")}</div>
    </div>`;
  }

  function dueCellHTML(job) {
    if (!job.due_date) return "—";
    const txt = fmtDate(job.due_date);
    return job.overdue ? `<span class="cell-late">${txt}</span>` : txt;
  }

  function buildSubRunSheet(wc, contractorName) {
    const jobs = ((state.data.subBoard && state.data.subBoard.jobs) || []).filter((j) => j.work_centre_no === wc);
    const now = new Date();

    const active = jobs.filter((j) => RUN_SHEET_SECTIONS.some((s) => s.id === j.status));
    const lateCount = active.filter((j) => j.overdue).length;

    let html = printHeaderHTML("Subcontractor run sheet", contractorName, [
      `<strong>${now.toLocaleDateString(undefined, { weekday: "long", day: "2-digit", month: "long", year: "numeric" })}</strong>`,
      `Printed ${now.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" })}`,
    ]);

    html += `<div class="print-totals">
      <span><b>${active.length}</b> jobs</span>
      <span><b>${fmtQtyTotals(active)}</b> outstanding</span>
      ${lateCount ? `<span class="cell-late"><b>${lateCount}</b> past due</span>` : ""}
      <span>Listed in running order — work top to bottom</span>
    </div>`;

    for (const section of RUN_SHEET_SECTIONS) {
      const rows = sortSubJobs(jobs.filter((j) => j.status === section.id));
      const showEta = section.id === "at_sub";

      html += `<div class="print-stage-block">
        <h3>${section.label} &nbsp;·&nbsp; ${rows.length} job${rows.length === 1 ? "" : "s"}, ${fmtQtyTotals(rows)}</h3>`;

      if (rows.length === 0) {
        html += '<div class="print-empty">Nothing in this group</div>';
      } else {
        // fixed widths so every section's columns line up down the page
        const cols = showEta
          ? `<col style="width:4%"><col style="width:11%"><col style="width:15%"><col style="width:30%">
             <col style="width:13%"><col style="width:6%"><col style="width:10%"><col style="width:11%">`
          : `<col style="width:4%"><col style="width:11%"><col style="width:16%"><col style="width:32%">
             <col style="width:14%"><col style="width:6%"><col style="width:9%"><col style="width:8%">`;

        let seq = 0;
        html += `<table class="print-table"><colgroup>${cols}</colgroup><thead><tr>
            <th class="col-seq">#</th>
            <th>Order</th>
            <th>Customer</th>
            <th>Item</th>
            <th>Colour / finish</th>
            <th class="col-num">Qty</th>
            <th class="col-date">Due</th>
            <th>${showEta ? "ETA back" : "Done ✓"}</th>
          </tr></thead><tbody>`;

        for (const j of rows) {
          seq += 1;
          html += `<tr>
            <td class="col-seq">${seq}</td>
            <td class="col-key">${j.prod_order_no}<span class="cell-sub">${soLabel(j.sales_order_no)}</span></td>
            <td>${customerLabel(j.source_name)}</td>
            <td>${j.item_description || "—"}${j.sub_po ? `<span class="cell-sub">${j.sub_po}</span>` : ""}</td>
            <td>${j.colour_description || "—"}</td>
            <td class="col-num">${fmtNum(j.remaining_qty || j.qty)}<span class="cell-sub">${j.uom || "EA"}</span></td>
            <td class="col-date">${dueCellHTML(j)}</td>
            ${
              showEta
                ? `<td class="col-date">${j.eta_date ? fmtDate(j.eta_date) : "—"}${
                    j.days_out !== null && j.days_out !== undefined ? `<span class="cell-sub">${j.days_out}d out</span>` : ""
                  }</td>`
                : '<td class="col-tick"></td>'
            }
          </tr>`;
        }
        html += "</tbody></table>";
      }
      html += "</div>";
    }

    html += printFooterHTML(["Despatched by", "Date", "Received by"]);

    $("#print-sheet").innerHTML = html;
    window.print();
  }

  function wireSubViewToggle() {
    $$("#sub-view-toggle .segmented-btn").forEach((btn) => {
      btn.classList.toggle("is-active", btn.dataset.mode === state.filters.subboard.viewMode);
      btn.onclick = () => {
        state.filters.subboard.viewMode = btn.dataset.mode;
        localStorage.setItem("subViewMode", btn.dataset.mode);
        renderSubcontractors();
      };
    });
  }

  function renderSubcontractors() {
    wireSubViewToggle();
    const isBoard = state.filters.subboard.viewMode === "board";
    $("#sub-board").hidden = !isBoard;
    $("#sub-list").hidden = isBoard;
    if (isBoard) {
      renderSubBoard();
      return;
    }

    const snap = state.data.subcontractors;
    const statsEl = $("#sub-stats");
    const groupsEl = $("#contractor-groups");
    const emptyEl = $("#sub-empty");

    if (!snap) {
      statsEl.innerHTML = "";
      groupsEl.innerHTML = "";
      emptyEl.hidden = false;
      renderHistoryChart($("#sub-chart"), null);
      return;
    }
    emptyEl.hidden = true;

    renderStats(statsEl, snap.records);
    renderHistoryChart($("#sub-chart"), state.history.subcontractors);

    wireFilterBar("sub", "subcontractors", renderSubcontractors);
    wireExpandControls("sub", "subcontractors", snap.records, renderSubcontractors);

    const fs = state.filters.subcontractors;
    let rows = applyFilters(snap.records, fs);

    const groups = new Map();
    for (const r of rows) {
      const key = r.work_centre_no || "Unknown";
      if (!groups.has(key)) groups.set(key, { name: r.work_centre_description || key, code: key, records: [] });
      groups.get(key).records.push(r);
    }

    const sortedGroups = Array.from(groups.values()).sort((a, b) => a.name.localeCompare(b.name));

    if (sortedGroups.length === 0) {
      groupsEl.innerHTML = '<div class="empty-state">No rows match the current filters.</div>';
      return;
    }

    groupsEl.innerHTML = sortedGroups
      .map((g, idx) => {
        const openCount = g.records.filter((r) => r.is_open).length;
        return `
        <div class="contractor-card">
          <div class="contractor-card-head">
            <h3>${g.name}</h3>
            <span class="contractor-meta">${openCount} open · ${g.records.length} lines</span>
          </div>
          <div class="table-wrap" style="border:none;border-radius:0;">
            <table class="data-table" data-group="${idx}">
              <thead></thead>
              <tbody></tbody>
            </table>
          </div>
        </div>`;
      })
      .join("");

    sortedGroups.forEach((g, idx) => {
      const tableEl = groupsEl.querySelector(`table[data-group="${idx}"]`);
      renderGroupedTableInto(tableEl, g.records, SUB_CHILD_COLUMNS, fs.sort, (key) => {
        if (fs.sort.key === key) fs.sort.dir = fs.sort.dir === "asc" ? "desc" : "asc";
        else fs.sort = { key, dir: "asc" };
        renderSubcontractors();
      }, `sub:${g.code}`, renderSubcontractors);
    });
  }

  // ---------- factory floor ----------

  // Every stage that can exist, in shop order. Glazing and edge stripping apply
  // only to doors whose description carries the marker, so each job carries its
  // own subset in row.stages and the table shows those columns only when some
  // job on screen actually needs them.
  const FACTORY_STAGES = ["make", "press", "cnc", "glazing", "edge_strip", "finish"];
  const BASE_FACTORY_STAGES = ["make", "press", "cnc", "finish"];
  const OPTIONAL_FACTORY_STAGES = ["glazing", "edge_strip"];

  function stagesOfRow(r) {
    const list = r && r.stages && r.stages.length ? r.stages : BASE_FACTORY_STAGES;
    return list.filter((s) => FACTORY_STAGES.includes(s) || CAV_STAGES.includes(s));
  }

  // Doors and cavities are separate lines with their own stages, so the floor
  // shows one at a time. The table, the day view and ticking work off are the
  // same screen either way — only the data, the stages and where a tick is
  // saved change.
  function floorLineConfig(id) {
    if (id === "cavities") {
      return {
        id,
        data: state.cavities.as_of ? { as_of: state.cavities.as_of, rows: state.cavities.rows } : null,
        rows: state.cavities.rows,
        stages: CAV_STAGES,
        finalStage: "cav_make",
        progressUrl: "/api/cavities/progress",
        unit: ["unit", "units"],
        stagesText: "Prep and Make",
        exportName: "Production Scheduler export (Cavities)",
        labels: false,
      };
    }
    return {
      id: "doors",
      data: state.data.factory,
      rows: factoryRows(),
      stages: FACTORY_STAGES,
      finalStage: "finish",
      progressUrl: "/api/factory/progress",
      unit: ["door", "doors"],
      stagesText: "Make, Press, CNC and Finish",
      exportName: "Production Scheduler export (Joinery)",
      labels: true,
    };
  }

  const floorLine = () => floorLineConfig(state.filters.factory.line);
  const unitsText = (line, n) => `${fmtNum(n)} ${n === 1 ? line.unit[0] : line.unit[1]}`;

  // Columns to draw for the current list: the four everything has, plus any
  // optional stage at least one listed job needs.
  function visibleStageColumns(rows) {
    const needed = new Set();
    for (const r of rows) for (const s of stagesOfRow(r)) needed.add(s);
    return FACTORY_STAGES.filter(
      (s) => !OPTIONAL_FACTORY_STAGES.includes(s) || needed.has(s)
    );
  }

  function filterFactoryRows(rows, search) {
    const q = search.trim().toLowerCase();
    if (!q) return rows;
    return rows.filter((r) =>
      [r.prod_order_no, r.sales_order_no, r.source_name, r.item_summary]
        .filter(Boolean)
        .some((v) => String(v).toLowerCase().includes(q))
    );
  }

  function factoryDueCell(r) {
    if (!r.due_date) return '<span class="cell-muted">—</span>';
    const due = new Date(r.due_date);
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const diffDays = Math.round((due - today) / 86400000);
    const dateText = fmtDate(r.due_date);
    if (diffDays < 0) return `<span class="text-critical">${dateText} · ${Math.abs(diffDays)}d overdue</span>`;
    if (diffDays <= 2) return `<span class="text-warning">${dateText} · due in ${diffDays}d</span>`;
    return `<span class="cell-muted">${dateText}</span>`;
  }

  function stageCellHTML(stage, r) {
    const done = r[`${stage}_done`] || 0;
    const total = r.total_qty;
    const complete = done >= total;
    const completeBtn = complete
      ? ""
      : `<button type="button" class="stage-complete-btn" data-pro="${r.prod_order_no}" data-stage="${stage}" title="Mark all ${fmtNum(total)} done">✓</button>`;
    return `<div class="stage-cell">
      <input type="number" class="stage-input ${complete ? "is-complete" : ""}" data-pro="${r.prod_order_no}" data-stage="${stage}" min="0" max="${total}" step="1" value="${done}">
      <span class="stage-total">/ ${fmtNum(total)}</span>
      ${completeBtn}
    </div>`;
  }

  function wireStageControls(container) {
    $$(".stage-input", container).forEach((input) => {
      input.addEventListener("change", () => onStageInputChange(input));
    });
    $$(".stage-complete-btn", container).forEach((btn) => {
      btn.addEventListener("click", () => {
        const input = btn.closest(".stage-cell").querySelector(".stage-input");
        input.value = input.max;
        onStageInputChange(input);
      });
    });
  }

  function progressCellHTML(r) {
    const pct = Math.max(0, Math.min(100, r.pct_complete));
    const complete = pct >= 100;
    return `<div class="progress-cell">
      <div class="progress-track"><div class="progress-fill ${complete ? "is-complete" : ""}" style="width:${pct}%"></div></div>
      <span class="progress-pct">${pct.toFixed(0)}%</span>
    </div>`;
  }

  function recomputePct(r) {
    const total = r.total_qty || 1;
    const own = stagesOfRow(r);
    const sum = own.reduce((s, stage) => s + Math.min(r[`${stage}_done`] || 0, total) / total, 0);
    r.pct_complete = Math.round((sum / own.length) * 1000) / 10;
  }

  function capitalize(s) {
    return s.charAt(0).toUpperCase() + s.slice(1);
  }

  const STAGE_LABELS = { make: "Make", press: "Press", cnc: "CNC",
    glazing: "Glazing", edge_strip: "Edge strip", finish: "Finish",
    cav_prep: "Prep", cav_make: "Make" };
  function stageLabel(stage) {
    return STAGE_LABELS[stage] || capitalize(stage);
  }

  function validateStageChange(row, stage, value) {
    // Against this job's own stages: on a door with no glazing, Finish follows
    // CNC directly and must be compared to that, not to a stage it never has.
    const own = stagesOfRow(row);
    const idx = own.indexOf(stage);
    if (idx === -1) return `${stageLabel(stage)} isn't a stage on ${row.prod_order_no}.`;
    if (idx > 0) {
      const prevStage = own[idx - 1];
      const prevDone = row[`${prevStage}_done`] || 0;
      if (value > prevDone) {
        return `${stageLabel(stage)} can't be ahead of ${stageLabel(prevStage)} — only ${fmtNum(prevDone)} done there so far.`;
      }
    }
    if (idx < own.length - 1) {
      const nextStage = own[idx + 1];
      const nextDone = row[`${nextStage}_done`] || 0;
      if (value < nextDone) {
        return `${stageLabel(stage)} can't drop below ${stageLabel(nextStage)} — ${fmtNum(nextDone)} already done there.`;
      }
    }
    return null;
  }

  function showFactoryError(input, message) {
    const el = $("#factory-error");
    if (el) {
      el.textContent = message;
      el.hidden = false;
      clearTimeout(el._hideTimer);
      el._hideTimer = setTimeout(() => {
        el.hidden = true;
      }, 4000);
    }
    if (input) {
      input.title = message;
      input.classList.add("has-error");
      setTimeout(() => input.classList.remove("has-error"), 1500);
    }
  }

  async function onStageInputChange(input) {
    const pro = input.dataset.pro;
    const stage = input.dataset.stage;
    // The stage says which line the job is on, whichever the floor is showing.
    const line = floorLineConfig(CAV_STAGES.includes(stage) ? "cavities" : "doors");
    const row = line.rows.find((r) => r.prod_order_no === pro);
    if (!row) return;

    const previousValue = row[`${stage}_done`] || 0;
    let value = Math.max(0, Math.round(Number(input.value) || 0));
    value = Math.min(value, row.total_qty);

    const clientError = validateStageChange(row, stage, value);
    if (clientError) {
      input.value = previousValue;
      showFactoryError(input, clientError);
      return;
    }

    input.value = value;
    input.classList.add("is-saving");

    try {
      const result = await postJSON(line.progressUrl, { prod_order_no: pro, stage, done: value });
      line.stages.forEach((s) => (row[`${s}_done`] = result[`${s}_done`] || 0));
      recomputePct(row);
      // Posted counts as finished whatever was ticked — the server says the same,
      // and a tick on a posted job shouldn't flip it back into production.
      const nowCompleted = !!row.posted || row[`${line.finalStage}_done`] >= row.total_qty;
      row.status = nowCompleted ? "completed" : "in_production";
      row.completed_at = nowCompleted ? row.completed_at || new Date().toISOString() : null;
      renderFactory();
    } catch (e) {
      input.classList.remove("is-saving");
      input.value = previousValue;
      // A blocked change already has the dialog explaining itself; repeating it
      // in the strip above the table just says the same thing twice.
      if (!e.needsSignIn) {
        console.error(e);
        showFactoryError(input, e.message || "Couldn't save — try again.");
      }
    }
  }

  function wireFactoryStatusFilter(onChange) {
    $$("#factory-status-filter .segmented-btn").forEach((btn) => {
      btn.classList.toggle("is-active", btn.dataset.status === state.filters.factory.status);
      btn.onclick = () => {
        state.filters.factory.status = btn.dataset.status;
        localStorage.setItem("factoryStatusFilter", btn.dataset.status);
        onChange();
      };
    });
  }

  const FACTORY_EMPTY_TEXT = {
    in_production: "Nothing in production — everything on the floor is finished.",
    completed: "No completed jobs yet.",
    all: "No jobs found.",
  };

  function wireFactoryViewToggle() {
    $$("#factory-view-toggle .segmented-btn").forEach((btn) => {
      btn.classList.toggle("is-active", btn.dataset.mode === state.filters.factory.viewMode);
      btn.onclick = () => {
        state.filters.factory.viewMode = btn.dataset.mode;
        localStorage.setItem("factoryViewMode", btn.dataset.mode);
        renderFactory();
      };
    });
  }

  function wireFactoryLineToggle() {
    $$("#factory-line-toggle .segmented-btn").forEach((btn) => {
      btn.classList.toggle("is-active", btn.dataset.line === state.filters.factory.line);
      btn.onclick = () => {
        if (state.filters.factory.line === btn.dataset.line) return;
        state.filters.factory.line = btn.dataset.line;
        localStorage.setItem("factoryLine", btn.dataset.line);
        // Ticks don't carry across lines: a job picked on Doors is out of sight
        // on Cavities, and Reset shouldn't clear work nobody can see selected.
        state.selectedPros.clear();
        renderFactory();
      };
    });
  }

  function wireFactoryDayNav() {
    $("#factory-day-prev").addEventListener("click", () => {
      state.factoryDay = addBusinessDays(state.factoryDay || nextOrSameBusinessDay(new Date()), -1);
      renderFactory();
    });
    $("#factory-day-next").addEventListener("click", () => {
      state.factoryDay = addBusinessDays(state.factoryDay || nextOrSameBusinessDay(new Date()), 1);
      renderFactory();
    });
    $("#factory-day-today").addEventListener("click", () => {
      state.factoryDay = nextOrSameBusinessDay(new Date());
      renderFactory();
    });
  }

  // The day view is the board's work seen a day at a time, so it shows the same
  // stages the board does — Glazing included, and only when a door needs it.
  function factoryDayStages() {
    return scheduleSections().flatMap((section) => section.stages);
  }

  function renderFactoryDay() {
    if (!state.factoryDay) state.factoryDay = nextOrSameBusinessDay(new Date());
    const day = state.factoryDay;
    const dayK = dateKey(day);
    const todayK = dateKey(nextOrSameBusinessDay(new Date()));
    const isToday = dayK === todayK;
    $("#factory-day-label").textContent = fmtDayDate(day) + (isToday ? " · Today" : "");

    const bucketsEl = $("#factory-day-buckets");
    const fs = state.filters.factory;
    const line = floorLine();
    const cavities = line.id === "cavities";
    const allRows = line.rows || [];
    const rowByPro = new Map(allRows.map((r) => [r.prod_order_no, r]));
    const searchable = new Set(filterFactoryRows(allRows, fs.search).map((r) => r.prod_order_no));

    // Read the same cards the board for this line draws. Reading the bookings
    // table instead left this view blank wherever the work wasn't dragged onto
    // a day — which is most CNC, since CNC follows a dated Make rather than
    // being booked in its own right.
    const cardsByCell = cavities
      ? buildCavityCells(allRows)
      : buildScheduleCells(allRows, computeMakeAnchors());

    function cardsForDay(stage) {
      const out = [];
      for (const [key, cards] of cardsByCell) {
        const sep = key.lastIndexOf("|");
        const d = key.slice(0, sep);
        if (key.slice(sep + 1) !== stage || d === HOLDING_DATE) continue;
        if (d === dayK) out.push(...cards);
        // Unfinished work from earlier days rolls into today on its own; work
        // already done stays on the day it was done and isn't dragged forward.
        // Posted is done too, ticked or not — BC closed it, and a posted job
        // nobody ticked off would otherwise sit in today's list for good.
        else if (isToday && d < dayK) out.push(...cards.filter((c) => !c.stageComplete && !c.posted));
      }
      return out;
    }

    bucketsEl.innerHTML = (cavities ? CAV_STAGES : factoryDayStages()).map((stage) => {
      const perPro = new Map();
      for (const c of cardsForDay(stage)) {
        if (!searchable.has(c.pro)) continue;
        const r = rowByPro.get(c.pro);
        if (!r) continue;
        const cur = perPro.get(c.pro) || { r, qty: 0 };
        cur.qty += c.qty || 0;
        perPro.set(c.pro, cur);
      }
      // Cap at the order quantity — a job split across days shouldn't read as
      // more doors than the order has.
      const bucketRows = [...perPro.values()].map((b) => ({
        r: b.r,
        qty: Math.min(b.qty, b.r.total_qty || b.qty),
      }));

      // The floor works this list top to bottom, so it runs in the order the
      // board was put in — the day's ranking, not the due date. Anything not
      // ranked keeps falling back to the due date behind the ranked work.
      // Cavities have no running order of their own yet, so theirs is by date.
      const section = (scheduleSections().find((s) => s.stages.includes(stage)) || {}).id;
      for (const b of bucketRows) {
        b.rank = cavities ? 0 : priorityOf(dayK, section, soLabel(b.r.sales_order_no));
      }
      bucketRows.sort(
        (a, b) =>
          a.rank - b.rank ||
          (a.r.due_date || "9999-99-99").localeCompare(b.r.due_date || "9999-99-99")
      );
      const totalDoors = bucketRows.reduce((s, b) => s + b.qty, 0);

      const body =
        bucketRows.length === 0
          ? '<div class="factory-bucket-empty">Nothing scheduled</div>'
          : `<div class="table-wrap" style="border:none;border-radius:0;"><table class="data-table factory-table"><thead>
              <tr><th class="col-rank">#</th><th>Order</th><th>Customer</th><th>Item</th><th>Due</th><th>To do</th><th>${stageLabel(stage)} done</th></tr></thead><tbody>` +
            bucketRows
              .map(
                ({ r, qty }, i) => `<tr>
                <td class="col-rank">${i + 1}</td>
                <td><div class="cell-primary">${r.prod_order_no}</div><div class="cell-muted">${soLabel(r.sales_order_no)}</div></td>
                <td>${customerLabel(r.source_name)}</td>
                <td>${r.item_summary || "—"}</td>
                <td>${factoryDueCell(r)}</td>
                <td class="cell-num"><strong>${fmtNum(qty)}</strong></td>
                <td>${stageCellHTML(stage, r)}</td>
              </tr>`
              )
              .join("") +
            "</tbody></table></div>";

      return `<div class="factory-bucket">
        <div class="factory-bucket-head"><h3>${stageLabel(stage)}</h3><span>${unitsText(line, totalDoors)} · ${bucketRows.length} job${bucketRows.length === 1 ? "" : "s"}</span></div>
        ${body}
      </div>`;
    }).join("");

    wireStageControls(bucketsEl);
  }

  function renderFactory() {
    const line = floorLine();
    const data = line.data;
    const statsEl = $("#factory-stats");
    const tableEl = $("#factory-table");
    const emptyEl = $("#factory-empty");
    const updatedEl = $("#factory-updated");
    const dayEl = $("#factory-day");
    const tableWrapEl = $("#factory-table-wrap");
    const statusFilterEl = $("#factory-status-filter");

    // Wired before the no-data check: a line with nothing uploaded yet still
    // needs its switch, or there'd be no way back to the other one.
    wireFactoryLineToggle();

    if (!data || !data.rows) {
      statsEl.innerHTML = "";
      tableEl.hidden = true;
      dayEl.hidden = true;
      // The message lives inside the table's wrapper, which day mode hides.
      tableWrapEl.style.display = "";
      emptyEl.hidden = false;
      emptyEl.textContent = noDataMessage(line.exportName);
      updatedEl.textContent = "";
      return;
    }

    updatedEl.textContent = `Planner as of ${fmtDate(data.as_of)}`;

    const fs = state.filters.factory;
    wireFactoryViewToggle();
    wireFactoryStatusFilter(renderFactory);
    wireFilterBar("factory", "factory", renderFactory);

    const isDayMode = fs.viewMode === "day";
    dayEl.hidden = !isDayMode;
    tableWrapEl.style.display = isDayMode ? "none" : "";
    statusFilterEl.style.display = isDayMode ? "none" : "";
    statsEl.style.display = isDayMode ? "none" : "";

    if (isDayMode) {
      renderFactoryResetBar();
      renderFactoryDay();
      return;
    }

    const byStatus = fs.status === "all" ? data.rows : data.rows.filter((r) => r.status === fs.status);
    const rows = filterFactoryRows(byStatus, fs.search);
    if (fs.status === "all") {
      rows.sort((a, b) => (a.status === "completed") - (b.status === "completed"));
    }

    const avgPct = byStatus.length ? byStatus.reduce((s, r) => s + r.pct_complete, 0) / byStatus.length : 0;
    const totalDoors = byStatus.reduce((s, r) => s + r.total_qty, 0);
    statsEl.innerHTML = [
      ["Jobs", byStatus.length, ""],
      [capitalize(line.unit[1]), fmtNum(totalDoors), ""],
      ["Avg. completion", `${avgPct.toFixed(0)}%`, ""],
    ]
      .map(
        ([label, value, cls]) => `
      <div class="stat-tile ${cls}">
        <div class="stat-label">${label}</div>
        <div class="stat-value">${value}</div>
      </div>`
      )
      .join("");

    if (rows.length === 0) {
      tableEl.hidden = true;
      emptyEl.hidden = false;
      emptyEl.textContent = byStatus.length === 0 ? FACTORY_EMPTY_TEXT[fs.status] : "No jobs match your search.";
      renderFactoryResetBar();
      return;
    }
    tableEl.hidden = false;
    emptyEl.hidden = true;

    const thead = tableEl.querySelector("thead");
    const tbody = tableEl.querySelector("tbody");
    const allPicked = rows.length > 0 && rows.every((r) => state.selectedPros.has(r.prod_order_no));
    const stageCols = line.id === "cavities" ? CAV_STAGES : visibleStageColumns(rows);
    thead.innerHTML =
      `<tr><th class="col-pick"><input type="checkbox" class="factory-pick-all" ${allPicked ? "checked" : ""} title="Select all shown"></th>` +
      "<th>Order</th><th>Customer</th><th>Item</th><th>Due</th><th>Total</th>" +
      stageCols.map((s) => `<th>${stageLabel(s)}</th>`).join("") +
      // Door and pallet labels are door stock; cavities don't print them.
      (line.labels ? '<th class="col-labels">Labels</th>' : "") +
      "<th>% Complete</th></tr>";

    tbody.innerHTML = rows
      .map((r) => {
        const showBadge = fs.status === "all" && r.status === "completed";
        const picked = state.selectedPros.has(r.prod_order_no);
        return `<tr class="${r.status === "completed" ? "is-completed-row" : ""} ${picked ? "is-picked" : ""}">
          <td class="col-pick"><input type="checkbox" class="factory-pick" data-pro="${r.prod_order_no}" ${picked ? "checked" : ""}></td>
          <td class="col-pro"><div class="cell-primary">${r.prod_order_no} ${showBadge ? '<span class="completed-badge">✓ Done</span>' : ""}</div><div class="cell-muted">${r.sales_order_no || ""}</div></td>
          <td class="col-customer">${customerLabel(r.source_name)}</td>
          <td class="col-item">${r.item_summary || "—"}</td>
          <td class="col-due" data-label="Due">${factoryDueCell(r)}</td>
          <td class="cell-num col-qty" data-label="${capitalize(line.unit[1])}">${fmtNum(r.total_qty)}</td>
          ${stageCols.map((s) => stagesOfRow(r).includes(s)
              ? `<td class="col-stage" data-label="${stageLabel(s)}">${stageCellHTML(s, r)}</td>`
              // this door doesn't go through that stage at all
              : `<td class="col-stage col-stage-na" data-label="${stageLabel(s)}">—</td>`
            ).join("")}
          ${line.labels ? `<td class="col-labels" data-label="Labels">${labelCellHTML(r)}</td>` : ""}
          <td class="col-progress" data-label="Progress">${progressCellHTML(r)}</td>
        </tr>`;
      })
      .join("");

    wireStageControls(tbody);
    wireLabelButtons(tbody);
    wireFactoryPickers(rows);
  }

  function wireFactoryPickers(rows) {
    $$(".factory-pick").forEach((box) => {
      box.addEventListener("change", () => {
        if (box.checked) state.selectedPros.add(box.dataset.pro);
        else state.selectedPros.delete(box.dataset.pro);
        renderFactory();
      });
    });

    const all = $(".factory-pick-all");
    if (all) {
      all.addEventListener("change", () => {
        // only affects what's currently listed, so a search filter narrows it
        for (const r of rows) {
          if (all.checked) state.selectedPros.add(r.prod_order_no);
          else state.selectedPros.delete(r.prod_order_no);
        }
        renderFactory();
      });
    }

    renderFactoryResetBar();
  }

  function renderFactoryResetBar() {
    const wrap = $("#factory-reset-wrap");
    const btn = $("#factory-reset");
    const hint = $("#factory-reset-hint");
    const isAllJobs = state.filters.factory.viewMode !== "day";

    wrap.hidden = !isAllJobs;
    if (!isAllJobs) return;

    const n = state.selectedPros.size;
    btn.disabled = n === 0;
    hint.textContent = n === 0 ? "Tick jobs to reset" : `${n} job${n === 1 ? "" : "s"} selected`;
  }

  function wireFactoryReset() {
    $("#factory-reset").addEventListener("click", async () => {
      const pros = Array.from(state.selectedPros);
      if (pros.length === 0) return;

      const line = floorLine();
      const rows = (line.rows || []).filter((r) => state.selectedPros.has(r.prod_order_no));
      const withProgress = rows.filter((r) => r.pct_complete > 0);
      const proSet = new Set(pros);
      const datedEntries = state.schedule.entries.filter(
        (e) => proSet.has(e.prod_order_no) && e.scheduled_date !== HOLDING_DATE
      ).length;
      const preview = pros.slice(0, 8).join(", ") + (pros.length > 8 ? `, +${pros.length - 8} more` : "");

      const ok = confirm(
        `Reset ${pros.length} job${pros.length === 1 ? "" : "s"}?\n\n  ${preview}\n\n` +
          `• ${withProgress.length} with recorded progress → ${line.stagesText} back to zero\n` +
          `• ${datedEntries} scheduled entr${datedEntries === 1 ? "y" : "ies"} → moved back to Holding\n\n` +
          `The jobs return to an unstarted, unplanned state. This can't be undone.`
      );
      if (!ok) return;

      try {
        const res = await postJSON("/api/factory/reset", { prod_order_nos: pros });
        state.selectedPros.clear();
        await Promise.all([refreshScheduleAndFactory(), loadCavities()]);
        renderFactory();
        alert(
          `Reset done — progress cleared on ${res.cleared} job${res.cleared === 1 ? "" : "s"}, ` +
            `${res.unallocated} scheduled entr${res.unallocated === 1 ? "y" : "ies"} moved back to Holding.`
        );
      } catch (e) {
        notifyError(e, "Couldn't reset those jobs.");
      }
    });
  }

  // ---------- scheduling board ----------

  // Finish is left out of the scheduling board for now — still tracked on the Factory floor tab.
  const ALL_SCHEDULE_SECTIONS = [
    { id: "make_press", label: "Make + Press", stages: ["make", "press"], capacityCheck: true },
    { id: "cnc", label: "CNC", stages: ["cnc"], capacityCheck: false },
    { id: "glazing", label: "Glazing", stages: ["glazing"], capacityCheck: false, optional: true },
  ];

  // Glazing is only some doors, so the row earns its place only when a job on
  // the books actually needs it. It's all days or none, never just the days
  // that happen to have glazing on them — a day showing no glazing row is a day
  // with nowhere to drop a glazing card, and the work could never be moved on
  // to it.
  function scheduleSections() {
    const rows = (state.data.factory && state.data.factory.rows) || [];
    const needed = new Set();
    for (const r of rows) for (const s of stagesOfRow(r)) needed.add(s);
    return ALL_SCHEDULE_SECTIONS.filter(
      (section) => !section.optional || section.stages.some((s) => needed.has(s))
    );
  }

  const HOLDING_DATE = "holding";

  function nextOrSameBusinessDay(date) {
    const d = new Date(date);
    d.setHours(0, 0, 0, 0);
    while (!isWeekday(d)) d.setDate(d.getDate() + 1);
    return d;
  }

  function mostRecentOrSameMonday(date) {
    const d = new Date(date);
    d.setHours(0, 0, 0, 0);
    const day = d.getDay(); // 0=Sun .. 6=Sat
    const diff = day === 0 ? -6 : 1 - day;
    d.setDate(d.getDate() + diff);
    return d;
  }

  function parseDateKey(s) {
    const [y, m, d] = s.split("-").map(Number);
    return new Date(y, m - 1, d);
  }

  function computeMakeAnchors() {
    const doorsPerDay = state.capacity.doorsPerDay;
    const leadTimeDays = state.capacity.leadTimeDays;
    const rows = (state.data.factory && state.data.factory.rows) || [];
    const today0 = nextOrSameBusinessDay(new Date());

    const explicitMakeQty = new Map();
    for (const e of state.schedule.entries) {
      if (e.stage !== "make") continue;
      explicitMakeQty.set(e.prod_order_no, (explicitMakeQty.get(e.prod_order_no) || 0) + e.qty);
    }

    const lines = rows
      .filter((r) => r.status !== "completed")
      .map((r) => {
        const already = explicitMakeQty.get(r.prod_order_no) || 0;
        const remaining = Math.max(0, (r.total_qty || 0) - (r.make_done || 0) - already);
        const idealStart = r.due_date ? addBusinessDays(new Date(r.due_date), -leadTimeDays) : today0;
        return { pro: r.prod_order_no, due: r.due_date, qty: remaining, idealStart };
      })
      .filter((l) => l.qty > 0.001)
      .sort((a, b) => (a.due || "9999-99-99").localeCompare(b.due || "9999-99-99"));

    const capacityUsed = new Map();
    const canFit = (d, qty) => {
      const k = dateKey(d);
      const u = capacityUsed.get(k) || 0;
      return u === 0 || u + qty <= doorsPerDay;
    };
    const book = (d, qty) => {
      const k = dateKey(d);
      capacityUsed.set(k, (capacityUsed.get(k) || 0) + qty);
    };

    const anchors = new Map();
    for (const line of lines) {
      const windowEnd = line.idealStart > today0 ? line.idealStart : today0;
      let assigned = null;
      forEachBusinessDay(today0, windowEnd, (d) => {
        if (!assigned && canFit(d, line.qty)) assigned = d;
      });
      if (!assigned) {
        let d = addBusinessDays(windowEnd, 1);
        for (let i = 0; i < 250 && !assigned; i++) {
          if (canFit(d, line.qty)) assigned = d;
          else d = addBusinessDays(d, 1);
        }
      }
      book(assigned, line.qty);
      anchors.set(line.pro, { date: assigned, qty: line.qty });
    }
    return anchors;
  }

  function buildScheduleCells(factoryRows, anchors) {
    const map = new Map();
    const push = (dKey, stage, card) => {
      // A posted job is finished and gone from BC. It keeps its place on the
      // days it was planned and worked, because that's the record of those
      // days — but it has no business in Holding, which is a list of work
      // still to do and would never be worked down again.
      if (card.posted && dKey === HOLDING_DATE) return;
      const key = `${dKey}|${stage}`;
      if (!map.has(key)) map.set(key, []);
      map.get(key).push(card);
    };

    const explicitByProStage = new Map();
    for (const e of state.schedule.entries) {
      const key = `${e.prod_order_no}|${e.stage}`;
      if (!explicitByProStage.has(key)) explicitByProStage.set(key, []);
      explicitByProStage.get(key).push(e);
    }

    for (const row of factoryRows) {
      // Finished jobs stay on the board as the record of what was done —
      // ticking Finish shouldn't wipe the day clean, and nothing below removes
      // a card for being complete.
      const pro = row.prod_order_no;

      // Each stage follows the one before it, not Make directly. Pull a Press
      // back to Holding and CNC has nothing to follow, so it comes back too —
      // you can't CNC a door that hasn't been pressed.
      let prevDateKey = null;

      for (const stage of stagesOfRow(row)) {
        const total = row.total_qty || 0;
        const done = row[`${stage}_done`] || 0;
        // Completed stages stay on the board, filled fully green, so the day still
        // shows what was actually worked rather than emptying out as it's finished.
        const stageComplete = total > 0 && done >= total;

        const explicit = explicitByProStage.get(`${pro}|${stage}`) || [];
        const explicitSum = explicit.reduce((s, e) => s + e.qty, 0);
        const leftover = Math.max(0, total - done - explicitSum);

        // A card dragged onto a day wins; a card dragged into Holding is a
        // deliberate "not yet" and must not be re-dated by the chain.
        const explicitDated = explicit.filter((e) => e.scheduled_date !== HOLDING_DATE);
        const explicitHeld = explicit.length > 0 && explicitDated.length === 0;
        const earliestDated = explicitDated.length
          ? explicitDated.reduce((min, e) => (e.scheduled_date < min ? e.scheduled_date : min), explicitDated[0].scheduled_date)
          : null;

        for (const e of explicit) {
          push(e.scheduled_date, stage, {
            pro,
            so: row.sales_order_no,
            stage,
            qty: e.qty,
            entryId: e.id,
            confirmed: true,
            stageComplete,
            // How many pieces this PRO's stage is currently in. Only a job
            // that's actually been split has anything to join back.
            chunks: explicit.length,
            customer: boardCustomerLabel(row),
            wm: row.wm_number || null,
            posted: !!row.posted,
            item: row.item_summary,
            due: row.due_date,
          });
        }

        let stageDateKey;
        if (explicitDated.length > 0) {
          // Dragged onto a day: that date wins and the rest of the chain hangs
          // off it, so a dated Press still carries CNC even if Make is held.
          stageDateKey = earliestDated;
        } else if (explicitHeld) {
          // Dragged into Holding: a deliberate "not yet", so it waits — and
          // everything downstream waits with it.
          stageDateKey = HOLDING_DATE;
        } else if (stage === "make") {
          // Work nobody has scheduled yet waits in Holding rather than being
          // scattered across days on a guess — you decide what runs when, and
          // the days only ever show work someone actually committed to.
          stageDateKey = HOLDING_DATE;
        } else if (prevDateKey && prevDateKey !== HOLDING_DATE) {
          stageDateKey = dateKey(addBusinessDays(parseDateKey(prevDateKey), state.scheduleOffsets[stage] || 0));
        } else {
          stageDateKey = HOLDING_DATE; // nothing dated ahead of it to follow
        }
        prevDateKey = stageDateKey;

        // Work still to do, on the day it's expected.
        // Finished work that was never dragged onto a day belongs on the board
        // too. A booking always draws its card whether or not it's done, but a
        // suggested card's quantity is what's left — so finishing the stage took
        // it to zero and wiped the job off the day. On the board it was real
        // work on that day, and the schedule is the record of what got done.
        const uncommitted = Math.max(0, total - explicitSum);
        const suggestedQty = leftover > 0.001 ? leftover : stageComplete ? uncommitted : 0;

        // Finished work stays wherever it sits, Holding included. A job worked
        // without ever being dragged onto a day has no day to show it on, and
        // hiding it would mean the board silently forgot work that was done.
        if (suggestedQty > 0.001) {
          push(stageDateKey, stage, {
            pro,
            so: row.sales_order_no,
            stage,
            qty: suggestedQty,
            entryId: null,
            confirmed: false,
            stageComplete,
            customer: boardCustomerLabel(row),
            wm: row.wm_number || null,
            posted: !!row.posted,
            item: row.item_summary,
            due: row.due_date,
          });
        }
      }
    }
    return map;
  }

  const STAGE_TAG_LETTER = { make: "M", press: "P", cnc: "C", glazing: "G", edge_strip: "E", finish: "F" };

  // How far through this stage the job is, straight from Factory floor entries.
  // 2 of 4 doors made => 0.5 on that PRO's Make card.
  function stageProgress(pro, stage) {
    const f = state.factoryByPro.get(pro);
    if (!f) return { done: 0, total: 0, pct: 0 };
    const total = f.total_qty || 0;
    const done = Math.min(f[`${stage}_done`] || 0, total);
    return { done, total, pct: total > 0 ? done / total : 0 };
  }

  function progressFillStyle(pct) {
    if (pct <= 0) return "";
    const stop = Math.min(100, Math.round(pct * 1000) / 10);
    // hard-stop gradient reads as a fill bar behind the card's own content
    return ` style="background-image: linear-gradient(to right, var(--progress-fill) 0 ${stop}%, transparent ${stop}% 100%)"`;
  }

  function scheduleCardHTML(card, cardKey) {
    const p = stageProgress(card.pro, card.stage);
    const done = p.pct >= 1 && p.total > 0;
    const picked = state.selectedCards.has(cardKey);
    const cls = `schedule-card ${card.confirmed ? "" : "is-suggested"} ${done ? "is-stage-done" : ""} ${picked ? "is-selected" : ""}`;
    const dueText = card.due ? fmtDate(card.due) : "";
    // Join only shows on a job that's in more than one piece — on an unsplit
    // card it would do nothing, and three buttons on a card this size is a lot.
    const joinBtn = card.chunks > 1
      ? `<button class="sc-btn" type="button" data-action="join" data-chunks="${card.chunks}" title="Join all ${card.chunks} pieces of this PRO back into one">🔗</button>`
      : "";
    const actions = card.confirmed
      ? `<span class="sc-actions">
          ${joinBtn}
          <button class="sc-btn" type="button" data-action="split" title="Split this chunk">✂</button>
          <button class="sc-btn" type="button" data-action="remove" title="Unschedule">×</button>
        </span>`
      : "";
    const progressText = done
      ? ` · <span class="sc-done">✓ ${stageLabel(card.stage).toLowerCase()} done</span>`
      : p.total > 0
        ? ` · ${fmtNum(p.done)}/${fmtNum(p.total)} ${stageLabel(card.stage).toLowerCase()}`
        : "";
    return `<div class="${cls}"${progressFillStyle(p.pct)} draggable="true" data-card-key="${escapeAttr(cardKey)}" data-pro="${card.pro}" data-stage="${card.stage}" data-qty="${card.qty}" data-entry-id="${card.entryId ?? ""}" data-confirmed="${card.confirmed}" data-progress="${Math.round(p.pct * 100)}" title="${stageLabel(card.stage)} — ${fmtNum(p.done)} of ${fmtNum(p.total)} done — ${card.item || ""}">
      ${actions}
      <input type="checkbox" class="schedule-card-pick" data-card-key="${escapeAttr(cardKey)}" ${picked ? "checked" : ""} title="Select this PRO to move with others">
      <span class="stage-dot" title="${stageLabel(card.stage)}">${STAGE_TAG_LETTER[card.stage]}</span>
      <span class="sc-pro">${card.pro}</span>
      <span class="sc-so">${card.so || ""}</span>
      <span class="sc-meta">${fmtNum(card.qty)}× ${card.customer || ""}</span>
      <span class="sc-meta">Due ${dueText || "—"}${progressText}</span>
    </div>`;
  }

  function escapeAttr(str) {
    return String(str).replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  }

  // Unranked orders sort after every ranked one. Infinity rather than a big
  // number so no amount of hand-ranking can ever overtake it.
  function priorityOf(dKey, sectionId, so) {
    const p = state.schedule.priorities[`${dKey}|${sectionId}|${so}`];
    return p === undefined ? Infinity : p;
  }

  // The corner badge on an order's header, shared by the door and cavity
  // boards: POSTED when BC has closed the whole order out, otherwise WM when a
  // warehouse movement has been written against it.
  function orderBadge(groupCards, so) {
    // A warehouse movement belongs to the order, so one job carrying the number
    // marks the whole SO. Stock doors are the exception: they have no order to
    // belong to and are grouped together, so a group can hold several — name
    // them all rather than picking one and implying the rest match.
    const wmNumbers = [...new Set(groupCards.map((c) => c.wm).filter(Boolean))];
    const wm = wmNumbers.length ? wmNumbers.join(", ") : null;

    // POSTED takes the movement's place, and only when every job under the SO
    // has gone. Part of an order being posted doesn't make the order posted,
    // and saying so would send someone looking for work still to do.
    const posted = groupCards.length > 0 && groupCards.every((c) => c.posted);

    const badge = posted
      ? `<span class="posted-flag" title="Posted in Business Central — off the latest export, kept here as the record of the day">POSTED</span>`
      : wm
        ? `<span class="wm-flag" role="button" tabindex="0" data-wm="${escapeAttr(wm)}" data-wm-so="${escapeAttr(so)}" title="Warehouse movement${wmNumbers.length > 1 ? "s" : ""} — click for the number">WM</span>`
        : "";
    return { badge, posted };
  }

  function scheduleGroupHeaderHTML(so, customer, total, count, groupKey, isExpanded, groupCards, rank) {
    const payload = groupCards.map((c) => ({
      pro: c.pro,
      stage: c.stage,
      qty: c.qty,
      entryId: c.entryId,
      confirmed: c.confirmed,
    }));
    const isSelected = state.selectedGroups.has(groupKey);

    // group fill = progress across every card in it, so a collapsed SO still
    // shows how far along it is
    let gDone = 0;
    let gTotal = 0;
    for (const c of groupCards) {
      const p = stageProgress(c.pro, c.stage);
      gDone += p.done;
      gTotal += p.total;
    }
    const gPct = gTotal > 0 ? gDone / gTotal : 0;
    const { badge, posted } = orderBadge(groupCards, so);

    return `<div class="schedule-group-head ${isSelected ? "is-selected" : ""} ${posted ? "is-posted" : ""} ${badge ? "has-wm" : ""}"${progressFillStyle(gPct)} draggable="true" data-group-key="${groupKey}" data-group-cards="${escapeAttr(JSON.stringify(payload))}" title="${Math.round(gPct * 100)}% complete — drag to move the whole SO, tick to move several at once">
      <div class="schedule-group-top">
        <input type="checkbox" class="schedule-group-pick" data-group-key="${groupKey}" ${isSelected ? "checked" : ""} title="Select this SO to move with others">
        ${rank ? `<span class="group-rank" title="Job ${rank} in this day's running order — drag up or down to change it">${rank}</span>` : ""}
        <span class="schedule-group-chevron">${isExpanded ? "▾" : "▸"}</span>
        <span class="schedule-group-so">${so}</span>
        <span class="schedule-group-count">${fmtNum(total)}× · ${count} PRO${count === 1 ? "" : "s"}</span>
      </div>
      <div class="schedule-group-customer" title="${customer || ""}">${customer || ""}</div>
      ${badge}
    </div>`;
  }

  // ---------- locked days and the day's score ----------

  function dayPlan(dKey) {
    return state.schedule.dayPlans[dKey] || null;
  }

  // What a locked day was promised, against what it actually got.
  //
  // A line only scores if the work is still on the day it was locked for.
  // Doing it late is fine — someone entering Wednesday's doors on Thursday
  // morning still made them on Wednesday — but moving the card to Thursday is
  // the day not being achieved, which is the whole reason the plan is frozen.
  function dayScore(dKey, cardsByCell, stages) {
    const plan = dayPlan(dKey);
    if (!plan) return null;

    const wanted = new Set(stages);
    const lines = plan.lines.filter((l) => wanted.has(l.stage));
    if (lines.length === 0) return { planned: 0, done: 0, moved: 0, pct: null, movedPros: [] };

    // what's on the day right now, per PRO and stage
    const onDay = new Map();
    for (const stage of stages) {
      for (const c of cardsByCell.get(`${dKey}|${stage}`) || []) {
        const key = `${c.pro}|${stage}`;
        onDay.set(key, (onDay.get(key) || 0) + (c.qty || 0));
      }
    }

    let planned = 0;
    let done = 0;
    let moved = 0;
    const movedPros = [];

    for (const line of lines) {
      planned += line.qty;
      const key = `${line.prod_order_no}|${line.stage}`;
      if (!onDay.has(key)) {
        moved += line.qty;
        movedPros.push(line.prod_order_no);
        continue;
      }
      // Credit is capped at what was promised: a job split across two days
      // can't finish this one on the strength of the other day's doors.
      const p = stageProgress(line.prod_order_no, line.stage);
      done += Math.min(p.done, line.qty);
    }

    return {
      planned,
      done,
      moved,
      movedPros: [...new Set(movedPros)],
      pct: planned > 0 ? done / planned : null,
    };
  }

  function scoreClass(pct) {
    if (pct === null) return "";
    if (pct >= 1) return "is-score-good";
    if (pct >= 0.85) return "is-score-near";
    return "is-score-short";
  }

  // Percentage first, deliberately. The stage label already carries a ratio —
  // the day's load against capacity — and two ratios side by side read as the
  // same kind of number when they aren't.
  function scoreHTML(score) {
    if (!score || score.planned <= 0) return "";
    const pct = Math.round(score.pct * 100);
    const movedNote = score.moved > 0 ? ` · ${fmtNum(score.moved)} moved off` : "";
    return `<span class="day-score ${scoreClass(score.pct)}" title="Locked plan ${fmtNum(score.planned)} doors — ${fmtNum(score.done)} done${movedNote}">${pct}% · ${fmtNum(score.done)} of ${fmtNum(score.planned)}</span>`;
  }

  // Every locked line for a PRO+stage, so moving a card can say which day it
  // was promised to.
  function lockedDaysFor(pro, stage) {
    const out = [];
    for (const [dKey, plan] of Object.entries(state.schedule.dayPlans)) {
      if (plan.lines.some((l) => l.prod_order_no === pro && l.stage === stage)) out.push(dKey);
    }
    return out;
  }

  function dedupedDoorTotal(cards) {
    // a door counts once even if it appears in both Make and Press that day
    const perPro = new Map();
    for (const c of cards) {
      perPro.set(c.pro, Math.max(perPro.get(c.pro) || 0, c.qty));
    }
    return Array.from(perPro.values()).reduce((s, q) => s + q, 0);
  }

  // A card is one PRO's chunk of one stage in one cell, so its identity has to
  // carry where it sits as well as what it is — the same PRO and stage split in
  // two is two cards, and Holding's copy isn't the day column's.
  function cardKeyFor(dKey, sectionId, card) {
    return `card:${dKey}|${sectionId}|${card.pro}|${card.stage}|${card.entryId ?? "s"}`;
  }

  // Ticks outlive a re-render, so they have to be dropped when the card behind
  // one stops existing. Filled from the board as it's built.
  let liveCardKeys = new Set();

  function renderCellCards(cards, dKey, sectionId) {
    if (cards.length === 0) return "";

    const groups = new Map();
    for (const c of cards) {
      const so = soLabel(c.so);
      if (!groups.has(so)) groups.set(so, []);
      groups.get(so).push(c);
    }

    // Holding is a backlog you work down, so the most urgent job is at the top.
    // The day columns stay in SO order — there the work is already committed and
    // grouping by order is easier to read off a run sheet.
    const earliestDue = (cardList) =>
      cardList.reduce((min, c) => (c.due && (!min || c.due < min) ? c.due : min), null) || "9999-99-99";

    const byDueThenSo = (a, b) =>
      earliestDue(a[1]).localeCompare(earliestDue(b[1])) || a[0].localeCompare(b[0]);

    // A day column runs in the order the meeting set. Orders nobody has ranked
    // yet fall in behind the ranked ones, still in SO order, so a job arriving
    // on a new export lands at the bottom of the list rather than in the middle
    // of work already sequenced.
    const byPriority = (a, b) => {
      const pa = priorityOf(dKey, sectionId, a[0]);
      const pb = priorityOf(dKey, sectionId, b[0]);
      if (pa !== pb) return pa - pb;
      return a[0].localeCompare(b[0]);
    };

    const ordered = Array.from(groups.entries()).sort(
      dKey === HOLDING_DATE ? byDueThenSo : byPriority
    );

    return ordered
      .map(([so, groupCards], position) => {
        const groupKey = `sched:${dKey}|${sectionId}|${so}`;
        const isExpanded = state.expanded.has(groupKey);
        const total = dedupedDoorTotal(groupCards);
        const proCount = new Set(groupCards.map((c) => c.pro)).size;
        // Real orders share one customer across the group. Stock doors don't —
        // they're grouped together but each is a different item, so only claim a
        // single label when the group actually has one.
        const labels = new Set(groupCards.map((c) => c.customer).filter(Boolean));
        const groupLabel = labels.size === 1 ? [...labels][0] : `${labels.size} items`;
        // The number shown is the row's position, not what's stored. Everything
        // in the column is numbered whether or not it's been ranked by hand, so
        // the floor always reads a straight 1..N with no gaps to interpret.
        const rank = dKey === HOLDING_DATE ? null : position + 1;
        const header = scheduleGroupHeaderHTML(so, groupLabel, total, proCount, groupKey, isExpanded, groupCards, rank);
        // keep a PRO's cards (e.g. its Make and Press chunks) next to each other
        // instead of all Make cards first then all Press cards — otherwise the
        // same PRO showing up twice, far apart, reads as a stray duplicate.
        const sortedCards = [...groupCards].sort(
          (a, b) => a.pro.localeCompare(b.pro) || FACTORY_STAGES.indexOf(a.stage) - FACTORY_STAGES.indexOf(b.stage)
        );
        // registered open or shut, so collapsing an SO doesn't quietly drop
        // the ticks on the PROs inside it
        for (const c of sortedCards) liveCardKeys.add(cardKeyFor(dKey, sectionId, c));
        const body = isExpanded
          ? `<div class="schedule-group-body">${sortedCards
              .map((c) => scheduleCardHTML(c, cardKeyFor(dKey, sectionId, c)))
              .join("")}</div>`
          : "";
        return `<div class="schedule-group">${header}${body}</div>`;
      })
      .join("");
  }

  function countConfirmedOnDays(dates) {
    const set = new Set(dates);
    return state.schedule.entries.filter((e) => set.has(e.scheduled_date)).length;
  }

  function renderResetBar() {
    const btn = $("#schedule-reset");
    const hint = $("#schedule-reset-hint");
    const days = Array.from(state.selectedDays);

    if (days.length === 0) {
      btn.disabled = true;
      hint.textContent = "Tick a day's header to select it";
      return;
    }
    const n = countConfirmedOnDays(days);
    btn.disabled = n === 0;
    hint.textContent =
      n === 0
        ? `${days.length} day${days.length === 1 ? "" : "s"} selected — nothing scheduled on ${days.length === 1 ? "it" : "them"}`
        : `${n} job${n === 1 ? "" : "s"} across ${days.length} day${days.length === 1 ? "" : "s"}`;
  }

  function wireDayPickers() {
    $$("#view-scheduling .schedule-day-pick").forEach((box) => {
      box.addEventListener("change", () => {
        const d = box.dataset.date;
        if (box.checked) state.selectedDays.add(d);
        else state.selectedDays.delete(d);
        renderScheduling();
      });
    });
  }

  function wireResetButton() {
    $("#schedule-reset").addEventListener("click", async () => {
      const days = Array.from(state.selectedDays).sort();
      if (days.length === 0) return;

      const n = countConfirmedOnDays(days);
      if (n === 0) return;

      const dayList = days.map((d) => fmtDayDate(parseDateKey(d))).join("\n  ");
      const ok = confirm(
        `Reset ${days.length} day${days.length === 1 ? "" : "s"}?\n\n  ${dayList}\n\n` +
          `${n} scheduled job${n === 1 ? "" : "s"} will be unallocated and moved back to Holding.\n` +
          `Factory floor progress is not affected.`
      );
      if (!ok) return;

      try {
        const res = await postJSON("/api/schedule/unallocate", { dates: days });
        state.selectedDays.clear();
        await refreshScheduleAndFactory();
        alert(`Moved ${res.moved} job${res.moved === 1 ? "" : "s"} back to Holding.`);
      } catch (e) {
        notifyError(e, "Couldn't reset those days.");
      }
    });
  }

  function renderScheduleSelection() {
    const wrap = $("#schedule-selection");
    const groups = state.selectedGroups.size;
    const cards = state.selectedCards.size;
    wrap.hidden = groups === 0 && cards === 0;
    if (wrap.hidden) return;
    const parts = [];
    if (groups > 0) parts.push(`${groups} SO${groups === 1 ? "" : "s"}`);
    if (cards > 0) parts.push(`${cards} PRO${cards === 1 ? "" : "s"}`);
    $("#schedule-selection-count").textContent = `${parts.join(" + ")} selected — drag any one to move them together`;
  }

  // Keeps the strip above the board in step with the board itself. The strip
  // holds nothing but a spacer as wide as the board's content, which is what
  // gives its scrollbar the same travel.
  function wireBoardScrollTop(stripId, boardId) {
    const strip = $(`#${stripId}`);
    const board = $(`#${boardId}`);
    if (!strip || !board) return;

    const spacer = strip.firstElementChild;
    const sync = () => {
      spacer.style.width = `${board.scrollWidth}px`;
      // Nothing to scroll, nothing to show — an empty scrollbar rail above an
      // empty board is just a line nobody can use.
      strip.hidden = board.scrollWidth <= board.clientWidth + 1;
    };
    sync();

    if (strip.dataset.wired === "1") return; // listeners survive a re-render
    strip.dataset.wired = "1";

    // Each scroll drives the other. Assigning scrollLeft fires a scroll event
    // back, so the two would bounce — except the return trip finds the values
    // already equal and assigns nothing, which ends it. Comparing rather than
    // holding a "currently syncing" flag matters: any flag has to be cleared
    // on a timer or a frame, and neither is guaranteed to run in a background
    // tab, so a flag that got stuck once would stop the bar working for good.
    const follow = (from, to) => () => {
      if (to.scrollLeft !== from.scrollLeft) to.scrollLeft = from.scrollLeft;
    };
    strip.addEventListener("scroll", follow(strip, board));
    board.addEventListener("scroll", follow(board, strip));

    // Widen the window until the days fit and the bar has nothing left to do.
    // Two routes to noticing, because they cover different things: the
    // observer catches the board changing width on its own (the huddle view
    // going full screen, Holding being searched), the resize listener catches
    // the window and is there if the observer isn't.
    if (window.ResizeObserver) new ResizeObserver(sync).observe(board);
    window.addEventListener("resize", sync);
  }

  function wireDayLocks(cardsByCell) {
    const stages = scheduleSections().flatMap((s) => s.stages);

    $$("#view-scheduling .lock-btn[data-lock-date]").forEach((btn) => {
      btn.addEventListener("click", async () => {
        const dKey = btn.dataset.lockDate;
        // One line per PRO and stage, at the quantity showing on the board —
        // this is exactly what the meeting just agreed to.
        const perLine = new Map();
        for (const stage of stages) {
          for (const c of cardsByCell.get(`${dKey}|${stage}`) || []) {
            const key = `${c.pro}|${stage}`;
            perLine.set(key, {
              stage,
              prod_order_no: c.pro,
              qty: (perLine.get(key)?.qty || 0) + (c.qty || 0),
            });
          }
        }
        const lines = [...perLine.values()];
        if (lines.length === 0 && !confirm(`Nothing is scheduled on ${dKey}. Lock it in as an empty day?`)) return;

        try {
          await postJSON("/api/schedule/lock", { date: dKey, lines });
          await refreshScheduleAndFactory();
        } catch (err) {
          notifyError(err, "Couldn't lock that day.");
        }
      });
    });

    $$("#view-scheduling .lock-btn[data-unlock-date]").forEach((btn) => {
      btn.addEventListener("click", async () => {
        const dKey = btn.dataset.unlockDate;
        if (!confirm(`Re-open ${dKey}? The plan it was measured against is discarded, and the day loses its score.`)) return;
        try {
          await apiDelete(`/api/schedule/lock/${dKey}`);
          await refreshScheduleAndFactory();
        } catch (err) {
          notifyError(err, "Couldn't re-open that day.");
        }
      });
    });
  }

  function wireScheduleGroupToggles() {
    $$("#view-scheduling .schedule-group-head").forEach((head) => {
      head.addEventListener("click", () => {
        const key = head.dataset.groupKey;
        if (state.expanded.has(key)) state.expanded.delete(key);
        else state.expanded.add(key);
        renderScheduling();
      });
    });
  }

  function wireScheduleOffsetInputs() {
    const map = { press: "#offset-press", cnc: "#offset-cnc" };
    Object.entries(map).forEach(([key, sel]) => {
      const input = $(sel);
      input.value = state.scheduleOffsets[key];
      input.onchange = () => {
        const v = Math.max(0, Math.round(Number(input.value) || 0));
        state.scheduleOffsets[key] = v;
        input.value = v;
        localStorage.setItem(`scheduleOffset${capitalize(key)}`, String(v));
        renderScheduling();
      };
    });
  }

  // Moving work off a day that was locked in is the day not being achieved.
  // It isn't blocked — plans change, and the floor has to be able to react —
  // but nobody should be able to do it without being told what it costs.
  function confirmLeavingLockedDay(cards, targetDate) {
    const leaving = [];
    for (const c of cards) {
      for (const dKey of lockedDaysFor(c.pro, c.stage)) {
        if (dKey !== targetDate) leaving.push({ pro: c.pro, stage: c.stage, from: dKey });
      }
    }
    if (leaving.length === 0) return true;

    const byDay = new Map();
    for (const l of leaving) {
      if (!byDay.has(l.from)) byDay.set(l.from, []);
      byDay.get(l.from).push(`${l.pro} ${stageLabel(l.stage)}`);
    }
    const lines = [...byDay.entries()].map(
      ([dKey, jobs]) => `${fmtDayDate(parseDateKey(dKey))} — ${jobs.join(", ")}`
    );

    return confirm(
      [
        leaving.length === 1
          ? "This job was locked in for another day:"
          : `${leaving.length} of these were locked in for another day:`,
        "",
        ...lines,
        "",
        leaving.length === 1
          ? "Moving it counts against that day's score as work that wasn't achieved. Move it anyway?"
          : "Moving them counts against that day's score as work that wasn't achieved. Move them anyway?",
      ].join("\n")
    );
  }

  async function applyCardMove(cardData, targetDate) {
    if (cardData.confirmed) {
      await postJSON(`/api/schedule/${cardData.entryId}/move`, { date: targetDate });
    } else {
      await postJSON("/api/schedule", { prod_order_no: cardData.pro, stage: cardData.stage, date: targetDate, qty: cardData.qty });
    }
  }

  function groupCardsOf(head) {
    try {
      return JSON.parse(head.dataset.groupCards || "[]");
    } catch (err) {
      return []; // a group whose payload won't parse can't be dragged as one
    }
  }

  // Everything ticked travels together, whichever ticked thing you took hold
  // of. A PRO ticked inside an SO that's ticked too is still one chunk of work,
  // and asking the server to move it twice is how a job ends up double-booked.
  function selectedDragPayload() {
    const byChunk = new Map();
    const add = (c) => {
      const k = c.entryId ? `e:${c.entryId}` : `p:${c.pro}|${c.stage}`;
      if (!byChunk.has(k)) byChunk.set(k, c);
    };
    for (const el of $$("#view-scheduling .schedule-group-head")) {
      if (state.selectedGroups.has(el.dataset.groupKey)) groupCardsOf(el).forEach(add);
    }
    for (const c of state.selectedCards.values()) add(c);
    return {
      type: "group",
      cards: [...byChunk.values()],
      groupKeys: [...state.selectedGroups],
      cardKeys: [...state.selectedCards.keys()],
    };
  }

  // "sched:2026-08-26|make_press|SO-179115" -> its three parts
  function parseGroupKey(key) {
    const m = /^sched:([^|]*)\|([^|]*)\|(.*)$/.exec(key || "");
    return m ? { date: m[1], section: m[2], so: m[3] } : null;
  }

  // Which slot in the column the pointer is over: the first order whose middle
  // is below it, so the card lands where the line is drawn.
  function dropIndexAt(zone, clientY) {
    const heads = [...zone.querySelectorAll(":scope > .schedule-group > .schedule-group-head")];
    for (let i = 0; i < heads.length; i++) {
      const r = heads[i].getBoundingClientRect();
      if (clientY < r.top + r.height / 2) return i;
    }
    return heads.length;
  }

  function clearDropSlots(root) {
    for (const el of (root || document).querySelectorAll(".is-drop-before, .is-drop-last")) {
      el.classList.remove("is-drop-before", "is-drop-last");
    }
  }

  function markDropSlot(zone, clientY) {
    clearDropSlots();
    const groups = [...zone.querySelectorAll(":scope > .schedule-group")];
    if (groups.length === 0) return;
    const i = dropIndexAt(zone, clientY);
    if (i < groups.length) groups[i].classList.add("is-drop-before");
    else groups[groups.length - 1].classList.add("is-drop-last");
  }

  function currentOrderOf(zone) {
    return [...zone.querySelectorAll(":scope > .schedule-group > .schedule-group-head")]
      .map((h) => parseGroupKey(h.dataset.groupKey))
      .filter(Boolean)
      .map((k) => k.so);
  }

  // A drop back into the cell it came from is a reordering, not a move. Returns
  // true when it handled the drop.
  async function reorderWithinCell(zone, data, clientY) {
    const from = parseGroupKey(data.fromGroupKey);
    if (!from) return false;
    if (from.date !== zone.dataset.date || from.section !== zone.dataset.section) return false;
    if (zone.dataset.date === HOLDING_DATE) return false; // a backlog has no running order

    // Everything ticked travels together here too, keeping its relative order.
    const movingKeys = (data.groupKeys && data.groupKeys.length ? data.groupKeys : [data.fromGroupKey])
      .map(parseGroupKey)
      .filter((k) => k && k.date === from.date && k.section === from.section)
      .map((k) => k.so);
    const moving = new Set(movingKeys.length ? movingKeys : [from.so]);

    const order = currentOrderOf(zone);
    const index = dropIndexAt(zone, clientY);
    // Count how many of the moving orders sit above the drop point — pulling
    // them out shifts everything below up by that many.
    const removedAbove = order.slice(0, index).filter((so) => moving.has(so)).length;
    const rest = order.filter((so) => !moving.has(so));
    const block = order.filter((so) => moving.has(so));
    rest.splice(index - removedAbove, 0, ...block);

    if (rest.join("|") === order.join("|")) return true; // dropped where it already was

    try {
      await postJSON("/api/schedule/priorities", {
        date: zone.dataset.date,
        section: zone.dataset.section,
        order: rest,
      });
      for (const k of data.groupKeys || []) state.selectedGroups.delete(k);
      await refreshScheduleAndFactory();
    } catch (err) {
      notifyError(err, "Couldn't change the running order.");
    }
    return true;
  }

  function wireScheduleDragDrop() {
    $$(".schedule-card[draggable='true']").forEach((card) => {
      card.addEventListener("dragstart", (e) => {
        e.stopPropagation();
        // An unticked card still moves on its own — the plain single-card path
        // that most drags take.
        const data = state.selectedCards.has(card.dataset.cardKey)
          ? selectedDragPayload()
          : {
              type: "card",
              pro: card.dataset.pro,
              stage: card.dataset.stage,
              qty: Number(card.dataset.qty),
              entryId: card.dataset.entryId || null,
              confirmed: card.dataset.confirmed === "true",
            };
        e.dataTransfer.setData("text/plain", JSON.stringify(data));
        e.dataTransfer.effectAllowed = "move";
      });
    });

    $$(".schedule-group-head[draggable='true']").forEach((head) => {
      head.addEventListener("dragstart", (e) => {
        e.stopPropagation();
        const key = head.dataset.groupKey;
        // dragging any ticked SO takes everything else that's ticked with it
        const data = state.selectedGroups.has(key)
          ? selectedDragPayload()
          : { type: "group", cards: groupCardsOf(head), groupKeys: [key], cardKeys: [] };
        // Where it came from, so a drop back into the same cell can be read as
        // a reorder rather than a move to nowhere.
        data.fromGroupKey = key;
        e.dataTransfer.setData("text/plain", JSON.stringify(data));
        e.dataTransfer.effectAllowed = "move";
      });
    });

    $$(".schedule-card-pick").forEach((box) => {
      box.addEventListener("click", (e) => e.stopPropagation());
      box.addEventListener("mousedown", (e) => e.stopPropagation());
      box.addEventListener("dragstart", (e) => e.preventDefault());
      box.addEventListener("change", (e) => {
        e.stopPropagation();
        const card = box.closest(".schedule-card");
        const key = box.dataset.cardKey;
        if (box.checked) {
          state.selectedCards.set(key, {
            pro: card.dataset.pro,
            stage: card.dataset.stage,
            qty: Number(card.dataset.qty),
            entryId: card.dataset.entryId || null,
            confirmed: card.dataset.confirmed === "true",
          });
        } else {
          state.selectedCards.delete(key);
        }
        renderScheduling();
      });
    });

    $$(".schedule-group-pick").forEach((box) => {
      box.addEventListener("click", (e) => e.stopPropagation());
      box.addEventListener("mousedown", (e) => e.stopPropagation());
      box.addEventListener("dragstart", (e) => e.preventDefault());
      box.addEventListener("change", (e) => {
        e.stopPropagation();
        const key = box.dataset.groupKey;
        if (box.checked) state.selectedGroups.add(key);
        else state.selectedGroups.delete(key);
        renderScheduling();
      });
    });

    $$("#view-scheduling .schedule-dropzone").forEach((zone) => {
      zone.addEventListener("dragover", (e) => {
        e.preventDefault();
        zone.classList.add("is-dragover");
        // Show where it would land. The payload can't be read during dragover —
        // browsers only expose it on drop — so the line is drawn for any drag
        // over a day column and simply comes to nothing on a plain move.
        if (zone.dataset.date !== HOLDING_DATE) markDropSlot(zone, e.clientY);
      });
      zone.addEventListener("dragleave", () => {
        zone.classList.remove("is-dragover");
        clearDropSlots(zone);
      });
      zone.addEventListener("drop", async (e) => {
        e.preventDefault();
        zone.classList.remove("is-dragover");
        let data;
        try {
          data = JSON.parse(e.dataTransfer.getData("text/plain"));
        } catch (err) {
          return;
        }
        clearDropSlots();
        if (!data) return;

        // Dropped back where it started: that's setting the running order.
        if (data.type === "group" && (await reorderWithinCell(zone, data, e.clientY))) return;

        const allowedStages = (zone.dataset.stages || "").split(",");
        const targetDate = zone.dataset.date;

        const moving = data.type === "group"
          ? (data.cards || []).filter((c) => allowedStages.includes(c.stage))
          : [data];
        if (!confirmLeavingLockedDay(moving, targetDate)) return;

        try {
          if (data.type === "group") {
            const cards = (data.cards || []).filter((c) => allowedStages.includes(c.stage));
            // move sequentially, not concurrently — two concurrent creates for the
            // same PRO+stage can each read "0 already scheduled" before the other's
            // write lands, letting both succeed and double-book the job
            const failures = [];
            for (const c of cards) {
              try {
                await applyCardMove(c, targetDate);
              } catch (err) {
                failures.push(err);
              }
            }
            // the ticked SOs have landed — clear the selection so the next drag
            // doesn't silently drag them along again
            for (const k of data.groupKeys || []) state.selectedGroups.delete(k);
            for (const k of data.cardKeys || []) state.selectedCards.delete(k);
            await refreshScheduleAndFactory();
            const real = failures.filter((f) => !f.needsSignIn);
            // Whatever failed for a real reason still gets reported. Anything
            // blocked for want of a login is covered by the dialog, which says
            // so once rather than once per card.
            if (real.length > 0) {
              const lines = [
                `Moved ${cards.length - failures.length} of ${cards.length} — ${real.length} couldn't move:`,
                ...real.map((f) => f.message || "Unknown error"),
                "",
                "The board has been refreshed — if these still show up, the underlying job data has likely changed (e.g. a newer export came in).",
              ];
              alert(lines.join("\n"));
            }
          } else {
            if (!allowedStages.includes(data.stage)) return;
            await applyCardMove(data, targetDate);
            await refreshScheduleAndFactory();
          }
        } catch (err) {
          notifyError(err, "Couldn't move that job.");
        }
      });
    });
  }

  function wireScheduleCardActions() {
    $$("#view-scheduling .schedule-card .sc-btn").forEach((btn) => {
      btn.addEventListener("click", async (e) => {
        e.stopPropagation();
        const card = btn.closest(".schedule-card");
        const entryId = card.dataset.entryId;
        const action = btn.dataset.action;
        try {
          if (action === "remove") {
            await apiDelete(`/api/schedule/${entryId}`);
          } else if (action === "join") {
            const chunks = Number(btn.dataset.chunks);
            const zone = card.closest(".schedule-dropzone");
            const dKey = zone && zone.dataset.date;
            const where = dKey === HOLDING_DATE ? "Holding" : dKey ? fmtDayDate(parseDateKey(dKey)) : "this chunk's day";
            if (!confirm(`Join all ${chunks} pieces of ${card.dataset.pro} ${stageLabel(card.dataset.stage)} into one on ${where}?`)) return;
            await postJSON(`/api/schedule/${entryId}/join`, {});
          } else if (action === "split") {
            const total = Number(card.dataset.qty);
            const qtyStr = prompt(`Split how many off this ${fmtNum(total)}-door chunk? (moves to the same day, then drag it)`);
            if (!qtyStr) return;
            const qty = Number(qtyStr);
            if (!qty || qty <= 0 || qty >= total) return;
            await postJSON(`/api/schedule/${entryId}/split`, { qty });
          }
          await refreshScheduleAndFactory();
        } catch (err) {
          notifyError(err, "Could not update the schedule.");
        }
      });
    });
  }

  function buildAndPrint(dateStr) {
    const dayDate = parseDateKey(dateStr);
    const now = new Date();
    const printStages = scheduleSections().flatMap((section) => section.stages);

    // Print what the board shows for that day, not just the confirmed bookings.
    // Press and CNC mostly aren't bookings of their own — they follow a dated
    // Make — so reading the entries table alone dropped every CNC job off the
    // run sheet while the screen still showed it sitting on that day.
    const factoryRows = (state.data.factory && state.data.factory.rows) || [];
    const cardsByCell = buildScheduleCells(factoryRows, computeMakeAnchors());

    const byStage = printStages.map((stage) => {
      // Finished work stays on the sheet — it's the record of the day, not just
      // a to-do list — but it's ticked off rather than sitting there looking
      // like something still to make.
      const entries = (cardsByCell.get(`${dateStr}|${stage}`) || [])
        .map((c) => ({
          prod_order_no: c.pro,
          sales_order_no: c.so,
          customer: c.customer, // already run through customerLabel when the card was built
          item_summary: c.item,
          qty: c.qty,
          due_date: c.due,
          wm: c.wm || null,
          // Posted counts as done on paper whatever the shop got round to
          // ticking. This sheet goes out to the floor, and a closed job listed
          // as outstanding is doors made twice.
          posted: !!c.posted,
          done: !!c.stageComplete || !!c.posted,
        }));
      return { stage, entries };
    });

    const totalDoors = byStage.reduce((s, g) => s + g.entries.reduce((n, e) => n + (e.qty || 0), 0), 0);

    // A locked day's sheet is the record of what was promised and what came of
    // it, so the score belongs on the paper too.
    const dayTotal = dayScore(dateStr, cardsByCell, printStages);
    const meta = [
      `<strong>${fmtDayDate(dayDate)}</strong>`,
      `Printed ${now.toLocaleDateString()} ${now.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" })}`,
    ];
    if (dayTotal && dayTotal.planned > 0) {
      meta.push(
        `Locked plan: <strong>${Math.round(dayTotal.pct * 100)}%</strong> — ${fmtNum(dayTotal.done)} of ${fmtNum(dayTotal.planned)} doors` +
          (dayTotal.moved > 0 ? `, ${fmtNum(dayTotal.moved)} moved off` : "")
      );
    }

    let html = printHeaderHTML(
      "Daily production schedule",
      dayDate.toLocaleDateString(undefined, { weekday: "long", day: "2-digit", month: "long", year: "numeric" }),
      meta
    );

    html += `<div class="print-totals">
      ${byStage.map((g) => `<span><b>${stageLabel(g.stage)}:</b> ${g.entries.length} job${g.entries.length === 1 ? "" : "s"}</span>`).join("")}
      <span><b>${fmtNum(totalDoors)}</b> doors total</span>
    </div>`;

    for (const { stage, entries } of byStage) {
      const doors = entries.reduce((s, e) => s + (e.qty || 0), 0);
      const doneCount = entries.filter((e) => e.done).length;
      html += `<div class="print-stage-block">
        <h3>${stageLabel(stage)} &nbsp;·&nbsp; ${entries.length} job${entries.length === 1 ? "" : "s"}, ${fmtNum(doors)} doors${
          doneCount ? ` &nbsp;·&nbsp; ${doneCount} already done` : ""
        }</h3>`;

      if (entries.length === 0) {
        html += `<div class="print-empty">Nothing scheduled</div>`;
      } else {
        const sorted = [...entries].sort(
          (a, b) =>
            // still to do first, so the sheet reads as work then record
            (a.done ? 1 : 0) - (b.done ? 1 : 0) ||
            (a.due_date || "9999-99-99").localeCompare(b.due_date || "9999-99-99")
        );
        let seq = 0;
        html += `<table class="print-table">
          <colgroup>
            <col style="width:4%"><col style="width:13%"><col style="width:20%"><col style="width:37%">
            <col style="width:7%"><col style="width:11%"><col style="width:8%">
          </colgroup>
          <thead><tr>
            <th class="col-seq">#</th><th>Order</th><th>Customer</th><th>Item</th>
            <th class="col-num">Qty</th><th class="col-date">Due</th><th>Done ✓</th>
          </tr></thead><tbody>`;
        for (const e of sorted) {
          seq += 1;
          html += `<tr class="${e.done ? "is-done-row" : ""}">
            <td class="col-seq">${seq}</td>
            <td class="col-key">${e.prod_order_no}<span class="cell-sub">${soLabel(e.sales_order_no)}</span>${
              e.wm ? `<span class="cell-wm">${e.wm}</span>` : ""
            }</td>
            <td>${e.customer}</td>
            <td>${e.item_summary || "—"}</td>
            <td class="col-num">${fmtNum(e.qty)}</td>
            <td class="col-date">${e.due_date ? fmtDate(e.due_date) : "—"}</td>
            <td class="col-tick">${e.posted ? '<span class="cell-posted">POSTED</span>' : e.done ? "✓" : ""}</td>
          </tr>`;
        }
        html += `</tbody></table>`;
      }
      html += `</div>`;
    }

    html += printFooterHTML(["Completed by", "Date"]);

    $("#print-sheet").innerHTML = html;
    window.print();
  }

  function wireSchedulePrintButtons() {
    $$("#view-scheduling .print-btn[data-print-date]").forEach((btn) => {
      btn.addEventListener("click", () => buildAndPrint(btn.dataset.printDate));
    });
  }

  function wireScheduleNav() {
    wireResetButton();
    $("#schedule-selection-clear").addEventListener("click", () => {
      state.selectedGroups.clear();
      state.selectedCards.clear();
      renderScheduling();
    });
    $("#schedule-prev").addEventListener("click", () => {
      state.scheduleWindowStart = addBusinessDays(state.scheduleWindowStart, -5);
      renderScheduling();
    });
    $("#schedule-next").addEventListener("click", () => {
      state.scheduleWindowStart = addBusinessDays(state.scheduleWindowStart, 5);
      renderScheduling();
    });
    $("#schedule-today").addEventListener("click", () => {
      state.scheduleWindowStart = mostRecentOrSameMonday(new Date());
      renderScheduling();
    });
  }

  // Twelve days is right for planning at a desk. Standing around a screen in a
  // morning huddle it isn't — twelve narrow columns can't be read from the back
  // of the group — so huddle view drops to today plus the next two.
  const SCHEDULE_WINDOW_DAYS = 12;
  const HUDDLE_WINDOW_DAYS = 3;
  const scheduleWindowDays = () => (state.huddle ? HUDDLE_WINDOW_DAYS : SCHEDULE_WINDOW_DAYS);

  // Holding carries the whole backlog, so a job is found by typing its number
  // rather than scrolled to.
  function cardMatches(card, query) {
    const q = query.trim().toLowerCase();
    if (!q) return true;
    return [card.pro, card.so, card.customer, card.item]
      .filter(Boolean)
      .some((v) => String(v).toLowerCase().includes(q));
  }

  // Typing in a Holding box narrows only that box, so the day columns beside it
  // stay put while you hunt for a job to drag out.
  function wireHoldingSearch(selector, key, rerender) {
    const input = $(selector);
    if (!input) return;
    let t = null;
    input.addEventListener("input", () => {
      clearTimeout(t);
      t = setTimeout(() => {
        state.holdingSearch[key] = input.value;
        rerender();
      }, 120);
    });
    // Esc clears without reaching for the mouse
    input.addEventListener("keydown", (e) => {
      if (e.key !== "Escape") return;
      input.value = "";
      state.holdingSearch[key] = "";
      rerender();
    });
  }

  function renderHoldingBox(cardsByCell) {
    const zone = $("#schedule-holding-zone");
    const countEl = $("#schedule-holding-count");
    const activeStages = scheduleSections().flatMap((section) => section.stages);
    const allHeld = activeStages.flatMap((stage) => cardsByCell.get(`${HOLDING_DATE}|${stage}`) || []);
    const query = state.holdingSearch.schedule;
    const heldCards = allHeld.filter((c) => cardMatches(c, query));

    zone.dataset.stages = activeStages.join(",");

    if (allHeld.length === 0) {
      zone.innerHTML = '<div class="schedule-holding-empty">Drag a card here to set it aside while you plan other days</div>';
      countEl.textContent = "";
      return;
    }
    if (heldCards.length === 0) {
      zone.innerHTML = `<div class="schedule-holding-empty">Nothing in Holding matches “${escapeAttr(query)}”</div>`;
      countEl.textContent = `0 of ${allHeld.length}`;
      return;
    }

    zone.innerHTML = renderCellCards(heldCards, HOLDING_DATE, "holding");
    const total = dedupedDoorTotal(heldCards);
    countEl.textContent = query
      ? `${fmtNum(total)}× · ${heldCards.length} of ${allHeld.length}`
      : `${fmtNum(total)}× · ${heldCards.length} chunk${heldCards.length === 1 ? "" : "s"}`;
  }

  function renderScheduling() {
    const boardEl = $("#schedule-board");
    const emptyEl = $("#schedule-empty");
    const rangeEl = $("#schedule-range");

    if (!state.data.factory) {
      boardEl.innerHTML = "";
      emptyEl.hidden = false;
      return;
    }
    emptyEl.hidden = true;

    wireScheduleOffsetInputs();

    const factoryRows = state.data.factory.rows || [];
    const anchors = computeMakeAnchors();
    const cardsByCell = buildScheduleCells(factoryRows, anchors);

    liveCardKeys = new Set();
    renderHoldingBox(cardsByCell);

    if (!state.scheduleWindowStart) state.scheduleWindowStart = mostRecentOrSameMonday(new Date());
    const days = [];
    let d = new Date(state.scheduleWindowStart);
    for (let i = 0; i < scheduleWindowDays(); i++) {
      days.push(new Date(d));
      d = addBusinessDays(d, 1);
    }

    const todayKey = dateKey(nextOrSameBusinessDay(new Date()));
    rangeEl.textContent = `${fmtDayDate(days[0])} – ${fmtDayDate(days[days.length - 1])}`;

    const threshold = state.capacity.doorsPerDay;

    boardEl.innerHTML = days
      .map((day) => {
        const dKey = dateKey(day);
        const isToday = dKey === todayKey;
        const plan = dayPlan(dKey);
        const sections = scheduleSections();

        const stagesHtml = sections.map((section) => {
          const cards = section.stages.flatMap((stage) => cardsByCell.get(`${dKey}|${stage}`) || []);
          const cardsHtml = renderCellCards(cards, dKey, section.id);

          let comboCls = "";
          let labelText = section.label;
          if (section.capacityCheck) {
            const total = dedupedDoorTotal(cards);
            labelText = `${section.label} — ${fmtNum(total)}/${fmtNum(threshold)}`;
            if (total > threshold) comboCls = "is-over-capacity";
            else if (total >= threshold) comboCls = "is-at-capacity";
          }

          return `<div class="schedule-stage-section ${comboCls}">
            <div class="schedule-stage-label">${labelText}${scoreHTML(dayScore(dKey, cardsByCell, section.stages))}</div>
            <div class="schedule-dropzone" data-date="${dKey}" data-section="${section.id}" data-stages="${section.stages.join(",")}">${cardsHtml}</div>
          </div>`;
        }).join("");

        // The day's own figure is every department added together, not an
        // average of their percentages — twenty doors missed in Make shouldn't
        // be offset by one glazing job going right.
        const wholeDay = dayScore(dKey, cardsByCell, sections.flatMap((s) => s.stages));
        const lockBtn = plan
          ? `<button class="lock-btn is-locked" type="button" data-unlock-date="${dKey}" title="Locked ${plan.locked_by ? `by ${escapeAttr(plan.locked_by)} ` : ""}${fmtDate(plan.locked_at)} — click to re-open">🔒</button>`
          : `<button class="lock-btn" type="button" data-lock-date="${dKey}" title="Lock this day in — from then on the board is measured against it">🔓</button>`;

        const dayPicked = state.selectedDays.has(dKey);
        return `<div class="schedule-day ${isToday ? "is-today" : ""} ${dayPicked ? "is-day-selected" : ""} ${plan ? "is-locked-day" : ""}">
          <div class="schedule-day-head">
            <input type="checkbox" class="schedule-day-pick" data-date="${dKey}" ${dayPicked ? "checked" : ""} title="Select this day to reset">
            <span class="day-label">${fmtDayDate(day)}</span>
            ${wholeDay && wholeDay.planned > 0 ? scoreHTML(wholeDay) : ""}
            ${lockBtn}
            <button class="print-btn" type="button" data-print-date="${dKey}" title="Print this day">🖶</button>
          </div>
          ${stagesHtml}
        </div>`;
      })
      .join("");

    // A ticked PRO that's no longer on the board — posted, or moved by someone
    // else's export — shouldn't ride along on the next drag.
    for (const k of [...state.selectedCards.keys()]) {
      if (!liveCardKeys.has(k)) state.selectedCards.delete(k);
    }

    wireScheduleDragDrop();
    wireScheduleCardActions();
    wireSchedulePrintButtons();
    wireScheduleGroupToggles();
    wireWmFlags();
    wireDayLocks(cardsByCell);
    wireBoardScrollTop("schedule-scroll-top", "schedule-board");
    wireDayPickers();
    renderScheduleSelection();
    renderResetBar();
  }

  const BOARD_VIEWS = new Set(["scheduling", "cavities"]);

  function render() {
    document.body.classList.toggle("is-board-view", BOARD_VIEWS.has(state.view));
    if (state.view === "joinery") renderJoinery();
    else if (state.view === "subcontractors") renderSubcontractors();
    else if (state.view === "factory") renderFactory();
    else if (state.view === "cavities") renderCavities();
    else if (state.view === "labels") renderLabels();
    else renderScheduling();
  }

  function renderUpdatedAt(status) {
    const el = $("#updatedAt");
    if (!status || !status.datasets) {
      el.textContent = "No data ingested yet";
      return;
    }
    const parts = Object.entries(status.datasets).map(([ds, snap]) => {
      const label = ds === "joinery" ? "Joinery" : ds === "subcontractors" ? "Subs" : ds;
      return `${label}: ${snap.snapshot_date}`;
    });
    el.textContent = parts.length ? `Latest data — ${parts.join(" · ")}` : "No data ingested yet";
  }

  /* ==========================================================================
     Labels

     Two stocks on two Zebra ZD421s. Door labels stay in the building; pallet
     labels are a 4x6 shipping label fed portrait and go to the customer, so
     they carry no PRO numbers. A ZD421 prints at most 103.8mm wide, which is
     why the pallet's 150 is the length and never the web — and why the door
     stock at 102 wide has barely a millimetre either side to spare.

     Printing goes through a throwaway iframe rather than this page. The
     dashboard's own print CSS is a landscape day sheet with 12mm margins, and
     a label sharing that would come out in the middle of a sheet of A4. The
     iframe carries its own @page and nothing else.
     ========================================================================== */

  // Width across the web, then length along the feed, in mm. The page size,
  // the artwork and the preview frame all read from here, so a change of roll
  // is this line and a look at the layout, not a hunt for hardcoded sizes.
  const LABEL_STOCK = {
    door: { w: 102, h: 36 },
    pallet: { w: 100, h: 150 },
  };

  // Absolute, because the print and preview iframes are written rather than
  // navigated and a relative path has nothing dependable to resolve against.
  const LABEL_LOGO = new URL("assets/criterion-logo.png", document.baseURI).href;

  // Past this many in one go it's more likely a misread quantity than a real
  // run, and it's a whole roll either way.
  const LABEL_RUN_WARN = 25;

  function labelPageCSS(kind) {
    const s = LABEL_STOCK[kind];
    return `@page { size: ${s.w}mm ${s.h}mm; margin: 0; }`;
  }

  const stockText = (kind) => `${LABEL_STOCK[kind].w} × ${LABEL_STOCK[kind].h}mm`;

  const LABEL_CSS = `
    html, body { margin: 0; padding: 0; background: #fff; overflow: hidden; }
    body { font-family: Arial, Helvetica, sans-serif; color: #000; }
    .label { background: #fff; box-sizing: border-box; display: flex; flex-direction: column;
             overflow: hidden; page-break-after: always; }
    .label:last-child { page-break-after: auto; }
    /* Rows keep their natural height. A flex row that hides its overflow is
       otherwise allowed to shrink below its text, so a full label crops the
       description's second line in silence instead of registering as full —
       and the fit pass below never finds out. */
    .label > * { flex-shrink: 0; }
    /* Everything prints pure black. A thermal head has no grey: it fakes one
       by leaving dots out, which is what made the description print faint. */
    .door   { width: ${LABEL_STOCK.door.w}mm; height: ${LABEL_STOCK.door.h}mm; padding: 2mm 3mm; }
    .pallet { width: ${LABEL_STOCK.pallet.w}mm; height: ${LABEL_STOCK.pallet.h}mm; padding: 6mm; }
    .cust { font-weight: 700; line-height: 1.05; overflow: hidden; }
    .cust.is-stock { letter-spacing: .06em; }
    /* Door stock is wide and short, so height is what runs out. The customer
       and its door count share a line rather than stacking, and the door
       number sits up beside the logo where the width has room for it. */
    .door .top   { display: flex; justify-content: space-between; align-items: flex-end; gap: 4mm; }
    .door .logo  { width: 22mm; display: block; flex: none; }
    /* What the customer calls the job, across the top where the logo leaves
       room. Right-aligned so it reads as a heading for the label, not a stray
       line of the address below it. */
    .door .job   { flex: 1; min-width: 0; text-align: right; font-size: 4.2mm; font-weight: 700;
                   line-height: 1.1; white-space: nowrap; overflow: hidden; }
    .door .idrow { display: flex; align-items: flex-end; justify-content: space-between; gap: 3mm; margin-top: .6mm; }
    /* A ruled line rather than a box: a box tall enough to write in costs about
       5mm of height, and that comes straight off the customer name. */
    .door .dno      { flex: none; width: 34mm; border-bottom: .5mm solid #000; padding-bottom: .4mm;
                      display: flex; align-items: baseline; gap: 1.5mm; }
    .door .dno span { flex: none; font-size: 2.2mm; letter-spacing: .1em; font-weight: 700; }
    .door .dno b    { font-size: 4mm; font-weight: 700; line-height: 1.1; }
    .door .mid   { display: flex; justify-content: space-between; align-items: flex-start; gap: 3mm; margin-top: .6mm; }
    .door .cust  { flex: 1; min-width: 0; font-size: 6mm; max-height: 2.1em; }
    .door .count { text-align: right; line-height: .85; flex: none; }
    .door .count b    { display: block; font-size: 8mm; font-weight: 700; letter-spacing: -.04em; }
    .door .count span { display: block; font-size: 2.2mm; letter-spacing: .14em; margin-top: .5mm; }
    .door .ids   { font-size: 4.2mm; font-weight: 700; letter-spacing: -.01em; }
    /* Two lines, never clipped to one: descriptions end in things like a fire
       rating ("… MDF Skins, 1HR") that can't be the part that falls off. */
    .door .spec  { margin-top: auto; font-size: 3mm; font-weight: 700; line-height: 1.12;
                   max-height: 2.24em; overflow: hidden; }
    .pallet .logo { width: 70mm; display: block; }
    .pallet .box  { margin-top: 6mm; border: .7mm solid #000; padding: 3mm 4mm;
                    display: flex; align-items: baseline; justify-content: space-between; gap: 3mm; }
    .pallet .box span { font-size: 6mm; font-weight: 700; letter-spacing: .16em; }
    .pallet .box b    { font-size: 24mm; font-weight: 700; letter-spacing: -.04em; line-height: 1; }
    .pallet .cust { font-size: 10mm; margin-top: 8mm; max-height: 3.2em; }
    .pallet .job  { font-size: 7mm; font-weight: 700; line-height: 1.1; margin-top: 4mm;
                    max-height: 2.2em; overflow: hidden; }
    .pallet .big  { font-size: 17mm; font-weight: 700; letter-spacing: -.035em; line-height: 1; margin-top: 5mm; }
    .pallet .foot { margin-top: auto; border-top: .5mm solid #000; padding-top: 3.5mm; }
    .pallet .qty  { font-size: 7mm; font-weight: 700; }
  `;

  // The Labels tab and its buttons can be reached before /api/factory lands.
  const factoryRows = () => (state.data.factory && state.data.factory.rows) || [];

  function labelEsc(value) {
    return String(value === null || value === undefined ? "" : value)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;");
  }

  function doorCount(r) {
    return Math.max(1, Math.round(r.total_qty || 1));
  }

  function doorLabelHTML(r, n, total) {
    // A stock door has no customer and no order — its item code is what says
    // which door it is, the same swap the board makes.
    const stock = !String(r.source_name || "").trim();
    const second = stock ? r.item_no || "" : String(r.sales_order_no || "").trim();
    return `<div class="label door">
      <div class="top">
        <img class="logo" src="${LABEL_LOGO}" alt="">
        <div class="job">${labelEsc(r.job_name || "")}</div>
      </div>
      <div class="mid">
        <div class="cust${stock ? " is-stock" : ""}">${labelEsc(stock ? "STOCK DOOR" : r.source_name)}</div>
        <div class="count"><b>${n}/${total}</b><span>DOOR</span></div>
      </div>
      <div class="idrow">
        <div class="ids">${labelEsc(r.prod_order_no)}${second ? " &middot; " + labelEsc(second) : ""}</div>
        <div class="dno"><span>DOOR No.</span><b>${labelEsc(doorMarkFor(r, n))}</b></div>
      </div>
      <div class="spec">${labelEsc(r.item_summary || "")}</div>
    </div>`;
  }

  function palletLabelHTML(order, n, total) {
    return `<div class="label pallet">
      <img class="logo" src="${LABEL_LOGO}" alt="">
      <div class="box"><span>PALLET</span><b>${n}/${total}</b></div>
      <div class="cust">${labelEsc(order.customer || "")}</div>
      ${order.job_name ? `<div class="job">${labelEsc(order.job_name)}</div>` : ""}
      <div class="big">${labelEsc(order.so)}</div>
      <div class="foot"><div class="qty">${fmtNum(order.doors)} door${order.doors === 1 ? "" : "s"}</div></div>
    </div>`;
  }

  // Step an element's type down until test() passes or it reaches floor of its
  // starting size.
  function shrinkUntil(view, el, floor, test) {
    const start = parseFloat(view.getComputedStyle(el).fontSize);
    for (let size = start; !test() && size > start * floor; size -= 0.25) {
      el.style.fontSize = `${size}px`;
    }
  }

  // Text that runs past the room it's given gets smaller rather than cut off.
  // The description goes first: every one on file fits its two lines today,
  // but a longer one would otherwise lose its end, and that's where a fire
  // rating sits. Then the customer gives way until the label as a whole fits,
  // rather than clipping a name somebody has to read off a pallet.
  function fitLabels(doc) {
    const view = doc.defaultView;
    // Width matters as well as height: the job name runs on one line across
    // the top of a door label, so a long one overruns sideways, not down.
    const fits = (el) => el.scrollHeight <= el.clientHeight + 1 && el.scrollWidth <= el.clientWidth + 1;
    doc.querySelectorAll(".label").forEach((label) => {
      const job = label.querySelector(".job");
      if (job) shrinkUntil(view, job, 0.7, () => fits(job));
      const spec = label.querySelector(".spec");
      if (spec) shrinkUntil(view, spec, 0.75, () => fits(spec));
      const cust = label.querySelector(".cust");
      if (cust) shrinkUntil(view, cust, 0.5, () => fits(cust) && fits(label));
    });
  }

  function writeLabelDoc(doc, css, html) {
    doc.open();
    doc.write(
      '<!doctype html><html><head><meta charset="utf-8"><title>Labels</title><style>' +
        css +
        "</style></head><body>" +
        html +
        "</body></html>"
    );
    doc.close();
    // Wait for the logo to decode before measuring or printing. Until it does
    // it has no height, so a label that overflows measures as fitting — and
    // printing early can drop the image entirely.
    return Promise.all(
      Array.from(doc.images).map((img) =>
        img.complete ? null : new Promise((done) => { img.onload = img.onerror = done; })
      )
    ).then(() => fitLabels(doc));
  }

  function printLabelSheet(kind, html) {
    const frame = document.createElement("iframe");
    frame.setAttribute("aria-hidden", "true");
    frame.style.cssText = "position:fixed;right:0;bottom:0;width:1px;height:1px;opacity:0;border:0";
    document.body.appendChild(frame);

    writeLabelDoc(frame.contentDocument, labelPageCSS(kind) + LABEL_CSS, html)
      .then(() => {
        frame.contentWindow.focus();
        frame.contentWindow.print();
      })
      .catch((e) => console.error(e))
      // Chrome blocks on the dialog, but not every browser does — hold the
      // frame open long enough for the job to be spooled either way.
      .then(() => setTimeout(() => frame.remove(), 2000));
  }

  function printDoorLabels(r) {
    const total = doorCount(r);
    if (
      total > LABEL_RUN_WARN &&
      !confirm(`${r.prod_order_no} is ${fmtNum(total)} doors — print ${fmtNum(total)} labels?`)
    ) {
      return;
    }
    let html = "";
    for (let n = 1; n <= total; n += 1) html += doorLabelHTML(r, n, total);
    printLabelSheet("door", html);
  }

  // The pallet label covers the whole order, not one PRO — several PROs of the
  // same order ship together.
  function palletOrderFor(so) {
    const rows = factoryRows().filter((r) => String(r.sales_order_no || "").trim() === so);
    if (!rows.length) return null;
    const named = rows.find((r) => String(r.source_name || "").trim());
    const titled = rows.find((r) => r.job_name);
    return {
      so,
      customer: named ? named.source_name : "",
      job_name: titled ? titled.job_name : null,
      doors: rows.reduce((sum, r) => sum + (r.total_qty || 0), 0),
      pros: rows.length,
    };
  }

  function printPalletLabels(order, count) {
    let html = "";
    for (let n = 1; n <= count; n += 1) html += palletLabelHTML(order, n, count);
    printLabelSheet("pallet", html);
  }

  /* ==========================================================================
     Door numbers

     The architect's mark for each door — D-104 — which BC's export doesn't
     carry: a nine-door job is one row with a quantity. An admin types them in
     once and they stay, and the door label prints them.

     A job is asked about while it's still being made and nobody has answered
     for it. "It has none" is an answer, so it stops asking. Finished jobs are
     never asked about: their labels are long since printed.
     ========================================================================== */

  // Skipped for now — kept for this visit only, so Skip means "not now" rather
  // than a decision that has to be undone later.
  const doorNumSkipped = new Set();

  function doorNumbersPending() {
    return factoryRows().filter(
      (r) => r.status !== "completed" && !r.door_numbers_set && !doorNumSkipped.has(r.prod_order_no)
    );
  }

  function doorMarkFor(row, n) {
    const marks = (row && row.door_numbers) || [];
    return marks[n - 1] || "";
  }

  let doorNumQueue = [];
  let doorNumAt = 0;

  function doorNumCurrent() {
    const pro = doorNumQueue[doorNumAt];
    return factoryRows().find((r) => r.prod_order_no === pro) || null;
  }

  function renderDoorNumStep() {
    const row = doorNumCurrent();
    if (!row) {
      closeDoorNumbers();
      return;
    }
    const doors = doorCount(row);
    $("#doorNumProgress").textContent =
      doorNumQueue.length > 1 ? `Job ${doorNumAt + 1} of ${doorNumQueue.length}` : "";
    $("#doorNumJob").innerHTML =
      `<div class="doornum-pro">${row.prod_order_no}</div>` +
      `<div class="doornum-meta">${customerLabel(row.source_name)} · ${soLabel(row.sales_order_no)}</div>` +
      `<div class="doornum-meta">${labelEsc(row.item_summary || "")} · ${fmtNum(doors)} door${doors === 1 ? "" : "s"}</div>`;

    const marks = row.door_numbers || [];
    $("#doorNumFields").innerHTML = Array.from({ length: doors }, (_, i) =>
      `<label class="doornum-field"><span>${i + 1}</span>` +
      `<input type="text" class="doornum-input" data-pos="${i}" value="${escapeAttr(marks[i] || "")}" ` +
      `autocomplete="off" spellcheck="false" placeholder="—"></label>`
    ).join("");

    $("#doorNumError").hidden = true;
    const first = $("#doorNumFields .doornum-input");
    if (first) {
      first.focus();
      first.select();
    }
  }

  function doorNumMarks() {
    return $$("#doorNumFields .doornum-input").map((i) => i.value.trim());
  }

  function openDoorNumbers(pros) {
    doorNumQueue = pros.filter(Boolean);
    if (!doorNumQueue.length) return;
    doorNumAt = 0;
    $("#doorNumBackdrop").hidden = false;
    renderDoorNumStep();
  }

  function closeDoorNumbers() {
    $("#doorNumBackdrop").hidden = true;
    doorNumQueue = [];
  }

  function doorNumNext() {
    doorNumAt += 1;
    if (doorNumAt >= doorNumQueue.length) {
      closeDoorNumbers();
      renderLabels();
      return;
    }
    renderDoorNumStep();
  }

  async function saveDoorNumbers(hasNumbers) {
    const row = doorNumCurrent();
    if (!row) return;
    const marks = hasNumbers ? doorNumMarks() : [];
    if (hasNumbers && !marks.some(Boolean)) {
      $("#doorNumError").hidden = false;
      $("#doorNumError").textContent = "Type at least one door number, or say the job has none.";
      return;
    }
    try {
      const saved = await postJSON("/api/door-numbers", {
        prod_order_no: row.prod_order_no,
        has_numbers: hasNumbers,
        marks,
      });
      // Straight onto the row the labels read, so the next label printed for
      // this job carries the numbers without waiting for a refresh.
      row.door_numbers = saved.marks || [];
      row.door_numbers_set = true;
      $("#doorNumError").hidden = true;
      doorNumNext();
    } catch (e) {
      if (e.needsSignIn) return;
      $("#doorNumError").hidden = false;
      $("#doorNumError").textContent = e.message || "Couldn't save those door numbers.";
    }
  }

  function wireDoorNumbers() {
    $("#doorNumSave").addEventListener("click", () => saveDoorNumbers(true));
    $("#doorNumNone").addEventListener("click", () => saveDoorNumbers(false));
    $("#doorNumSkip").addEventListener("click", () => {
      const row = doorNumCurrent();
      if (row) doorNumSkipped.add(row.prod_order_no);
      doorNumNext();
    });
    $("#doorNumClose").addEventListener("click", closeDoorNumbers);
    $("#doorNumBackdrop").addEventListener("click", (e) => {
      if (e.target === $("#doorNumBackdrop")) closeDoorNumbers();
    });
    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape" && !$("#doorNumBackdrop").hidden) closeDoorNumbers();
    });
    // Enter moves to the next door, and saves from the last one.
    $("#doorNumFields").addEventListener("keydown", (e) => {
      if (e.key !== "Enter") return;
      e.preventDefault();
      const inputs = $$("#doorNumFields .doornum-input");
      const next = inputs[inputs.indexOf(e.target) + 1];
      if (next) next.focus();
      else saveDoorNumbers(true);
    });
    $("#doornum-start").addEventListener("click", () =>
      openDoorNumbers(doorNumbersPending().map((r) => r.prod_order_no))
    );
    $("#doornum-import-open").addEventListener("click", () => {
      const box = $("#doornum-import");
      box.open = true;
      $("#doornum-paste").focus();
    });
    $("#doornum-import-go").addEventListener("click", importDoorNumbers);
    $("#joblist-import-open").addEventListener("click", () => {
      $("#joblist-import").open = true;
      $("#joblist-paste").focus();
    });
    $("#joblist-import-go").addEventListener("click", importJobNames);
    $("#joblist-file-btn").addEventListener("click", () => $("#joblist-file").click());
    $("#joblist-file").addEventListener("change", (e) => uploadJobNames(e.target.files[0]));
  }

  // ---------- pasting a list in ----------
  //
  // The job cards carry door numbers that the spreadsheet export doesn't, so
  // they arrive as a list rather than one job at a time.

  function parseDoorNumberList(text) {
    const rows = [];
    const bad = [];
    for (const raw of text.split(/\r?\n/)) {
      const line = raw.trim();
      if (!line) continue;
      const m = /^(PRO-[\w-]+)\s*[:\t]\s*(.*)$/i.exec(line);
      if (!m || !m[2].trim()) {
        bad.push(line);
        continue;
      }
      // A dash is a door deliberately left blank, so the ones after it still
      // land on the right door.
      const marks = m[2].split(",").map((s) => s.trim()).map((s) => (s === "-" ? "" : s));
      while (marks.length && !marks[marks.length - 1]) marks.pop();
      if (!marks.some(Boolean)) {
        bad.push(line);
        continue;
      }
      rows.push({ pro: m[1].toUpperCase(), marks });
    }
    return { rows, bad };
  }

  async function importDoorNumbers() {
    const result = $("#doornum-import-result");
    const { rows, bad } = parseDoorNumberList($("#doornum-paste").value);
    if (!rows.length) {
      result.textContent = bad.length ? `Couldn't read any of those ${bad.length} lines.` : "Nothing to import.";
      return;
    }

    const byPro = new Map(factoryRows().map((r) => [r.prod_order_no, r]));
    let done = 0;
    const skipped = [];
    const failed = [];
    $("#doornum-import-go").disabled = true;
    try {
      for (const [i, entry] of rows.entries()) {
        const row = byPro.get(entry.pro);
        if (!row) {
          skipped.push(`${entry.pro} isn't in the export`);
          continue;
        }
        result.textContent = `Importing ${i + 1} of ${rows.length}…`;
        try {
          const saved = await postJSON("/api/door-numbers", {
            prod_order_no: entry.pro,
            has_numbers: true,
            marks: entry.marks,
          });
          row.door_numbers = saved.marks || [];
          row.door_numbers_set = true;
          done += 1;
        } catch (e) {
          if (e.needsSignIn) return;
          failed.push(`${entry.pro}: ${e.message || "wouldn't save"}`);
        }
      }
    } finally {
      $("#doornum-import-go").disabled = false;
    }

    const parts = [`${done} job${done === 1 ? "" : "s"} imported`];
    if (skipped.length) parts.push(`${skipped.length} skipped`);
    if (failed.length) parts.push(`${failed.length} failed`);
    if (bad.length) parts.push(`${bad.length} line${bad.length === 1 ? "" : "s"} unreadable`);
    result.textContent = parts.join(" · ");
    if (failed.length || skipped.length) console.warn("door number import", { failed, skipped, bad });
    renderLabels();
  }

  /* ==========================================================================
     Job names

     What the customer calls the job — "WACA - TIMBER DOORS STAGE 1" — which BC
     keeps on the sales order as its External Document No. The Production
     Scheduler export doesn't carry it, so it's pasted in from the Sales Orders
     list and matched to work by sales order number.
     ========================================================================== */

  const SO_PATTERN = /^SO-[\w-]+$/i;

  function parseJobNameList(text) {
    const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
    if (!lines.length) return { rows: [], bad: [] };

    // Pasted from the spreadsheet: find the two columns by their headings and
    // ignore the twenty-odd others that come along for the ride.
    const cells = (line) => line.split("\t").map((c) => c.trim());
    const header = cells(lines[0]).map((c) => c.toLowerCase());
    const soCol = header.findIndex((c) => c === "no." || c === "no" || c === "order no." || c.includes("sales order"));
    const nameCol = header.findIndex((c) => c.includes("external document"));

    const rows = [];
    const bad = [];
    const start = soCol >= 0 && nameCol >= 0 ? 1 : 0;
    for (const line of lines.slice(start)) {
      const parts = cells(line);
      let so;
      let name;
      if (soCol >= 0 && nameCol >= 0 && parts.length > Math.max(soCol, nameCol)) {
        so = parts[soCol];
        name = parts[nameCol];
      } else if (parts.length >= 2 && SO_PATTERN.test(parts[0])) {
        so = parts[0];
        name = parts.slice(1).find(Boolean) || "";
      } else {
        const m = /^(SO-[\w-]+)\s*[:\t]\s*(.+)$/i.exec(line);
        if (m) {
          so = m[1];
          name = m[2];
        }
      }
      if (!so || !SO_PATTERN.test(so)) {
        bad.push(line);
        continue;
      }
      // An order with no job name yet isn't a problem to report — it just has
      // nothing to say, and will when someone fills it in.
      if (name) rows.push({ sales_order_no: so.toUpperCase(), job_name: name });
    }
    return { rows, bad };
  }

  async function importJobNames() {
    const result = $("#joblist-import-result");
    const { rows, bad } = parseJobNameList($("#joblist-paste").value);
    if (!rows.length) {
      result.textContent = bad.length
        ? `Couldn't find a sales order in those ${bad.length} lines.`
        : "Nothing to import.";
      return;
    }

    const btn = $("#joblist-import-go");
    btn.disabled = true;
    result.textContent = `Saving ${rows.length} job names…`;
    try {
      const res = await postJSON("/api/sales-orders", { rows });
      const byName = new Map(rows.map((r) => [r.sales_order_no, r.job_name]));
      let onBoard = 0;
      for (const row of factoryRows()) {
        const name = byName.get(String(row.sales_order_no || "").toUpperCase());
        if (name) {
          row.job_name = name;
          onBoard += 1;
        }
      }
      result.textContent =
        `${res.saved} job name${res.saved === 1 ? "" : "s"} saved · ${onBoard} matched work on the board` +
        (bad.length ? ` · ${bad.length} line${bad.length === 1 ? "" : "s"} ignored` : "");
      renderLabels();
    } catch (e) {
      if (e.needsSignIn) return;
      result.textContent = e.message || "Couldn't save those job names.";
    } finally {
      btn.disabled = false;
    }
  }

  // The same file the paste comes from, handed over whole. The server knows a
  // Sales Orders export by its columns, so this is the ordinary upload route —
  // dropping the file on the page or using Upload export works just as well.
  async function uploadJobNames(file) {
    if (!file) return;
    const result = $("#joblist-import-result");
    const btn = $("#joblist-file-btn");
    btn.disabled = true;
    result.textContent = `Reading ${file.name}…`;
    try {
      const body = new FormData();
      body.append("files", file);
      const res = await fetch("/api/upload", { method: "POST", body });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.detail || `Upload failed (${res.status})`);
      const saved = (data.ingested || []).reduce((s, r) => s + (r.row_count || 0), 0);
      const problems = (data.errors || []).join("; ");
      await Promise.all([loadFactory(), loadSchedule()]);
      const onBoard = factoryRows().filter((r) => r.job_name).length;
      result.textContent = problems
        ? problems
        : `${saved} job name${saved === 1 ? "" : "s"} loaded · ${onBoard} matched work on the board`;
      renderLabels();
    } catch (e) {
      if (e.needsSignIn) return;
      result.textContent = e.message || "Couldn't read that file.";
    } finally {
      btn.disabled = false;
      $("#joblist-file").value = "";
    }
  }

  // Asked once a visit, not on every refresh: the board reloads itself every
  // minute and a dialog that reappeared each time would be unusable.
  let doorNumAsked = false;

  function maybeAskForDoorNumbers() {
    if (doorNumAsked || !state.isAdmin) return;
    const pending = doorNumbersPending();
    if (!pending.length) return;
    doorNumAsked = true;
    openDoorNumbers(pending.map((r) => r.prod_order_no));
  }

  // ---------- how many pallets? ----------

  let palletOrder = null;

  function showPallet(so) {
    const order = palletOrderFor(so);
    if (!order) return;
    palletOrder = order;
    $("#palletFor").textContent =
      `${order.so} · ${order.customer || "no customer"} · ${fmtNum(order.doors)} door` +
      `${order.doors === 1 ? "" : "s"} across ${order.pros} PRO${order.pros === 1 ? "" : "s"}`;
    const input = $("#palletCount");
    input.value = "1";
    $("#palletErr").hidden = true;
    $("#palletBackdrop").hidden = false;
    input.focus();
    input.select();
  }

  function hidePallet() {
    palletOrder = null;
    $("#palletBackdrop").hidden = true;
  }

  function confirmPallet() {
    if (!palletOrder) return;
    const n = Math.round(Number($("#palletCount").value));
    const err = $("#palletErr");
    if (!Number.isFinite(n) || n < 1 || n > 50) {
      err.textContent = "Enter how many pallets were made — a number from 1 to 50.";
      err.hidden = false;
      return;
    }
    const order = palletOrder;
    hidePallet();
    printPalletLabels(order, n);
  }

  function wirePallet() {
    $("#palletGo").addEventListener("click", confirmPallet);
    $("#palletCancel").addEventListener("click", hidePallet);
    $("#palletCount").addEventListener("input", () => { $("#palletErr").hidden = true; });
    $("#palletCount").addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        confirmPallet();
      }
    });
    $("#palletBackdrop").addEventListener("click", (e) => {
      if (e.target === $("#palletBackdrop")) hidePallet();
    });
    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape" && palletOrder) hidePallet();
    });
  }

  // ---------- the buttons on the floor ----------

  function labelCellHTML(r) {
    const doors = doorCount(r);
    const so = String(r.sales_order_no || "").trim();
    // A stock door has no order, so there is nothing to put on a pallet label.
    const pallet = so
      ? `<button type="button" class="label-btn" data-label-so="${so}" title="Pallet labels for ${so}">Pallet</button>`
      : "";
    return `<div class="label-cell">
      <button type="button" class="label-btn" data-label-pro="${r.prod_order_no}" title="Print ${doors} door label${doors === 1 ? "" : "s"}">Door</button>
      ${pallet}
    </div>`;
  }

  function wireLabelButtons(container) {
    $$(".label-btn[data-label-pro]", container).forEach((btn) => {
      btn.addEventListener("click", () => {
        const r = factoryRows().find((x) => x.prod_order_no === btn.dataset.labelPro);
        if (r) printDoorLabels(r);
      });
    });
    $$(".label-btn[data-label-so]", container).forEach((btn) => {
      btn.addEventListener("click", () => showPallet(btn.dataset.labelSo));
    });
  }

  // ---------- the Labels tab ----------

  const MM_PX = 96 / 25.4;

  function labelPreviewFrame(container, kind, html) {
    const { w, h } = LABEL_STOCK[kind];
    const frame = document.createElement("iframe");
    frame.className = "label-frame";
    frame.title = kind === "pallet" ? "Pallet label preview" : "Door label preview";
    // Ceil, not round: millimetres rarely land on a whole pixel, and a frame a
    // fraction short of its own content puts scrollbars across the preview.
    frame.style.width = `${Math.ceil(w * MM_PX)}px`;
    frame.style.height = `${Math.ceil(h * MM_PX)}px`;
    container.appendChild(frame);
    // Previewing through the same writer the printer uses means what's on
    // screen is the artwork, not a second drawing of it that can drift.
    writeLabelDoc(frame.contentDocument, LABEL_CSS, html).catch((e) => console.error(e));
  }

  function renderLabels() {
    const rows = factoryRows();
    const sel = $("#label-pro");
    const preview = $("#label-preview");
    const empty = $("#labels-empty");

    if (!rows || !rows.length) {
      sel.innerHTML = "";
      preview.innerHTML = "";
      empty.hidden = false;
      empty.textContent = noDataMessage("Production Scheduler export (Joinery)");
      return;
    }
    empty.hidden = true;

    const sorted = rows
      .slice()
      .sort((a, b) => String(a.prod_order_no).localeCompare(String(b.prod_order_no)));

    // Keep whatever was being looked at across the 60-second refresh.
    const wanted = state.labelPro && sorted.some((r) => r.prod_order_no === state.labelPro)
      ? state.labelPro
      : sorted[0].prod_order_no;
    state.labelPro = wanted;

    sel.innerHTML = sorted
      .map(
        (r) =>
          `<option value="${r.prod_order_no}"${r.prod_order_no === wanted ? " selected" : ""}>` +
          `${r.prod_order_no} · ${customerLabel(r.source_name)} · ${fmtNum(doorCount(r))} door${doorCount(r) === 1 ? "" : "s"}</option>`
      )
      .join("");

    const r = sorted.find((x) => x.prod_order_no === wanted);
    const so = String(r.sales_order_no || "").trim();
    const order = so ? palletOrderFor(so) : null;

    preview.innerHTML = `
      <figure class="label-figure">
        <figcaption>Door label · ${stockText("door")} · ${fmtNum(doorCount(r))} of these print</figcaption>
        <div class="label-slot" id="label-slot-door"></div>
      </figure>
      <figure class="label-figure">
        <figcaption>${order ? `Pallet label · ${stockText("pallet")} portrait · one per pallet` : "Pallet label · not available"}</figcaption>
        <div class="label-slot" id="label-slot-pallet">${
          order ? "" : '<p class="label-na">A stock door has no sales order, so there is nothing to put on a pallet label.</p>'
        }</div>
      </figure>`;

    renderDoorNumBar(r);
    labelPreviewFrame($("#label-slot-door"), "door", doorLabelHTML(r, 1, doorCount(r)));
    if (order) labelPreviewFrame($("#label-slot-pallet"), "pallet", palletLabelHTML(order, 1, 3));

    $("#label-print-door").disabled = false;
    $("#label-print-pallet").disabled = !order;
  }

  // What this job's labels will print in the DOOR No. box, and how much of the
  // floor is still waiting to be answered for.
  function renderDoorNumBar(r) {
    const bar = $("#doornum-bar");
    if (!state.isAdmin) {
      bar.hidden = true;
      $("#doornum-import").hidden = true;
      $("#joblist-import").hidden = true;
      return;
    }
    bar.hidden = false;
    $("#doornum-import").hidden = false;
    $("#joblist-import").hidden = false;
    const waiting = doorNumbersPending().length;
    const marks = (r.door_numbers || []).filter(Boolean);
    const thisJob = marks.length
      ? `${r.prod_order_no}: ${marks.join(", ")}`
      : r.door_numbers_set
        ? `${r.prod_order_no} has no door numbers`
        : `${r.prod_order_no} hasn't been asked about yet`;
    $("#doornum-summary").textContent =
      waiting === 0
        ? `${thisJob} · nothing waiting`
        : `${thisJob} · ${waiting} job${waiting === 1 ? "" : "s"} waiting`;
    $("#doornum-start").textContent = waiting ? `Enter door numbers (${waiting})` : "Edit this job's numbers";
    $("#doornum-start").onclick = () =>
      openDoorNumbers(waiting ? doorNumbersPending().map((x) => x.prod_order_no) : [r.prod_order_no]);
  }

  function wireLabelsTab() {
    $("#label-pro").addEventListener("change", (e) => {
      state.labelPro = e.target.value;
      renderLabels();
    });
    $("#label-print-door").addEventListener("click", () => {
      const r = factoryRows().find((x) => x.prod_order_no === state.labelPro);
      if (r) printDoorLabels(r);
    });
    $("#label-print-pallet").addEventListener("click", () => {
      const r = factoryRows().find((x) => x.prod_order_no === state.labelPro);
      const so = r && String(r.sales_order_no || "").trim();
      if (so) showPallet(so);
    });
  }

  // ---------- tabs ----------

  function wireTabs() {
    $$(".tab-btn").forEach((btn) => {
      btn.addEventListener("click", () => {
        state.view = btn.dataset.view;
        $$(".tab-btn").forEach((b) => b.classList.toggle("is-active", b === btn));
        $("#view-joinery").hidden = state.view !== "joinery";
        $("#view-subcontractors").hidden = state.view !== "subcontractors";
        $("#view-factory").hidden = state.view !== "factory";
        $("#view-scheduling").hidden = state.view !== "scheduling";
        $("#view-cavities").hidden = state.view !== "cavities";
        $("#view-labels").hidden = state.view !== "labels";
        render();
      });
    });
  }

  function wireRescan() {
    const btn = $("#rescanBtn");
    btn.addEventListener("click", async () => {
      btn.disabled = true;
      btn.textContent = "Rescanning…";
      try {
        await fetchJSON("/api/rescan", { method: "POST" });
        await refreshAll();
      } catch (e) {
        console.error(e);
      } finally {
        btn.disabled = false;
        btn.textContent = "Rescan folder";
      }
    });
  }

  async function uploadFiles(fileList) {
    const files = Array.from(fileList || []);
    if (files.length === 0) return;

    const btn = $("#uploadBtn");
    const original = btn.textContent;
    btn.disabled = true;
    btn.textContent = files.length === 1 ? "Uploading…" : `Uploading ${files.length}…`;

    try {
      const form = new FormData();
      for (const f of files) form.append("files", f, f.name);
      const res = await fetch("/api/upload", { method: "POST", body: form });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body.detail || `Upload failed (${res.status})`);

      await refreshAll();
      const lines = (body.ingested || []).map(
        (r) => `${r.source_file} → ${r.dataset} (${r.row_count} rows, ${r.snapshot_date})`
      );
      if (body.errors && body.errors.length) lines.push("", "Not loaded:", ...body.errors);
      alert(lines.join("\n") || "Nothing was loaded.");
    } catch (e) {
      notifyError(e, "Couldn't upload that file.");
    } finally {
      btn.disabled = false;
      btn.textContent = original;
      $("#uploadInput").value = "";
    }
  }

  function wireUpload() {
    const btn = $("#uploadBtn");
    const input = $("#uploadInput");
    btn.addEventListener("click", () => input.click());
    input.addEventListener("change", () => uploadFiles(input.files));

    // drop an export anywhere on the page
    let depth = 0;
    const hint = () => {
      let el = $("#drop-hint");
      if (!el) {
        el = document.createElement("div");
        el.id = "drop-hint";
        el.textContent = "Drop the BC export to load it";
        document.body.appendChild(el);
      }
      return el;
    };
    window.addEventListener("dragenter", (e) => {
      if (!Array.from(e.dataTransfer?.types || []).includes("Files")) return;
      depth += 1;
      hint().classList.add("is-visible");
    });
    window.addEventListener("dragover", (e) => {
      if (Array.from(e.dataTransfer?.types || []).includes("Files")) e.preventDefault();
    });
    window.addEventListener("dragleave", () => {
      depth = Math.max(0, depth - 1);
      if (depth === 0) hint().classList.remove("is-visible");
    });
    window.addEventListener("drop", (e) => {
      if (!Array.from(e.dataTransfer?.types || []).includes("Files")) return;
      e.preventDefault();
      depth = 0;
      hint().classList.remove("is-visible");
      uploadFiles(e.dataTransfer.files);
    });
  }

  // ---------- cavities ----------
  //
  // Built in-house at the other site on their own two-step line, so they get the
  // same board as the doors but planned separately — their units would otherwise
  // distort the doors-per-day capacity everything else runs on.

  const CAV_STAGES = ["cav_prep", "cav_make"];
  const CAV_LABELS = { cav_prep: "Prep", cav_make: "Make" };
  const CAV_WINDOW_DAYS = 12;

  async function loadCavities() {
    try {
      const d = await fetchJSON("/api/cavities");
      state.cavities.rows = d.rows || [];
      state.cavities.as_of = d.as_of;
    } catch (e) {
      // 404 until the first cavities export is uploaded — not an error state
      state.cavities.rows = [];
      state.cavities.as_of = null;
    }
  }

  function cavEntries() {
    return state.schedule.entries.filter((e) => CAV_STAGES.includes(e.stage));
  }

  // Same chaining as the door board: Make follows Prep, and a card parked in
  // Holding takes everything downstream with it.
  function buildCavityCells(rows) {
    const map = new Map();
    const push = (dKey, stage, card) => {
      // Same rule as the doors: a posted job keeps its place on the days it was
      // planned and worked, but has no business in Holding, which is a list of
      // work still to do.
      if (card.posted && dKey === HOLDING_DATE) return;
      const key = dKey + "|" + stage;
      if (!map.has(key)) map.set(key, []);
      map.get(key).push(card);
    };

    const byProStage = new Map();
    for (const e of cavEntries()) {
      const k = e.prod_order_no + "|" + e.stage;
      if (!byProStage.has(k)) byProStage.set(k, []);
      byProStage.get(k).push(e);
    }

    for (const row of rows) {
      const pro = row.prod_order_no;
      let prevDateKey = null;

      for (const stage of CAV_STAGES) {
        const total = row.total_qty || 0;
        const done = row[stage + "_done"] || 0;
        const stageComplete = total > 0 && done >= total;

        const explicit = byProStage.get(pro + "|" + stage) || [];
        const explicitSum = explicit.reduce((a, e) => a + e.qty, 0);
        const explicitDated = explicit.filter((e) => e.scheduled_date !== HOLDING_DATE);
        const explicitHeld = explicit.length > 0 && explicitDated.length === 0;
        const earliestDated = explicitDated.length
          ? explicitDated.reduce((min, e) => (e.scheduled_date < min ? e.scheduled_date : min), explicitDated[0].scheduled_date)
          : null;

        const base = {
          pro,
          so: row.sales_order_no,
          stage,
          customer: customerLabel(row.source_name),
          wm: row.wm_number || null,
          posted: !!row.posted,
          item: row.item_summary,
          due: row.due_date,
        };

        for (const e of explicit) {
          push(e.scheduled_date, stage, Object.assign({}, base, { qty: e.qty, entryId: e.id, confirmed: true, stageComplete }));
        }

        let stageDateKey;
        if (explicitDated.length > 0) stageDateKey = earliestDated;
        else if (explicitHeld) stageDateKey = HOLDING_DATE;
        else if (stage === CAV_STAGES[0]) stageDateKey = HOLDING_DATE;
        else if (prevDateKey && prevDateKey !== HOLDING_DATE) stageDateKey = prevDateKey;
        else stageDateKey = HOLDING_DATE;
        prevDateKey = stageDateKey;

        const leftover = Math.max(0, total - done - explicitSum);
        const uncommitted = Math.max(0, total - explicitSum);
        const qty = leftover > 0.001 ? leftover : stageComplete ? uncommitted : 0;
        if (qty > 0.001) {
          push(stageDateKey, stage, Object.assign({}, base, { qty, entryId: null, confirmed: false, stageComplete }));
        }
      }
    }
    return map;
  }

  function cavStageProgress(pro, stage) {
    const r = state.cavities.rows.find((x) => x.prod_order_no === pro);
    if (!r) return 0;
    const total = r.total_qty || 0;
    return total > 0 ? Math.min(r[stage + "_done"] || 0, total) / total : 0;
  }

  const CAV_TAG_LETTER = { cav_prep: "P", cav_make: "M" };

  function cavCardHTML(c) {
    const pct = cavStageProgress(c.pro, c.stage);
    const done = pct >= 1;
    const row = state.cavities.rows.find((x) => x.prod_order_no === c.pro) || {};
    const total = row.total_qty || 0;
    const doneQty = Math.min(row[c.stage + "_done"] || 0, total);
    const cls = "schedule-card " + (c.confirmed ? "" : "is-suggested") + (done ? " is-stage-done" : "");
    const actions = c.confirmed
      ? '<span class="sc-actions">' +
        '<button class="sc-btn" type="button" data-cav-action="split" title="Split this chunk">✂</button>' +
        '<button class="sc-btn" type="button" data-cav-action="remove" title="Unschedule">×</button>' +
        "</span>"
      : "";
    const progressText = done
      ? ' · <span class="sc-done">✓ ' + CAV_LABELS[c.stage].toLowerCase() + " done</span>"
      : total > 0
        ? " · " + fmtNum(doneQty) + "/" + fmtNum(total) + " " + CAV_LABELS[c.stage].toLowerCase()
        : "";
    return '<div class="' + cls + '"' + progressFillStyle(pct) +
      ' draggable="true" data-cav="1" data-pro="' + c.pro + '" data-stage="' + c.stage +
      '" data-qty="' + c.qty + '" data-entry-id="' + (c.entryId == null ? "" : c.entryId) +
      '" data-confirmed="' + c.confirmed + '"' +
      ' title="' + CAV_LABELS[c.stage] + " — " + fmtNum(doneQty) + " of " + fmtNum(total) +
      " done — " + escapeAttr(c.item || "") + '">' +
      actions +
      '<span class="stage-dot" title="' + CAV_LABELS[c.stage] + '">' + CAV_TAG_LETTER[c.stage] + "</span>" +
      '<span class="sc-pro">' + c.pro + "</span>" +
      '<span class="sc-so">' + (c.so || "") + "</span>" +
      '<span class="sc-meta">' + fmtNum(c.qty) + "× " + (c.customer || "") + "</span>" +
      '<span class="sc-meta">Due ' + (c.due ? fmtDate(c.due) : "—") + progressText + "</span>" +
      "</div>";
  }

  function cavCardsHTML(cards, dKey) {
    if (!cards.length) return "";
    const groups = new Map();
    for (const c of cards) {
      const so = soLabel(c.so);
      if (!groups.has(so)) groups.set(so, []);
      groups.get(so).push(c);
    }
    const earliestDue = (list) =>
      list.reduce((min, c) => (c.due && (!min || c.due < min) ? c.due : min), null) || "9999-99-99";
    const entries = Array.from(groups.entries());
    entries.sort(
      dKey === HOLDING_DATE
        ? (a, b) => earliestDue(a[1]).localeCompare(earliestDue(b[1])) || a[0].localeCompare(b[0])
        : (a, b) => a[0].localeCompare(b[0])
    );

    return entries
      .map(([so, list]) => {
        const key = "cav:" + dKey + "|" + so;
        const isOpen = state.expanded.has(key);
        const units = list.reduce((s, c) => s + c.qty, 0);
        const pros = new Set(list.map((c) => c.pro)).size;
        const pct = list.reduce((s, c) => s + cavStageProgress(c.pro, c.stage), 0) / list.length;
        const payload = list.map((c) => ({ pro: c.pro, stage: c.stage, qty: c.qty, entryId: c.entryId, confirmed: c.confirmed }));
        const { badge, posted } = orderBadge(list, so);

        const body = isOpen
          ? '<div class="schedule-group-body">' +
            list.map((c) => cavCardHTML(c)).join("") +
            "</div>"
          : "";

        return '<div class="schedule-group">' +
          '<div class="schedule-group-head' + (posted ? " is-posted" : "") + (badge ? " has-wm" : "") + '"' +
          progressFillStyle(pct) + ' draggable="true" data-cav="1"' +
          ' data-group-key="' + key + '" data-group-cards="' + escapeAttr(JSON.stringify(payload)) + '"' +
          ' title="' + Math.round(pct * 100) + '% complete — drag to move the whole order">' +
          '<div class="schedule-group-top">' +
          '<span class="schedule-group-chevron">' + (isOpen ? "▾" : "▸") + "</span>" +
          '<span class="schedule-group-so">' + so + "</span>" +
          '<span class="schedule-group-count">' + fmtNum(units) + "× · " + pros + " PRO" + (pros === 1 ? "" : "s") + "</span>" +
          "</div>" +
          '<div class="schedule-group-customer">' + list[0].customer + "</div>" +
          badge +
          "</div>" + body + "</div>";
      })
      .join("");
  }

  function renderCavities() {
    const rows0 = state.cavities.rows;
    const rows = rows0;

    $("#cavities-updated").textContent = state.cavities.as_of ? "Planner as of " + fmtDate(state.cavities.as_of) : "";

    const emptyEl = $("#cavities-empty");
    if (rows0.length === 0) {
      emptyEl.hidden = false;
      emptyEl.textContent = noDataMessage("Production Scheduler export (Cavities)");
      $("#cavities-board").innerHTML = "";
      $("#cavities-holding-zone").innerHTML = "";
      $("#cavities-range").textContent = "";
      return;
    }
    emptyEl.hidden = true;

    const cells = buildCavityCells(rows);

    const allHeld = CAV_STAGES.flatMap((st) => cells.get(HOLDING_DATE + "|" + st) || []);
    const holdQuery = state.holdingSearch.cavities;
    const heldCards = allHeld.filter((c) => cardMatches(c, holdQuery));
    const holdZone = $("#cavities-holding-zone");
    holdZone.dataset.stages = CAV_STAGES.join(",");
    const heldUnits = heldCards.reduce((s, c) => s + c.qty, 0);

    if (allHeld.length === 0) {
      holdZone.innerHTML = '<div class="schedule-holding-empty">Drag a card here to set it aside while you plan other days</div>';
      $("#cavities-holding-count").textContent = "";
    } else if (heldCards.length === 0) {
      holdZone.innerHTML = '<div class="schedule-holding-empty">Nothing in Holding matches “' + escapeAttr(holdQuery) + '”</div>';
      $("#cavities-holding-count").textContent = "0 of " + allHeld.length;
    } else {
      holdZone.innerHTML = cavCardsHTML(heldCards, HOLDING_DATE);
      $("#cavities-holding-count").textContent = holdQuery
        ? fmtNum(heldUnits) + "× · " + heldCards.length + " of " + allHeld.length
        : fmtNum(heldUnits) + "× · " + heldCards.length + " chunk" + (heldCards.length === 1 ? "" : "s");
    }

    if (!state.cavities.windowStart) state.cavities.windowStart = mostRecentOrSameMonday(new Date());
    const days = [];
    let d = new Date(state.cavities.windowStart);
    for (let i = 0; i < CAV_WINDOW_DAYS; i++) {
      days.push(new Date(d));
      d = addBusinessDays(d, 1);
    }
    const todayK = dateKey(nextOrSameBusinessDay(new Date()));
    $("#cavities-range").textContent = fmtDayDate(days[0]) + " – " + fmtDayDate(days[days.length - 1]);

    $("#cavities-board").innerHTML = days
      .map((day) => {
        const dKey = dateKey(day);
        const sections = CAV_STAGES.map((st) => {
          const cards = cells.get(dKey + "|" + st) || [];
          const units = cards.reduce((s, c) => s + c.qty, 0);
          return '<div class="schedule-stage-section">' +
            '<div class="schedule-stage-label">' + CAV_LABELS[st] + (cards.length ? " — " + fmtNum(units) : "") + "</div>" +
            '<div class="schedule-dropzone cav-dropzone" data-date="' + dKey + '" data-stages="' + st + '">' +
            cavCardsHTML(cards, dKey) + "</div></div>";
        }).join("");
        return '<div class="schedule-day ' + (dKey === todayK ? "is-today" : "") + '">' +
          '<div class="schedule-day-head"><span>' + fmtDayDate(day) + "</span>" +
          '<button class="print-btn" type="button" data-cav-print="' + dKey + '" title="Print this day">🖶</button>' +
          "</div>" + sections + "</div>";
      })
      .join("");

    wireCavityBoard();
  }

  function wireCavityBoard() {
    $$("#view-cavities .schedule-group-head, #view-cavities .schedule-card").forEach((el) => {
      el.addEventListener("dragstart", (e) => {
        const payload = el.dataset.groupCards
          ? { type: "group", cards: JSON.parse(el.dataset.groupCards) }
          : {
              type: "card",
              pro: el.dataset.pro,
              stage: el.dataset.stage,
              qty: Number(el.dataset.qty),
              entryId: el.dataset.entryId || null,
            };
        e.dataTransfer.setData("text/plain", JSON.stringify(payload));
        e.dataTransfer.effectAllowed = "move";
        e.stopPropagation();
      });
    });

    $$("#view-cavities .schedule-group-head").forEach((head) => {
      head.addEventListener("click", () => {
        const key = head.dataset.groupKey;
        if (state.expanded.has(key)) state.expanded.delete(key);
        else state.expanded.add(key);
        renderCavities();
      });
    });

    $$("#view-cavities .cav-dropzone").forEach((zone) => {
      zone.addEventListener("dragover", (e) => {
        e.preventDefault();
        zone.classList.add("is-dragover");
      });
      zone.addEventListener("dragleave", () => zone.classList.remove("is-dragover"));
      zone.addEventListener("drop", async (e) => {
        e.preventDefault();
        zone.classList.remove("is-dragover");
        let data;
        try {
          data = JSON.parse(e.dataTransfer.getData("text/plain"));
        } catch (err) {
          return;
        }
        if (!data) return;
        const target = zone.dataset.date;
        const allowed = (zone.dataset.stages || "").split(",");
        const cards = data.type === "group" ? data.cards : [data];
        try {
          // one at a time: two concurrent creates for the same PRO and stage can
          // each read "nothing scheduled yet" and double-book it
          for (const c of cards) {
            if (!allowed.includes(c.stage)) continue;
            if (c.entryId) await postJSON("/api/schedule/" + c.entryId + "/move", { date: target });
            else await postJSON("/api/schedule", { prod_order_no: c.pro, stage: c.stage, date: target, qty: c.qty });
          }
          $("#cavities-error").hidden = true;
          await Promise.all([loadSchedule(), loadCavities()]);
          renderCavities();
        } catch (err) {
          if (err.needsSignIn) return;   // the dialog has already said so
          $("#cavities-error").hidden = false;
          $("#cavities-error").textContent = err.message || "Couldn't move that.";
        }
      });
    });

    $$("#view-cavities .print-btn[data-cav-print]").forEach((btn) => {
      btn.addEventListener("click", () => printCavityDay(btn.dataset.cavPrint));
    });

    wireWmFlags("#view-cavities");

    $$("#view-cavities .sc-btn[data-cav-action]").forEach((btn) => {
      btn.addEventListener("click", async (e) => {
        e.stopPropagation();
        const card = btn.closest(".schedule-card");
        const entryId = card.dataset.entryId;
        const action = btn.dataset.cavAction;
        try {
          if (action === "remove") {
            await apiDelete("/api/schedule/" + entryId);
          } else {
            const total = Number(card.dataset.qty);
            const qtyStr = prompt(
              "Split how many off this " + fmtNum(total) + "-unit chunk? (lands on the same day, then drag it where you want)"
            );
            if (!qtyStr) return;
            const qty = Number(qtyStr);
            if (!qty || qty <= 0 || qty >= total) return;
            await postJSON("/api/schedule/" + entryId + "/split", { qty });
          }
          $("#cavities-error").hidden = true;
          await Promise.all([loadSchedule(), loadCavities()]);
          renderCavities();
        } catch (err) {
          if (err.needsSignIn) return;   // the dialog has already said so
          $("#cavities-error").hidden = false;
          $("#cavities-error").textContent = err.message || "Couldn't update the schedule.";
        }
      });
    });
  }

  function printCavityDay(dateStr) {
    const cells = buildCavityCells(state.cavities.rows);
    const now = new Date();
    const dayDate = parseDateKey(dateStr);
    let html = printHeaderHTML(
      "Cavities run sheet",
      dayDate.toLocaleDateString(undefined, { weekday: "long", day: "2-digit", month: "long", year: "numeric" }),
      [
        "<strong>" + fmtDayDate(dayDate) + "</strong>",
        "Printed " + now.toLocaleDateString() + " " + now.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" }),
      ]
    );

    for (const st of CAV_STAGES) {
      const cards = (cells.get(dateStr + "|" + st) || []).filter((c) => !c.stageComplete);
      const units = cards.reduce((s, c) => s + c.qty, 0);
      html += '<div class="print-stage-block"><h3>' + CAV_LABELS[st] + " &nbsp;·&nbsp; " +
        cards.length + " job" + (cards.length === 1 ? "" : "s") + ", " + fmtNum(units) + " units</h3>";
      if (!cards.length) {
        html += '<div class="print-empty">Nothing scheduled</div>';
      } else {
        const sorted = [...cards].sort((a, b) => (a.due || "9999").localeCompare(b.due || "9999"));
        html += '<table class="print-table">' +
          '<colgroup><col style="width:4%"><col style="width:14%"><col style="width:21%"><col style="width:36%">' +
          '<col style="width:7%"><col style="width:11%"><col style="width:7%"></colgroup>' +
          '<thead><tr><th class="col-seq">#</th><th>Order</th><th>Customer</th><th>Item</th>' +
          '<th class="col-num">Units</th><th class="col-date">Due</th><th>Done ✓</th></tr></thead><tbody>';
        sorted.forEach((c, i) => {
          html += "<tr><td class=\"col-seq\">" + (i + 1) + "</td>" +
            '<td class="col-key">' + c.pro + '<span class="cell-sub">' + soLabel(c.so) + "</span></td>" +
            "<td>" + c.customer + "</td><td>" + (c.item || "—") + "</td>" +
            '<td class="col-num">' + fmtNum(c.qty) + "</td>" +
            '<td class="col-date">' + (c.due ? fmtDate(c.due) : "—") + "</td>" +
            // A posted job is on the day as the record of it, not as work to
            // pick up, and the sheet has to say so as plainly as the board does.
            '<td class="col-tick">' + (c.posted ? '<span class="cell-posted">POSTED</span>' : "") + "</td></tr>";
        });
        html += "</tbody></table>";
      }
      html += "</div>";
    }

    html += printFooterHTML(["Completed by", "Date"]);
    $("#print-sheet").innerHTML = html;
    window.print();
  }

  function wireCavities() {
    wireHoldingSearch("#cavities-holding-search", "cavities", renderCavities);
    const shift = (n) => {
      state.cavities.windowStart = addBusinessDays(
        state.cavities.windowStart || mostRecentOrSameMonday(new Date()), n);
      renderCavities();
    };
    $("#cavities-prev").addEventListener("click", () => shift(-5));
    $("#cavities-next").addEventListener("click", () => shift(5));
    $("#cavities-today").addEventListener("click", () => {
      state.cavities.windowStart = mostRecentOrSameMonday(new Date());
      renderCavities();
    });
  }

  // ---------- signing in ----------
  //
  // Reading is open to anyone; changing anything needs an account. The server
  // enforces that — this makes it visible, so a reader sees a locked board
  // rather than clicking things that fail.

  async function loadWhoAmI() {
    try {
      const me = await fetchJSON("/api/me");
      state.user = me.username || null;
      state.anyAccounts = !!me.any_accounts;
      state.isAdmin = !!me.is_admin;
      state.adminsSet = !!me.admins_set;
    } catch (e) {
      state.user = null;
      state.anyAccounts = false;
      state.isAdmin = false;
      state.adminsSet = true;
    }
    applySignedInState();
  }

  function applySignedInState() {
    const signedIn = !!state.user;
    document.body.classList.toggle("is-readonly", !signedIn);
    document.body.classList.toggle("is-admin", signedIn && state.isAdmin);
    $("#who").hidden = !signedIn;
    $("#who").textContent = signedIn ? state.user : "";
    $("#signInBtn").hidden = signedIn;
    $("#signOutBtn").hidden = !signedIn;
    $("#readonlyBanner").hidden = signedIn;
  }

  function openSignIn() {
    $("#signinError").hidden = true;
    $("#signinBackdrop").hidden = false;
    $("#signinUser").focus();
  }

  function closeSignIn() {
    $("#signinBackdrop").hidden = true;
    $("#signinForm").reset();
  }

  function wireSignIn() {
    $("#signInBtn").addEventListener("click", openSignIn);
    $("#bannerSignIn").addEventListener("click", openSignIn);
    $("#signinCancel").addEventListener("click", closeSignIn);
    $("#signinBackdrop").addEventListener("click", (e) => {
      if (e.target === $("#signinBackdrop")) closeSignIn();
    });
    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape" && !$("#signinBackdrop").hidden) closeSignIn();
    });

    $("#signinForm").addEventListener("submit", async (e) => {
      e.preventDefault();
      const btn = $("#signinSubmit");
      btn.disabled = true;
      try {
        await postJSON("/api/login", {
          username: $("#signinUser").value.trim(),
          password: $("#signinPass").value,
        });
        closeSignIn();
        await loadWhoAmI();
        await refreshAll();
      } catch (err) {
        $("#signinError").hidden = false;
        $("#signinError").textContent = err.message || "Couldn't sign in.";
      } finally {
        btn.disabled = false;
      }
    });

    $("#signOutBtn").addEventListener("click", async () => {
      try {
        await postJSON("/api/logout", {});
      } catch (e) {
        /* signing out locally is what matters */
      }
      await loadWhoAmI();
      await refreshAll();
    });
  }

  // ---------- accounts ----------
  //
  // Rarely used, so it hangs off your name in the corner rather than taking a
  // tab. Saving an existing name changes that person's password.

  async function openAccounts() {
    $("#accountError").hidden = true;
    $("#accountNote").hidden = true;
    $("#accountForm").reset();
    $("#accountsBackdrop").hidden = false;
    await renderAccounts();
  }

  function closeAccounts() {
    $("#accountsBackdrop").hidden = true;
  }

  async function renderAccounts() {
    const listEl = $("#accountList");
    let accounts = [];
    let adminsSet = true;
    try {
      const data = await fetchJSON("/api/users");
      accounts = data.accounts || (data.users || []).map((u) => ({ username: u, is_admin: false }));
      adminsSet = !!data.admins_set;
    } catch (e) {
      listEl.innerHTML = `<li class="account-row is-empty">Couldn't load accounts.</li>`;
      return;
    }

    const note = $("#accountAdminNote");
    note.hidden = adminsSet;
    if (!adminsSet) {
      note.textContent = "Nobody is an admin yet, so everyone signed in can enter door numbers. Tick someone to make that theirs.";
    }

    listEl.innerHTML = accounts
      .map(({ username: u, is_admin: admin }) => {
        const isMe = state.user && u.toLowerCase() === state.user.toLowerCase();
        // The server refuses both of these too — this is so the button isn't
        // offered when it can only fail.
        const canRemove = !isMe && accounts.length > 1;
        const canToggle = state.isAdmin;
        return `<li class="account-row">
          <span class="account-name">${escapeAttr(u)}${isMe ? '<span class="account-you">you</span>' : ""}</span>
          <label class="account-admin" title="Admins keep the door numbers">
            <input type="checkbox" class="account-admin-box" data-user="${escapeAttr(u)}" ${admin ? "checked" : ""} ${canToggle ? "" : "disabled"}>
            Admin
          </label>
          ${canRemove
            ? `<button type="button" class="link-btn account-remove" data-user="${escapeAttr(u)}">Remove</button>`
            : `<span class="account-locked">${isMe ? "signed in" : "only account"}</span>`}
        </li>`;
      })
      .join("");

    $$(".account-admin-box").forEach((box) => {
      box.addEventListener("change", async () => {
        try {
          await postJSON(`/api/users/${encodeURIComponent(box.dataset.user)}/admin`, { is_admin: box.checked });
          $("#accountError").hidden = true;
          await loadWhoAmI();          // losing your own admin has to take effect now
          await renderAccounts();
        } catch (err) {
          box.checked = !box.checked;
          if (err.needsSignIn) return;
          $("#accountError").hidden = false;
          $("#accountError").textContent = err.message || "Couldn't change that.";
        }
      });
    });

    $$(".account-remove").forEach((btn) => {
      btn.addEventListener("click", async () => {
        const who = btn.dataset.user;
        if (!confirm(`Remove ${who}? They'll be able to read the board but not change anything.`)) return;
        try {
          await apiDelete(`/api/users/${encodeURIComponent(who)}`);
          $("#accountError").hidden = true;
          await renderAccounts();
        } catch (err) {
          $("#accountError").hidden = false;
          $("#accountError").textContent = err.message || "Couldn't remove that account.";
        }
      });
    });
  }

  function wireAccounts() {
    $("#who").addEventListener("click", openAccounts);
    $("#accountsClose").addEventListener("click", closeAccounts);
    $("#accountsBackdrop").addEventListener("click", (e) => {
      if (e.target === $("#accountsBackdrop")) closeAccounts();
    });
    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape" && !$("#accountsBackdrop").hidden) closeAccounts();
    });

    $("#accountForm").addEventListener("submit", async (e) => {
      e.preventDefault();
      const btn = $("#accountSave");
      const name = $("#accountUser").value.trim();
      btn.disabled = true;
      $("#accountError").hidden = true;
      $("#accountNote").hidden = true;
      try {
        const res = await postJSON("/api/users", { username: name, password: $("#accountPass").value });
        $("#accountForm").reset();
        $("#accountNote").hidden = false;
        $("#accountNote").textContent = res.created
          ? `${res.username} can now sign in.`
          : `Password changed for ${res.username}.`;
        await renderAccounts();
      } catch (err) {
        $("#accountError").hidden = false;
        $("#accountError").textContent = err.message || "Couldn't save that account.";
      } finally {
        btn.disabled = false;
      }
    });
  }

  // ---------- huddle view ----------

  function wireHuddle() {
    const btn = $("#schedule-huddle");
    const root = document.documentElement;

    const isFullscreen = () => !!(document.fullscreenElement || document.webkitFullscreenElement);

    function setHuddle(on) {
      state.huddle = on;
      // On <html> too, so the wall-screen breakpoints can scale the root font
      // size without needing :has().
      document.documentElement.classList.toggle("is-huddle", on);
      document.body.classList.toggle("is-huddle", on);
      btn.textContent = on ? "⛶ Exit huddle" : "⛶ Huddle view";
      if (on) {
        // Open on yesterday, not today. A morning meeting starts with what was
        // meant to be finished yesterday and wasn't — anything still short of a
        // full green fill in that first column is the conversation. Today and
        // tomorrow follow it.
        state.scheduleWindowStart = addBusinessDays(nextOrSameBusinessDay(new Date()), -1);
      }
      renderScheduling();
    }

    btn.addEventListener("click", () => {
      const goingIn = !state.huddle;
      // The layout is the point; going full screen is a bonus. Some TV and
      // kiosk browsers refuse the fullscreen call, and the huddle view still
      // has to work on those, so drive it off our own flag and ask for
      // fullscreen separately without caring whether it lands.
      setHuddle(goingIn);
      try {
        if (goingIn) {
          const req = root.requestFullscreen || root.webkitRequestFullscreen;
          if (req) Promise.resolve(req.call(root)).catch(() => {});
        } else if (isFullscreen()) {
          const exit = document.exitFullscreen || document.webkitExitFullscreen;
          if (exit) Promise.resolve(exit.call(document)).catch(() => {});
        }
      } catch (e) {
        /* fullscreen refused — the huddle layout is already applied */
      }
    });

    // Leaving fullscreen with Esc should drop the huddle layout too.
    const onChange = () => {
      if (!isFullscreen() && state.huddle) setHuddle(false);
    };
    document.addEventListener("fullscreenchange", onChange);
    document.addEventListener("webkitfullscreenchange", onChange);
  }

  // ---------- boot ----------

  // Dragging a card uses HTML5 drag events, which never fire from a finger, so
  // on a touch screen the board is read-only. Say so rather than leaving an
  // instruction that can't be followed.
  if (window.matchMedia && matchMedia("(pointer: coarse)").matches) {
    const note = $("#view-scheduling .leveling-note");
    if (note) {
      note.textContent =
        "Read-only on a touch screen — cards can't be dragged with a finger. " +
        "You can check what's on each day here; open the dashboard on a computer to move jobs between days.";
    }
  }

  wireTabs();
  wireSignIn();
  wireAccounts();
  wireNoTouch();
  wireWm();
  wirePallet();
  wireLabelsTab();
  wireDoorNumbers();
  wireRescan();
  wireUpload();
  wireScheduleNav();
  wireHoldingSearch("#schedule-holding-search", "schedule", renderScheduling);
  wireHuddle();
  wireCavities();
  wireFactoryDayNav();
  wireFactoryReset();
  refreshAll().catch((e) => console.error(e));

  // light polling so a drop-in file shows up without a manual click
  setInterval(() => refreshAll().catch((e) => console.error(e)), 60000);
})();
