/* 界面层：只负责渲染与事件；所有业务规则都在 store.js。
   离线：本程序无任何网络/CDN 依赖，file:// 直接打开即用，数据存本机 localStorage。 */
(function () {
  "use strict";
  const $ = sel => document.querySelector(sel);
  const $$ = sel => Array.from(document.querySelectorAll(sel));
  const Store = window.DiveStore;
  const L = Store.STATUS_LABELS;
  const TYPE_NAMES = { ceramic: "陶片", wood: "木构件", metal: "金属件", unknown: "未知物" };

  const store = new Store({ storage: window.localStorage });

  /* ---------- 小工具 ---------- */
  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  }
  function fmtTime(ts) {
    if (!ts) return "—";
    const d = new Date(ts);
    const p = n => String(n).padStart(2, "0");
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
  }
  // datetime-local 值（本地时区，秒以下精度不要）
  function toLocalInput(ts) {
    const d = new Date(ts);
    const p = n => String(n).padStart(2, "0");
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
  }
  function fromLocalInput(v) { return v ? new Date(v).getTime() : NaN; }
  function download(filename, content, type) {
    const blob = new Blob([content], { type: type || "application/json" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = filename;
    a.click();
    URL.revokeObjectURL(a.href);
  }
  function uuid() {
    return typeof crypto !== "undefined" && crypto.randomUUID ? crypto.randomUUID() : "k-" + Math.random().toString(16).slice(2) + Date.now().toString(16);
  }

  let toastTimer = null;
  function toast(msg, kind) {
    const el = $("#toast");
    el.textContent = msg;
    el.className = "toast" + (kind ? " " + kind : "");
    el.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { el.hidden = true; }, kind === "error" ? 6000 : 3200);
  }
  // 数据层错误 → 面向排班员的中文明细
  function describeError(e) {
    if (!(e instanceof Store.ValidationError)) return e.message || String(e);
    const d = e.details;
    switch (e.code) {
      case "PERSON_CONFLICT":
        return e.message + "：\n" + (d || []).map(x => `· ${x.diver} 与 ${x.otherTask} 时间重叠`).join("\n");
      case "CYLINDER_CONFLICT":
        return e.message + "：\n" + (d || []).map(x => `· 气瓶 ${x.cylinder} 与 ${x.otherTask} 同时段冲突`).join("\n");
      case "GAS_SHORTFALL":
        if (Array.isArray(d)) return e.message + "：\n" + d.map(x => `· ${x.diver} / ${x.cylinder}：需求 ${x.need}L，其它任务已占 ${x.reservedByOthers}L，可用 ${x.free}L，缺口 ${x.deficit}L`).join("\n");
        return `${e.message}：需 ${d.deficit}L（已用 ${d.used}L，其它占用 ${d.reservedByOthers}L，可用 ${d.free}L）`;
      case "WEATHER_BLOCK":
        if (d && d.reason === "bad-window") return e.message + "：与恶劣天气窗口重叠（" + d.bad.map(w => esc(w.note) || fmtTime(w.from)).join("、") + "）";
        if (d && d.reason === "no-coverage") return e.message + "：从 " + fmtTime(d.gapFrom) + " 起没有良好天气覆盖";
        return e.message;
      case "ILLEGAL_TRANSITION":
        return e.message;
      default:
        return e.message;
    }
  }
  function run(fn, okMsg) {
    try { const r = fn(); if (okMsg) toast(okMsg); return r; }
    catch (e) { toast(describeError(e), "error"); return null; }
  }
  const actor = () => {
    const v = $("#operator").value.trim();
    if (!v) { toast("请先在右上角填写当前操作者姓名", "warn"); return null; }
    return v;
  };

  /* ---------- 操作者 ---------- */
  const OPERATOR_KEY = "zfl30.operator";
  $("#operator").value = localStorage.getItem(OPERATOR_KEY) || "";
  $("#operator").addEventListener("change", () => {
    // 只持久化，不重渲染：操作者姓名在每次动作时实时读取；
    // 这里若重渲染，会在输入框失焦（change 恰在 pointerdown 时触发）的瞬间
    // 替换掉用户正在点的按钮，导致第一次点击落空。
    localStorage.setItem(OPERATOR_KEY, $("#operator").value.trim());
  });

  /* ---------- 标签页 ---------- */
  $$("#tabs button").forEach(btn => {
    btn.addEventListener("click", () => {
      $$("#tabs button").forEach(b => b.classList.toggle("active", b === btn));
      $$(".tabpane").forEach(p => p.classList.toggle("active", p.id === "pane-" + btn.dataset.tab));
      renderAll();
    });
  });

  /* ---------- 导出（沿用原单页导出 + 新增全量导出） ---------- */
  $("#exportMarksBtn").addEventListener("click", () => {
    download("dive-marks.json", JSON.stringify(store.list("marks"), null, 2));
  });
  $("#exportAllBtn").addEventListener("click", () => {
    const payload = store.exportAll();
    download("dive-ops-" + new Date().toISOString().slice(0, 10) + ".json", JSON.stringify(payload, null, 2));
  });

  /* ==================================================================
   * 基础数据：遗址 / 人员 / 气瓶 / 天气窗口
   * ================================================================== */
  function fillSelect(sel, rows, blank) {
    const cur = sel.value;
    sel.innerHTML = (blank ? `<option value="">${blank}</option>` : "") +
      rows.map(r => `<option value="${esc(r.id)}">${esc(r.code || r.name)}</option>`).join("");
    if (cur && rows.some(r => r.id === cur)) sel.value = cur;
  }

  function bindSimpleForm(formId, entity, listId, build, extra) {
    const form = $("#" + formId);
    form.addEventListener("submit", e => {
      e.preventDefault();
      const who = actor(); if (!who) return;
      const input = build(new FormData(form));
      const r = run(() => store[extra.method](input, who), "已保存");
      if (r) { form.reset(); if (extra.afterReset) extra.afterReset(form); renderAll(); }
    });
    $("#" + listId).addEventListener("click", e => {
      const itemEl = e.target.closest(".mini-item");
      if (!itemEl) return;
      if (e.target.matches(".del")) {
        const who = actor(); if (!who) return;
        if (!confirm("确认删除该记录？被活动潜次占用的数据会被拒绝。")) return;
        if (run(() => store.deleteRecord(entity, itemEl.dataset.id, who), "已删除")) { form.reset(); renderAll(); }
        return;
      }
      extra.fillForm(form, store.get(entity, itemEl.dataset.id));
    });
  }

  bindSimpleForm("siteForm", "sites", "siteList",
    fd => ({ id: fd.get("id"), code: fd.get("code"), name: fd.get("name"), depthM: fd.get("depthM"), note: fd.get("note") }),
    {
      method: "upsertSite",
      fillForm: (f, r) => { f.id.value = r.id; f.code.value = r.code; f.name.value = r.name; f.depthM.value = r.depthM; f.note.value = r.note || ""; },
    });

  bindSimpleForm("diverForm", "divers", "diverList",
    fd => ({ id: fd.get("id"), name: fd.get("name"), cert: fd.get("cert"), sac: fd.get("sac"), phone: fd.get("phone"), note: fd.get("note") }),
    {
      method: "upsertDiver",
      fillForm: (f, r) => { f.id.value = r.id; f.name.value = r.name; f.cert.value = r.cert || ""; f.sac.value = r.sac || ""; f.phone.value = r.phone || ""; f.note.value = r.note || ""; },
    });

  bindSimpleForm("cylinderForm", "cylinders", "cylinderList",
    fd => ({ id: fd.get("id"), code: fd.get("code"), volumeL: fd.get("volumeL"), pressureBar: fd.get("pressureBar"), reserveBar: fd.get("reserveBar"), note: fd.get("note") }),
    {
      method: "upsertCylinder",
      fillForm: (f, r) => { f.id.value = r.id; f.code.value = r.code; f.volumeL.value = r.volumeL; f.pressureBar.value = r.pressureBar; f.reserveBar.value = r.reserveBar || ""; f.note.value = r.note || ""; },
    });

  // 天气窗口
  const windowForm = $("#windowForm");
  windowForm.addEventListener("submit", e => {
    e.preventDefault();
    const who = actor(); if (!who) return;
    const fd = new FormData(windowForm);
    const input = {
      id: fd.get("id"), siteId: fd.get("siteId"),
      from: fromLocalInput(fd.get("from")), to: fromLocalInput(fd.get("to")),
      state: fd.get("stateBadge") ? "bad" : "good", note: fd.get("note"),
    };
    if (run(() => store.upsertWindow(input, who), "窗口已保存")) { windowForm.reset(); renderAll(); }
  });
  $("#windowList").addEventListener("click", e => {
    const itemEl = e.target.closest(".mini-item");
    if (!itemEl) return;
    if (e.target.matches(".del")) {
      const who = actor(); if (!who) return;
      if (!confirm("删除该天气窗口？若活动潜次因此失去覆盖会被拒绝。")) return;
      if (run(() => store.deleteRecord("windows", itemEl.dataset.id, who), "已删除")) { windowForm.reset(); renderAll(); }
      return;
    }
    const w = store.get("windows", itemEl.dataset.id);
    const f = windowForm;
    f.id.value = w.id; f.siteId.value = w.siteId; f.stateBadge.checked = w.state === "bad";
    f.from.value = toLocalInput(w.from); f.to.value = toLocalInput(w.to); f.note.value = w.note || "";
  });

  function renderBaseData() {
    const sites = store.list("sites");
    const divers = store.list("divers");
    const cylinders = store.list("cylinders");
    const windows = store.list("windows");

    $("#siteList").innerHTML = sites.map(s =>
      `<div class="mini-item" data-id="${s.id}"><b>${esc(s.code)}</b> ${esc(s.name)} · ${s.depthM}m
       <button type="button" class="del danger small" style="float:right">删</button><br><span class="muted">${esc(s.note || "")}</span></div>`).join("") || `<div class="muted">暂无遗址</div>`;

    $("#diverList").innerHTML = divers.map(d =>
      `<div class="mini-item" data-id="${d.id}"><b>${esc(d.name)}</b> ${esc(d.cert || "")} · SAC ${d.sac}L/min
       <button type="button" class="del danger small" style="float:right">删</button><br><span class="muted">${esc(d.note || "")}</span></div>`).join("") || `<div class="muted">暂无人员</div>`;

    $("#cylinderList").innerHTML = cylinders.map(c => {
      const free = Store.cylinderFreeLiters(c);
      return `<div class="mini-item" data-id="${c.id}"><b>${esc(c.code)}</b> ${c.volumeL}L × ${c.pressureBar}bar
       <button type="button" class="del danger small" style="float:right">删</button><br><span class="muted">可用 ${free}L（残压保护 ${c.reserveBar}bar）${c.note ? " · " + esc(c.note) : ""}</span></div>`;
    }).join("") || `<div class="muted">暂无气瓶</div>`;

    $("#windowList").innerHTML = windows.map(w => {
      const site = sites.find(s => s.id === w.siteId);
      return `<div class="mini-item" data-id="${w.id}"><span class="pill ${w.state === "bad" ? "bad" : "good"}">${w.state === "bad" ? "恶劣" : "良好"}</span>
        <b>${esc(site ? site.code : "?")}</b> ${fmtTime(w.from)} → ${fmtTime(w.to)}
        <button type="button" class="del danger small" style="float:right">删</button><br><span class="muted">${esc(w.note || "")}</span></div>`;
    }).join("") || `<div class="muted">暂无天气窗口</div>`;

    fillSelect(windowForm.siteId, sites, "选择遗址");
    fillSelect($("#taskSiteFilter"), sites, null);
    // 操作员 datalist
    $("#operatorList").innerHTML = divers.map(d => `<option value="${esc(d.name)}">`).join("");
  }

  /* ==================================================================
   * 排班表单 + 看板
   * ================================================================== */
  const taskForm = $("#taskForm");
  const assignRows = $("#assignRows");

  function assignmentRow(diverId, cylinderId) {
    const divers = store.list("divers");
    const cylinders = store.list("cylinders");
    const div = document.createElement("div");
    div.className = "assign-row";
    div.innerHTML = `
      <select class="a-diver" required><option value="">选择潜水员</option>${divers.map(d => `<option value="${esc(d.id)}" ${d.id === diverId ? "selected" : ""}>${esc(d.name)}（SAC ${d.sac}）</option>`).join("")}</select>
      <select class="a-cylinder" required><option value="">选择气瓶</option>${cylinders.map(c => `<option value="${esc(c.id)}" ${c.id === cylinderId ? "selected" : ""}>${esc(c.code)} ${c.pressureBar}bar</option>`).join("")}</select>
      <button type="button" class="a-del" title="移除">×</button>`;
    div.querySelector(".a-del").addEventListener("click", () => { div.remove(); renderGasPreview(); });
    div.querySelectorAll("select").forEach(s => s.addEventListener("change", renderGasPreview));
    return div;
  }
  $("#addAssignBtn").addEventListener("click", () => {
    assignRows.appendChild(assignmentRow());
  });

  function readAssignments() {
    return $$("#assignRows .assign-row").map(row => ({
      diverId: row.querySelector(".a-diver").value,
      cylinderId: row.querySelector(".a-cylinder").value,
    })).filter(a => a.diverId || a.cylinderId);
  }

  function renderGasPreview() {
    const fd = new FormData(taskForm);
    const depthM = Number(fd.get("depthM"));
    const plannedMin = Number(fd.get("plannedMin"));
    const lines = [];
    for (const a of readAssignments()) {
      if (!a.diverId || !a.cylinderId || !(depthM > 0) || !(plannedMin > 0)) continue;
      const diver = store.get("divers", a.diverId);
      const cyl = store.get("cylinders", a.cylinderId);
      if (!diver || !cyl) continue;
      const need = Store.gasRequired(depthM, plannedMin, diver.sac);
      const free = Store.cylinderFreeLiters(cyl);
      const ok = need <= free;
      lines.push(`· ${esc(diver.name)} → ${esc(cyl.code)}：计划用气 ${need}L，当前可用 ${free}L ${ok ? "✓" : "✗ 不足"}`);
    }
    $("#gasPreview").innerHTML = lines.length ? lines.join("<br>") : "填写深度、时长并选择人员/气瓶后，自动核算计划气量（含20%余量）";
  }
  ["depthM", "plannedMin"].forEach(n => taskForm[n].addEventListener("input", renderGasPreview));

  function resetTaskForm() {
    taskForm.reset();
    taskForm.id.value = "";
    taskForm.clientKey.value = "";
    assignRows.innerHTML = "";
    assignRows.appendChild(assignmentRow());
    $("#submitTaskBtn").hidden = false;
    $("#updateTaskBtn").hidden = true;
    $("#cancelEditTaskBtn").hidden = true;
    renderGasPreview();
  }
  $("#resetTaskFormBtn").addEventListener("click", resetTaskForm);
  $("#cancelEditTaskBtn").addEventListener("click", resetTaskForm);

  function readTaskForm() {
    const fd = new FormData(taskForm);
    return {
      id: fd.get("id"),
      code: fd.get("code"), siteId: fd.get("siteId"),
      start: fromLocalInput(fd.get("start")), end: fromLocalInput(fd.get("end")),
      depthM: Number(fd.get("depthM")), plannedMin: Number(fd.get("plannedMin")),
      note: fd.get("note"), assignments: readAssignments(),
    };
  }

  // 提交排班：clientKey 在一次“点击提交”周期内固定，双击/弱网重试不会产生第二条
  $("#submitTaskBtn").closest("form").addEventListener("submit", e => {
    e.preventDefault();
    const who = actor(); if (!who) return;
    if (!taskForm.clientKey.value) taskForm.clientKey.value = uuid();
    const payload = readTaskForm();
    if (payload.id) return; // 编辑态走更新按钮
    const r = run(() => store.createTask(payload, who, taskForm.clientKey.value), null);
    if (!r) return;
    toast(r.duplicated ? "该提交已处理（重复提交已忽略）" : "排班已提交，进入待复核");
    resetTaskForm();
    renderAll();
  });

  $("#updateTaskBtn").addEventListener("click", () => {
    const who = actor(); if (!who) return;
    const payload = readTaskForm();
    if (run(() => store.updateTask(taskForm.id.value, payload, who), "修改已保存，仍为待复核")) {
      resetTaskForm(); renderAll();
    }
  });

  function editTask(id) {
    const t = store.get("tasks", id);
    if (!t) return;
    if (t.status !== "pending_review") { toast("只有待复核的潜次可以直接编辑；其余状态请走复核/执行按钮", "warn"); return; }
    $$("#tabs button").find(b => b.dataset.tab === "board").click();
    taskForm.id.value = t.id;
    taskForm.clientKey.value = "";
    taskForm.code.value = t.code;
    taskForm.siteId.value = t.siteId;
    taskForm.start.value = toLocalInput(t.start);
    taskForm.end.value = toLocalInput(t.end);
    taskForm.depthM.value = t.depthM;
    taskForm.plannedMin.value = t.plannedMin;
    taskForm.note.value = t.note || "";
    assignRows.innerHTML = "";
    t.assignments.forEach(a => assignRows.appendChild(assignmentRow(a.diverId, a.cylinderId)));
    $("#submitTaskBtn").hidden = true;
    $("#updateTaskBtn").hidden = false;
    $("#cancelEditTaskBtn").hidden = false;
    window.scrollTo({ top: 0, behavior: "smooth" });
    renderGasPreview();
  }

  /* ---------- 弹层（驳回 / 关闭 / 删除任务） ---------- */
  const modal = {
    el: $("#modalBackdrop"), title: $("#modalTitle"), body: $("#modalBody"), form: $("#modalForm"),
    onConfirm: null,
    open(title, bodyHtml, onConfirm) {
      this.title.textContent = title;
      this.body.innerHTML = bodyHtml;
      this.onConfirm = onConfirm;
      this.el.hidden = false;
    },
    close() { this.el.hidden = true; this.onConfirm = null; },
  };
  $("#modalCancel").addEventListener("click", () => modal.close());
  modal.el.addEventListener("click", e => { if (e.target === modal.el) modal.close(); });
  $("#modalForm").addEventListener("submit", e => {
    e.preventDefault();
    if (modal.onConfirm) modal.onConfirm(new FormData(modal.form));
  });

  function cardAction(id, action) {
    const who = actor(); if (!who) return;
    const t = store.get("tasks", id);
    if (action === "edit") return editTask(id);
    if (action === "approve") {
      if (run(() => store.approveTask(id, who), `已批准：${t.code}`)) renderAll();
    } else if (action === "start") {
      if (run(() => store.startTask(id, who), `开始执行：${t.code}`)) renderAll();
    } else if (action === "reject") {
      modal.open(`驳回 ${t.code}`, `<label>驳回原因（必填）<textarea name="reason" required placeholder="例如天气转差、人员资质不符"></textarea></label>`, fd => {
        if (run(() => store.rejectTask(id, fd.get("reason"), who), "已驳回")) { modal.close(); renderAll(); }
      });
    } else if (action === "close") {
      modal.open(`关闭 ${t.code}`, `
        <label>实际水下时长（分钟，必填）<input name="actualMin" type="number" min="1" value="${esc(t.plannedMin)}" required></label>
        <label class="inline-flat"><input type="checkbox" name="abnormal"> 异常关闭（勾选后必须填写情况说明）</label>
        <label>异常情况说明<textarea name="reason" placeholder="正常关闭可留空"></textarea></label>
        <label>关闭备注<input name="note"></label>
        <div class="muted">确认后将按实际时长扣减各潜水员气瓶压力；余量不足会被拒绝，需先到“气瓶”页登记补气。</div>`, fd => {
        const payload = {
          actualMin: Number(fd.get("actualMin")),
          outcome: fd.get("abnormal") ? "abnormal" : "normal",
          reason: fd.get("reason"), note: fd.get("note"),
        };
        if (run(() => store.closeTask(id, payload, who), "已关闭并扣减气量")) { modal.close(); renderAll(); }
      });
    } else if (action === "delete") {
      if (!confirm(`删除潜次 ${t.code}？仅待复核/已驳回可删除。`)) return;
      if (run(() => store.deleteTask(id, who), "已删除")) renderAll();
    }
  }

  function renderKanban() {
    const sites = store.list("sites");
    const divers = store.list("divers");
    const cylinders = store.list("cylinders");
    const statusQ = $("#taskStatusFilter").value;
    const siteQ = $("#taskSiteFilter").value;
    const kw = $("#taskSearch").value.trim().toLowerCase();

    let tasks = store.list("tasks");
    if (statusQ) tasks = tasks.filter(t => t.status === statusQ);
    if (siteQ) tasks = tasks.filter(t => t.siteId === siteQ);
    if (kw) tasks = tasks.filter(t => {
      const hay = [t.code, t.note, t.rejectReason, t.abnormalReason,
        ...t.assignments.map(a => (divers.find(d => d.id === a.diverId) || {}).name)].join(" ").toLowerCase();
      return hay.includes(kw);
    });
    tasks.sort((a, b) => a.start - b.start);

    const cols = Store.TASK_STATUSES;
    $("#kanban").innerHTML = cols.map(status => {
      const rows = tasks.filter(t => t.status === status);
      const cards = rows.map(t => {
        const site = sites.find(s => s.id === t.siteId);
        const people = t.assignments.map(a => {
          const d = divers.find(x => x.id === a.diverId);
          const c = cylinders.find(x => x.id === a.cylinderId);
          return `<div class="assignee">· ${esc(d ? d.name : "?")} / ${esc(c ? c.code : "?")} · 计划 ${a.plannedLiters}L${a.actualLiters ? ` · 实耗 ${a.actualLiters}L` : ""}</div>`;
        }).join("");
        const btns = [];
        if (t.status === "pending_review") {
          btns.push(`<button data-act="approve">批准</button><button class="secondary" data-act="reject">驳回</button><button class="ghost" data-act="edit">编辑</button><button class="danger" data-act="del">删除</button>`);
        }
        if (t.status === "approved") btns.push(`<button data-act="start">开始执行</button><button class="secondary" data-act="reject">驳回</button>`);
        if (t.status === "executing") btns.push(`<button data-act="close">关闭/异常处置</button>`);
        const extra = t.status === "rejected" ? `<div class="meta">驳回原因：${esc(t.rejectReason || "")}</div>` : "";
        const abn = t.status === "closed" && t.outcome === "abnormal" ? ` <span class="pill bad">异常</span><div class="meta">${esc(t.abnormalReason || "")}</div>` : "";
        return `<div class="task-card ${t.status}" data-id="${t.id}">
          <div class="code">${esc(t.code)}</div>
          <div class="meta">${esc(site ? site.code : "?")} · ${fmtTime(t.start)} → ${fmtTime(t.end)} · ${t.depthM}m / ${t.plannedMin}min</div>
          ${people}${extra}${abn}
          ${t.note ? `<div class="meta">备注：${esc(t.note)}</div>` : ""}
          <div class="meta">${esc(t.createdBy || "")} 提交</div>
          <div class="card-actions">${btns.join("")}</div>
        </div>`;
      }).join("");
      return `<div class="kcol"><h4><span>${L[status]}</span><span>${rows.length}</span></h4>${cards || '<div class="muted">—</div>'}</div>`;
    }).join("");

    $$("#kanban .task-card").forEach(card => {
      card.querySelectorAll("button").forEach(b => {
        b.addEventListener("click", () => {
          const act = b.dataset.act === "del" ? "delete" : b.dataset.act;
          cardAction(card.dataset.id, act);
        });
      });
    });
  }
  ["#taskStatusFilter", "#taskSiteFilter"].forEach(s => $(s).addEventListener("change", renderKanban));
  $("#taskSearch").addEventListener("input", renderKanban);

  function initTaskFormOnce() {
    const sites = store.list("sites");
    fillSelect(taskForm.siteId, sites, null);
    if (!assignRows.children.length) assignRows.appendChild(assignmentRow());
    // 默认时间：第一个良好窗口起点 +1 小时
    const win = store.list("windows").find(w => w.state === "good");
    if (win && !taskForm.start.value) {
      taskForm.start.value = toLocalInput(win.from + 3600000);
      taskForm.end.value = toLocalInput(win.from + 2 * 3600000);
      taskForm.depthM.value = (sites[0] && sites[0].depthM) || 18;
      taskForm.plannedMin.value = 30;
      taskForm.code.value = "DIVE-" + String(store.list("tasks").length + 1).padStart(3, "0");
      renderGasPreview();
    }
  }

  /* ==================================================================
   * 审计页
   * ================================================================== */
  const ACTION_CN = { create: "创建", update: "修改", delete: "删除", approve: "批准", reject: "驳回", start: "开始执行", close: "关闭" };
  const ENTITY_CN = { tasks: "潜次", marks: "标记", sites: "遗址", divers: "人员", cylinders: "气瓶", windows: "天气窗口" };
  function renderAudit() {
    const q = $("#auditEntityFilter").value;
    const rows = store.audits().filter(a => !q || a.entity === q);
    $("#auditList").innerHTML = rows.map(a => {
      const before = a.before === null ? "（无）" : JSON.stringify(a.before, null, 2);
      const after = a.after === null ? "（已删除）" : JSON.stringify(a.after, null, 2);
      const title = a.entity === "tasks" && a.after && a.after.code ? a.after.code
        : (a.before && (a.before.code || a.before.name)) || (a.after && (a.after.code || a.after.name)) || a.entityId;
      return `<div class="audit-item">
        <div class="head">
          <span>${ACTION_CN[a.action] || a.action} · ${ENTITY_CN[a.entity] || a.entity} · ${esc(title)}</span>
          <span class="muted">${esc(a.actor)} · ${fmtTime(a.ts)}</span>
        </div>
        ${a.note ? `<div class="muted">说明：${esc(a.note)}</div>` : ""}
        <details><summary>前后状态</summary>
          <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px">
            <div><b>变更前</b><pre>${esc(before)}</pre></div>
            <div><b>变更后</b><pre>${esc(after)}</pre></div>
          </div>
        </details>
      </div>`;
    }).join("") || `<div class="muted">暂无操作记录</div>`;
  }
  $("#auditEntityFilter").addEventListener("change", renderAudit);

  /* ==================================================================
   * 标记地图（原单页功能，接入 store/操作者/审计）
   * ================================================================== */
  const map = $("#map");
  const markForm = $("#markForm");
  let pendingPoint = null;
  for (let i = 0; i < 7; i++) {
    const rib = document.createElement("div");
    rib.className = "rib";
    rib.style.left = 28 + i * 7 + "%";
    map.appendChild(rib);
  }

  function renderMap() {
    map.querySelectorAll(".marker").forEach(el => el.remove());
    const f = $("#filter").value;
    const marks = store.list("marks").filter(m => !f || m.type === f);
    marks.forEach(mark => {
      const el = document.createElement("button");
      el.type = "button";
      el.className = "marker " + mark.type + (mark.id === markForm.id.value ? " selected" : "");
      el.style.left = mark.x + "%";
      el.style.top = mark.y + "%";
      el.textContent = mark.code.slice(0, 2);
      el.title = mark.code;
      el.addEventListener("click", event => { event.stopPropagation(); editMark(mark.id); });
      map.appendChild(el);
    });
    if ($("#view").value === "timeline") renderTimeline(marks);
    else renderList(marks);
  }
  function renderList(data) {
    $("#listTitle").textContent = "标记列表";
    const list = $("#list");
    list.className = "list";
    list.innerHTML = data.map(m =>
      `<div class="item ${m.id === markForm.id.value ? "active" : ""}" data-id="${esc(m.id)}"><b>${esc(m.code)}</b>
       <span class="pill">${TYPE_NAMES[m.type]}</span>
       <div class="muted">${esc(m.dive)} · ${esc(m.depth)} · ${esc(m.orientation || "")}</div>
       <div>${esc(m.condition || "")}</div></div>`).join("");
    list.querySelectorAll("[data-id]").forEach(el => el.addEventListener("click", () => editMark(el.dataset.id)));
  }
  function renderTimeline(data) {
    $("#listTitle").textContent = "潜次时间线";
    const list = $("#list");
    list.className = "timeline";
    const groups = data.reduce((g, item) => ((g[item.dive] ||= []).push(item), g), {});
    list.innerHTML = Object.entries(groups).map(([dive, items]) =>
      `<div class="item"><b>${esc(dive)}</b><div class="muted">新增${items.length}个标记</div>` +
      items.map(i => `<div>${esc(i.code)} · ${TYPE_NAMES[i.type]}</div>`).join("") + `</div>`).join("");
  }
  function editMark(id) {
    const m = store.get("marks", id);
    if (!m) return;
    for (const [k, v] of Object.entries(m)) if (markForm[k]) markForm[k].value = v;
    pendingPoint = { x: m.x, y: m.y };
    renderMap();
  }
  map.addEventListener("click", event => {
    const rect = map.getBoundingClientRect();
    pendingPoint = {
      x: Number(((event.clientX - rect.left) / rect.width * 100).toFixed(2)),
      y: Number(((event.clientY - rect.top) / rect.height * 100).toFixed(2)),
    };
    markForm.reset();
    markForm.id.value = "";
    markForm.x.value = pendingPoint.x; markForm.y.value = pendingPoint.y;
    markForm.code.value = "M-" + String(store.list("marks").length + 1).padStart(3, "0");
    markForm.dive.value = "DIVE-01";
    renderMap();
  });
  markForm.addEventListener("submit", event => {
    event.preventDefault();
    const who = actor(); if (!who) return;
    if (!pendingPoint) { toast("请先在平面图上点击选择位置", "warn"); return; }
    const fd = new FormData(markForm);
    const input = {
      id: fd.get("id") || undefined,
      code: fd.get("code"), type: fd.get("type"), dive: fd.get("dive"),
      depth: fd.get("depth"), orientation: fd.get("orientation"),
      condition: fd.get("condition"), note: fd.get("note"),
      x: pendingPoint.x, y: pendingPoint.y,
    };
    if (run(() => store.upsertMark(input, who), "标记已保存")) {
      markForm.reset(); pendingPoint = null; renderMap();
    }
  });
  $("#deleteMarkBtn").addEventListener("click", () => {
    if (!markForm.id.value) return;
    const who = actor(); if (!who) return;
    if (run(() => store.deleteMark(markForm.id.value, who), "标记已删除")) { markForm.reset(); pendingPoint = null; renderMap(); }
  });
  $("#filter").addEventListener("change", renderMap);
  $("#view").addEventListener("change", renderMap);

  /* ---------- 全局渲染 ---------- */
  function renderAll() {
    renderBaseData();
    renderKanban();
    renderAudit();
    renderMap();
    initTaskFormOnce();
  }
  renderAll();

  // 供浏览器端自动化测试使用
  window.__app = { store, renderAll, resetTaskForm, editTask };

  // 经 http(s) 访问时注册离线外壳；file:// 直接打开本身即离线，无需 SW
  if ("serviceWorker" in navigator && location.protocol.startsWith("http")) {
    window.addEventListener("load", () => navigator.serviceWorker.register("sw.js").catch(() => {}));
  }
})();
