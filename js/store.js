/*
 * 潜水作业排班与安全复核台 —— 数据层
 * 纯逻辑、零依赖、不接触 DOM。浏览器用 <script> 引入，Node 测试用 require。
 * 所有写操作：先在副本上完成业务校验，再一次性落盘（事务式 commit）；
 * 任何一步失败都抛出 ValidationError，内存与 localStorage 维持原状，不产生部分数据。
 */
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.DiveStore = factory();
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  const DB_KEY = "zfl30.db.v1";
  const LEGACY_MARKS_KEY = "zfl30Marks";
  const DB_VERSION = 1;

  // 任务状态机：只允许列出的越级变更，其余一律拒绝
  const TASK_STATUSES = ["pending_review", "approved", "executing", "closed", "rejected"];
  const STATUS_LABELS = {
    pending_review: "待复核",
    approved: "已批准",
    executing: "执行中",
    closed: "已关闭",
    rejected: "已驳回",
  };
  // action -> 允许的起始状态
  const TRANSITIONS = {
    approve: ["pending_review"],
    reject: ["pending_review", "approved"],
    start: ["approved"],
    close: ["executing"],
  };
  const ACTIVE_STATUSES = ["pending_review", "approved", "executing"]; // 参与冲突/气量占用
  // 已“排定”的任务：基础数据变更后不得把它们留在无法继续的状态
  const COMMITTED_STATUSES = ["approved", "executing"];

  const DEFAULT_SAC = 20;      // 缺省水面耗气量 L/min（人员未登记时）
  const GAS_MARGIN = 1.2;      // 计划安全余量 20%
  const DEFAULT_RESERVE_BAR = 50; // 气瓶残压保护，低于该压力的气量不可安排

  class ValidationError extends Error {
    constructor(code, message, details) {
      super(message);
      this.name = "ValidationError";
      this.code = code;
      this.details = details || null;
    }
  }

  function defaultUuid() {
    return typeof crypto !== "undefined" && crypto.randomUUID
      ? crypto.randomUUID()
      : "id-" + Math.random().toString(16).slice(2) + Date.now().toString(16);
  }

  function overlap(aStart, aEnd, bStart, bEnd) {
    return aStart < bEnd && aEnd > bStart;
  }

  function ata(depthM) { return 1 + Number(depthM) / 10; }

  /* 计划气量（升）：SAC × 时长 × 绝对压力 × 安全余量，用于排班/复核把关 */
  function gasRequired(depthM, minutes, sac) {
    return Math.round((Number(sac) || DEFAULT_SAC) * Number(minutes) * ata(depthM) * GAS_MARGIN);
  }

  /* 实际耗气（升）：SAC × 时长 × 绝对压力，不含余量，用于关闭时扣瓶 */
  function gasActual(depthM, minutes, sac) {
    return Math.round((Number(sac) || DEFAULT_SAC) * Number(minutes) * ata(depthM));
  }

  // 某气瓶当前可自由支配的气量（升）= 水容积 × (表压 − 残压保护)
  function cylinderFreeLiters(c) {
    const usableBar = Math.max(0, Number(c.pressureBar) - Number(c.reserveBar || DEFAULT_RESERVE_BAR));
    return Math.round(Number(c.volumeL) * usableBar);
  }

  function emptyState() {
    return {
      version: DB_VERSION,
      sites: [],
      divers: [],
      cylinders: [],
      windows: [],
      tasks: [],
      marks: [],
      audits: [],
      idempotency: {}, // 客户端去重键 -> taskId，拦截重复提交
    };
  }

  function seedState(uuid, now) {
    const s = emptyState();
    const t = now();
    const hour = 3600000;
    s.sites = [{ id: "site-1", code: "SITE-01", name: "一号沉船遗址", depthM: 18, note: "海床泥沙底，能见度约8m", createdAt: t }];
    s.divers = [
      { id: "div-1", name: "陈潜", cert: "AIR-DIVER-III", sac: 18, phone: "", note: "潜水长" },
      { id: "div-2", name: "林澜", cert: "AIR-DIVER-II", sac: 20, phone: "", note: "" },
      { id: "div-3", name: "高岸", cert: "AIR-DIVER-II", sac: 22, phone: "", note: "" },
    ];
    s.cylinders = [
      { id: "cyl-1", code: "C-12L-01", volumeL: 12, pressureBar: 220, reserveBar: 50, note: "" },
      { id: "cyl-2", code: "C-12L-02", volumeL: 12, pressureBar: 220, reserveBar: 50, note: "" },
      { id: "cyl-3", code: "C-12L-03", volumeL: 12, pressureBar: 180, reserveBar: 50, note: "" },
    ];
    // 明天 08:00–18:00 当地为良好窗口
    const dayStart = (Math.floor(t / 86400000) + 1) * 86400000 + 8 * hour;
    s.windows = [
      { id: "win-1", siteId: "site-1", from: dayStart, to: dayStart + 10 * hour, state: "good", note: "小浪，能见度良好", createdAt: t },
    ];
    s.marks = [
      { id: uuid(), code: "A-017", type: "ceramic", dive: "DIVE-01", x: 42, y: 46, depth: "17.8m", orientation: "东", condition: "边缘残缺", note: "靠近船肋" },
      { id: uuid(), code: "W-003", type: "wood", dive: "DIVE-02", x: 58, y: 39, depth: "18.2m", orientation: "西北", condition: "稳定", note: "疑似横梁" },
    ];
    const start = dayStart + hour; // 09:00
    s.tasks = [
      {
        id: uuid(), code: "DIVE-001", siteId: "site-1",
        start: start, end: start + 60 * 60000, depthM: 18, plannedMin: 30,
        assignments: [{ diverId: "div-1", cylinderId: "cyl-1", plannedLiters: gasRequired(18, 30, 18) }],
        status: "pending_review", note: "船肋东侧陶片区域复测",
        createdBy: "系统示例", createdAt: t, updatedAt: t,
      },
    ];
    return s;
  }

  class Store {
    constructor(options) {
      options = options || {};
      this.storage = options.storage === undefined
        ? (typeof localStorage !== "undefined" ? localStorage : null)
        : options.storage;
      this._now = options.now || (() => Date.now());
      this._uuid = options.uuid || defaultUuid;
      this.state = options.state || this._load();
    }

    now() { return this._now(); }

    _load() {
      if (this.storage) {
        const raw = this.storage.getItem(DB_KEY);
        if (raw) {
          try {
            const parsed = JSON.parse(raw);
            if (parsed && parsed.version === DB_VERSION) return parsed;
          } catch (e) { /* 落盘损坏：回退到种子，避免页面白屏 */ }
        }
        // 旧版单页数据迁移：zfl30Marks -> 新库 marks
        const legacy = this.storage.getItem(LEGACY_MARKS_KEY);
        if (legacy) {
          try {
            const marks = JSON.parse(legacy);
            if (Array.isArray(marks) && marks.length) {
              const seeded = seedState(this._uuid, this._now);
              seeded.marks = marks;
              return seeded;
            }
          } catch (e) { /* 旧数据损坏则忽略 */ }
        }
      }
      return seedState(this._uuid, this._now);
    }

    /* 事务式提交：所有变更发生在传入的 draft 上；mutator 返回审计条目
       （单对象或数组，不返回则不记审计）。校验在 mutator 内抛出 → draft 被整体丢弃，
       最后只有一次 setItem；setItem 失败（配额/隐私模式）时 this.state
       不被替换，内存数据也保持原状 → 不留下部分数据。
       数组中越靠后的审计在列表中越靠前（主变更放最后）。 */
    commit(mutator) {
      const draft = JSON.parse(JSON.stringify(this.state));
      const auditSpec = mutator(draft);
      if (auditSpec) {
        const specs = Array.isArray(auditSpec) ? auditSpec : [auditSpec];
        for (const spec of specs) draft.audits.unshift({ id: this._uuid(), ts: this._now(), ...spec });
      }
      if (this.storage) this.storage.setItem(DB_KEY, JSON.stringify(draft)); // 抛错则整体回滚
      this.state = draft;
      return draft;
    }

    // ---- 只读 ----
    list(entity) {
      if (!Object.prototype.hasOwnProperty.call(this.state, entity)) throw new ValidationError("UNKNOWN_ENTITY", "未知数据集合: " + entity);
      return JSON.parse(JSON.stringify(this.state[entity]));
    }
    get(entity, id) {
      const row = this.state[entity].find(r => r.id === id);
      return row ? JSON.parse(JSON.stringify(row)) : null;
    }
    audits() { return this.list("audits"); }
    exportAll() {
      return { exportedAt: this._now(), version: DB_VERSION, data: JSON.parse(JSON.stringify(this.state)) };
    }

    _requireActor(actor) {
      if (!actor || !String(actor).trim()) throw new ValidationError("MISSING_OPERATOR", "缺少操作者身份，禁止匿名变更");
      return String(actor).trim();
    }
    _find(state, entity, id) {
      const row = state[entity].find(r => r.id === id);
      if (!row) throw new ValidationError("NOT_FOUND", "记录不存在: " + entity + "/" + id);
      return row;
    }
    _snapshot(row) { return row === null ? null : JSON.parse(JSON.stringify(row)); }

    /* ============ 基础数据：遗址 / 人员 / 气瓶 / 天气窗口 ============ */
    upsertSite(input, actor) {
      actor = this._requireActor(actor);
      const data = { code: String(input.code || "").trim(), name: String(input.name || "").trim(), depthM: Number(input.depthM), note: String(input.note || "").trim() };
      if (!data.code) throw new ValidationError("FIELD_REQUIRED", "遗址编号必填", { field: "code" });
      if (!data.name) throw new ValidationError("FIELD_REQUIRED", "遗址名称必填", { field: "name" });
      if (!(data.depthM > 0)) throw new ValidationError("FIELD_INVALID", "深度必须为正数", { field: "depthM" });
      let id;
      this.commit(state => {
        if (state.sites.some(s => s.code === data.code && s.id !== input.id))
          throw new ValidationError("DUPLICATE_CODE", "遗址编号已存在: " + data.code);
        let saved;
        if (input.id) {
          saved = this._find(state, "sites", input.id);
          const before = this._snapshot(saved);
          Object.assign(saved, data);
          id = saved.id;
          return { actor, action: "update", entity: "sites", entityId: id, before, after: this._snapshot(saved) };
        }
        saved = { id: this._uuid(), ...data, createdAt: this._now() };
        state.sites.push(saved);
        id = saved.id;
        return { actor, action: "create", entity: "sites", entityId: id, before: null, after: this._snapshot(saved) };
      });
      return this.get("sites", id);
    }

    upsertDiver(input, actor) {
      actor = this._requireActor(actor);
      const data = {
        name: String(input.name || "").trim(),
        cert: String(input.cert || "").trim(),
        sac: input.sac === "" || input.sac == null ? DEFAULT_SAC : Number(input.sac),
        phone: String(input.phone || "").trim(),
        note: String(input.note || "").trim(),
      };
      if (!data.name) throw new ValidationError("FIELD_REQUIRED", "人员姓名必填", { field: "name" });
      if (!(data.sac > 0)) throw new ValidationError("FIELD_INVALID", "SAC 耗气量必须为正数", { field: "sac" });
      let id;
      this.commit(state => {
        if (state.divers.some(d => d.name === data.name && d.id !== input.id))
          throw new ValidationError("DUPLICATE_NAME", "人员姓名已存在: " + data.name);
        let saved;
        if (input.id) {
          saved = this._find(state, "divers", input.id);
          const diverBefore = this._snapshot(saved);
          const sacChanged = saved.sac !== data.sac;
          Object.assign(saved, data);
          id = saved.id;
          const specs = [
            { actor, action: "update", entity: "divers", entityId: id, before: diverBefore, after: this._snapshot(saved) },
          ];
          if (sacChanged) {
            // SAC 变更：重算所有活动任务中该潜水员的计划耗气，再统一复核气量
            for (const task of state.tasks.filter(t => ACTIVE_STATUSES.includes(t.status))) {
              for (const a of task.assignments) {
                if (a.diverId !== id) continue;
                const taskBefore = this._snapshot(task);
                a.plannedLiters = gasRequired(task.depthM, task.plannedMin, data.sac);
                specs.push({
                  actor, action: "recalc", entity: "tasks", entityId: task.id,
                  before: taskBefore, after: this._snapshot(task),
                  note: `${diverBefore.name} SAC ${diverBefore.sac}→${data.sac}，按新耗气率重算计划气量`,
                });
              }
            }
            // 任一活动任务因此失去气量保障 → 抛错，草稿（人员/任务/审计）整体丢弃
            this._revalidateGasForActiveTasks(state, {
              diver: data.name, reason: "sac-change",
              changed: ["sac"], from: diverBefore.sac, to: data.sac,
            });
          }
          return specs;
        }
        saved = { id: this._uuid(), ...data };
        state.divers.push(saved);
        id = saved.id;
        return { actor, action: "create", entity: "divers", entityId: id, before: null, after: this._snapshot(saved) };
      });
      return this.get("divers", id);
    }

    upsertCylinder(input, actor) {
      actor = this._requireActor(actor);
      const data = {
        code: String(input.code || "").trim(),
        volumeL: Number(input.volumeL),
        pressureBar: Number(input.pressureBar),
        reserveBar: input.reserveBar === "" || input.reserveBar == null ? DEFAULT_RESERVE_BAR : Number(input.reserveBar),
        note: String(input.note || "").trim(),
      };
      if (!data.code) throw new ValidationError("FIELD_REQUIRED", "气瓶编号必填", { field: "code" });
      if (!(data.volumeL > 0)) throw new ValidationError("FIELD_INVALID", "水容积必须为正数", { field: "volumeL" });
      if (!(data.pressureBar >= 0)) throw new ValidationError("FIELD_INVALID", "表压不能为负", { field: "pressureBar" });
      if (!(data.reserveBar >= 0) || data.reserveBar > data.pressureBar)
        throw new ValidationError("FIELD_INVALID", "残压保护需在 0 至表压之间", { field: "reserveBar" });
      let id;
      this.commit(state => {
        if (state.cylinders.some(c => c.code === data.code && c.id !== input.id))
          throw new ValidationError("DUPLICATE_CODE", "气瓶编号已存在: " + data.code);
        let saved;
        if (input.id) {
          saved = this._find(state, "cylinders", input.id);
          const before = this._snapshot(saved);
          Object.assign(saved, data);
          // 写入草稿后复核全部活动任务：容积调小、残压保护上调、压力下调都可能击穿占用
          this._revalidateGasForActiveTasks(state, {
            cylinder: data.code,
            changed: Object.keys(data).filter(k => JSON.stringify(data[k]) !== JSON.stringify(before[k])),
          });
          id = saved.id;
          return { actor, action: "update", entity: "cylinders", entityId: id, before, after: this._snapshot(saved) };
        }
        saved = { id: this._uuid(), ...data };
        state.cylinders.push(saved);
        id = saved.id;
        return { actor, action: "create", entity: "cylinders", entityId: id, before: null, after: this._snapshot(saved) };
      });
      return this.get("cylinders", id);
    }

    upsertWindow(input, actor) {
      actor = this._requireActor(actor);
      const data = {
        siteId: String(input.siteId || ""),
        from: Number(input.from),
        to: Number(input.to),
        state: input.state === "bad" ? "bad" : "good",
        note: String(input.note || "").trim(),
      };
      if (!data.siteId) throw new ValidationError("FIELD_REQUIRED", "请选择遗址", { field: "siteId" });
      if (!(data.from > 0) || !(data.to > data.from)) throw new ValidationError("FIELD_INVALID", "窗口结束时间必须晚于开始时间");
      let id;
      this.commit(state => {
        this._find(state, "sites", data.siteId);
        let saved;
        if (input.id) {
          saved = this._find(state, "windows", input.id);
          const before = this._snapshot(saved);
          Object.assign(saved, data);
          // 改写已有窗口（改恶劣/缩短/移址）后，已批准与执行中的任务仍须有良好天气覆盖
          this._revalidateWeatherForCommittedTasks(state, {
            window: input.id, siteId: data.siteId,
            changed: Object.keys(data).filter(k => JSON.stringify(data[k]) !== JSON.stringify(before[k])),
          });
          id = saved.id;
          return { actor, action: "update", entity: "windows", entityId: id, before, after: this._snapshot(saved) };
        }
        saved = { id: this._uuid(), ...data, createdAt: this._now() };
        state.windows.push(saved);
        id = saved.id;
        return { actor, action: "create", entity: "windows", entityId: id, before: null, after: this._snapshot(saved) };
      });
      return this.get("windows", id);
    }

    deleteRecord(entity, id, actor) {
      actor = this._requireActor(actor);
      if (!["sites", "divers", "cylinders", "windows", "marks"].includes(entity))
        throw new ValidationError("BAD_ENTITY", "该类数据不允许直接删除");
      this.commit(state => {
        const before = this._snapshot(this._find(state, entity, id));
        if (entity === "divers" && state.tasks.some(t => ACTIVE_STATUSES.includes(t.status) && t.assignments.some(a => a.diverId === id)))
          throw new ValidationError("IN_USE", "该人员已被活动潜次占用，不能删除");
        if (entity === "cylinders" && state.tasks.some(t => ACTIVE_STATUSES.includes(t.status) && t.assignments.some(a => a.cylinderId === id)))
          throw new ValidationError("IN_USE", "该气瓶已被活动潜次占用，不能删除");
        if (entity === "sites" && (
          state.tasks.some(t => ACTIVE_STATUSES.includes(t.status) && t.siteId === id) ||
          state.windows.some(w => w.siteId === id)))
          throw new ValidationError("IN_USE", "该遗址下仍有活动潜次或天气窗口，不能删除");
        if (entity === "windows") {
          const trial = JSON.parse(JSON.stringify(state));
          trial.windows = trial.windows.filter(w => w.id !== id);
          for (const t of trial.tasks.filter(x => ACTIVE_STATUSES.includes(x.status))) {
            const weather = this._checkWeather(trial, t);
            if (!weather.ok) throw new ValidationError("WEATHER_BLOCK", "删除窗口会导致潜次 " + t.code + " 失去良好天气覆盖", weather);
          }
        }
        state[entity] = state[entity].filter(r => r.id !== id);
        return { actor, action: "delete", entity, entityId: id, before, after: null };
      });
      return true;
    }

    /* ============ 潜次任务 ============ */

    _normalizeTaskInput(state, input) {
      const code = String(input.code || "").trim();
      const siteId = String(input.siteId || "");
      const start = Number(input.start);
      const end = Number(input.end);
      const depthM = Number(input.depthM);
      const plannedMin = Number(input.plannedMin);
      if (!code) throw new ValidationError("FIELD_REQUIRED", "潜次编号必填", { field: "code" });
      if (!siteId) throw new ValidationError("FIELD_REQUIRED", "请选择遗址", { field: "siteId" });
      this._find(state, "sites", siteId);
      if (!(start > 0) || !(end > start)) throw new ValidationError("FIELD_INVALID", "结束时间必须晚于开始时间");
      if (!(plannedMin > 0)) throw new ValidationError("FIELD_INVALID", "计划水下时长必须为正数", { field: "plannedMin" });
      if (!(depthM > 0)) throw new ValidationError("FIELD_INVALID", "深度必须为正数", { field: "depthM" });
      const pairs = Array.isArray(input.assignments) ? input.assignments : [];
      if (!pairs.length) throw new ValidationError("FIELD_REQUIRED", "至少安排一名潜水员");
      const diverIds = new Set();
      const cylinderIds = new Set();
      const assignments = pairs.map(p => {
        const diverId = String(p.diverId || "");
        const cylinderId = String(p.cylinderId || "");
        if (!diverId) throw new ValidationError("FIELD_REQUIRED", "存在未选择人员的行");
        if (!cylinderId) throw new ValidationError("FIELD_REQUIRED", "存在未分配气瓶的行");
        if (diverIds.has(diverId)) throw new ValidationError("DUPLICATE_DIVER", "同一潜次内人员重复");
        if (cylinderIds.has(cylinderId)) throw new ValidationError("DUPLICATE_CYLINDER", "同一潜次内气瓶重复");
        diverIds.add(diverId); cylinderIds.add(cylinderId);
        const diver = this._find(state, "divers", diverId);
        this._find(state, "cylinders", cylinderId);
        return { diverId, cylinderId, plannedLiters: gasRequired(depthM, plannedMin, diver.sac) };
      });
      return { code, siteId, start, end, depthM, plannedMin, assignments, note: String(input.note || "").trim() };
    }

    // 人员同一时间段只能在一个活动潜次里
    _checkPeopleConflicts(state, task) {
      const conflicts = [];
      for (const other of state.tasks) {
        if (other.id === task.id || !ACTIVE_STATUSES.includes(other.status)) continue;
        if (!overlap(task.start, task.end, other.start, other.end)) continue;
        for (const a of task.assignments) {
          if (other.assignments.some(o => o.diverId === a.diverId)) {
            const diver = state.divers.find(d => d.id === a.diverId);
            conflicts.push({ diverId: a.diverId, diver: diver ? diver.name : a.diverId, otherTask: other.code });
          }
        }
      }
      return conflicts.length ? { ok: false, conflicts } : { ok: true };
    }

    // 同一气瓶不能同时段分给两个活动潜次
    _checkCylinderConflicts(state, task) {
      const conflicts = [];
      for (const other of state.tasks) {
        if (other.id === task.id || !ACTIVE_STATUSES.includes(other.status)) continue;
        if (!overlap(task.start, task.end, other.start, other.end)) continue;
        for (const a of task.assignments) {
          if (other.assignments.some(o => o.cylinderId === a.cylinderId)) {
            const c = state.cylinders.find(x => x.id === a.cylinderId);
            conflicts.push({ cylinderId: a.cylinderId, cylinder: c ? c.code : a.cylinderId, otherTask: other.code });
          }
        }
      }
      return conflicts.length ? { ok: false, conflicts } : { ok: true };
    }

    // 某气瓶被除 excludeTask 外的活动任务占用的计划气量
    _cylinderReserved(state, cylinderId, excludeTaskId) {
      let liters = 0;
      for (const t of state.tasks) {
        if (t.id === excludeTaskId || !ACTIVE_STATUSES.includes(t.status)) continue;
        for (const a of t.assignments) if (a.cylinderId === cylinderId) liters += Number(a.plannedLiters || 0);
      }
      return liters;
    }

    // 每个气瓶：余量(扣除残压保护) 必须 ≥ 其它任务占用 + 本任务需求
    _checkGas(state, task) {
      const shortages = [];
      for (const a of task.assignments) {
        const c = state.cylinders.find(x => x.id === a.cylinderId);
        const free = cylinderFreeLiters(c);
        const reservedByOthers = this._cylinderReserved(state, c.id, task.id);
        const need = Number(a.plannedLiters || 0);
        if (reservedByOthers + need > free) {
          const diver = state.divers.find(d => d.id === a.diverId);
          shortages.push({
            cylinder: c.code, diver: diver ? diver.name : a.diverId,
            need, reservedByOthers, free, deficit: reservedByOthers + need - free,
          });
        }
      }
      return shortages.length ? { ok: false, shortages } : { ok: true };
    }

    // 天气：潜次区间必须完全落在该遗址“良好”窗口并集内，且不与任何“恶劣”窗口相交
    _checkWeather(state, task) {
      const siteWindows = state.windows.filter(w => w.siteId === task.siteId);
      const bad = siteWindows.filter(w => w.state === "bad" && overlap(task.start, task.end, w.from, w.to));
      if (bad.length) return { ok: false, reason: "bad-window", bad: bad.map(w => ({ id: w.id, from: w.from, to: w.to, note: w.note })) };
      const goods = siteWindows.filter(w => w.state === "good").map(w => [w.from, w.to]).sort((x, y) => x[0] - y[0]);
      let cursor = task.start;
      for (const [from, to] of goods) {
        if (from <= cursor && cursor < to) cursor = Math.max(cursor, to);
        if (cursor >= task.end) break;
      }
      if (cursor < task.end) return { ok: false, reason: "no-coverage", gapFrom: cursor, to: task.end };
      return { ok: true };
    }

    validateTask(state, task) {
      const people = this._checkPeopleConflicts(state, task);
      if (!people.ok) throw new ValidationError("PERSON_CONFLICT", "存在人员时间冲突", people.conflicts);
      const cyl = this._checkCylinderConflicts(state, task);
      if (!cyl.ok) throw new ValidationError("CYLINDER_CONFLICT", "存在气瓶同时段冲突", cyl.conflicts);
      const gas = this._checkGas(state, task);
      if (!gas.ok) throw new ValidationError("GAS_SHORTFALL", "气瓶余量不足", gas.shortages);
      const weather = this._checkWeather(state, task);
      if (!weather.ok) throw new ValidationError("WEATHER_BLOCK", "天气窗口不允许该安排", weather);
      return true;
    }

    /* 基础数据变更后的安全复核（在事务草稿内、写盘前调用）。
       任一排定任务因变更失去保障即抛错 → commit 整体丢弃，内存与磁盘都不留下部分修改。 */

    // 气瓶改写（容积/残压/压力）后：全部活动任务都必须仍满足气量；
    // 待复核任务同样占用气量（保守口径，沿用 _cylinderReserved 的统计范围）。
    _revalidateGasForActiveTasks(state, context) {
      for (const task of state.tasks.filter(t => ACTIVE_STATUSES.includes(t.status))) {
        const gas = this._checkGas(state, task);
        if (!gas.ok) {
          throw new ValidationError(
            "GAS_SHORTFALL",
            `该变更会使 ${task.code} 气量不足，请先补气或调整该潜次`,
            { context: context || null, task: task.code, shortages: gas.shortages }
          );
        }
      }
    }

    // 天气窗口“改写”（更新已有窗口）后：已批准/执行中的任务不得失去良好覆盖或与恶劣窗口重叠。
    // 注意：新建恶劣窗口不算“改写”，允许先登记坏天气再拦截后续批准（见 approveTask 的复核）。
    _revalidateWeatherForCommittedTasks(state, context) {
      for (const task of state.tasks.filter(t => COMMITTED_STATUSES.includes(t.status))) {
        const weather = this._checkWeather(state, task);
        if (!weather.ok) {
          throw new ValidationError(
            "WEATHER_BLOCK",
            `天气窗口变更会使已排定潜次 ${task.code} 失去良好天气覆盖，不能这样保存；请先驳回/调整该潜次`,
            { context: context || null, task: task.code, ...weather }
          );
        }
      }
    }

    /* 创建潜次（排班提交）。clientKey 为前端去重键：
       同一 key 重复提交直接返回首次任务，不再校验、不写审计、不落盘（幂等）。 */
    createTask(input, actor, clientKey) {
      actor = this._requireActor(actor);
      if (clientKey && this.state.idempotency[clientKey]) {
        return { task: this.get("tasks", this.state.idempotency[clientKey]), duplicated: true };
      }
      let id;
      this.commit(state => {
        const data = this._normalizeTaskInput(state, input);
        if (state.tasks.some(t => t.code === data.code))
          throw new ValidationError("DUPLICATE_CODE", "潜次编号已存在: " + data.code);
        const saved = {
          id: this._uuid(),
          ...data,
          status: "pending_review",
          createdBy: actor,
          createdAt: this._now(),
          updatedAt: this._now(),
        };
        // 关键：先入列再用统一规则校验，确保占用口径一致
        state.tasks.push(saved);
        this.validateTask(state, saved); // 不通过 -> commit 抛错 -> push 随 draft 一起丢弃
        if (clientKey) state.idempotency[clientKey] = saved.id;
        id = saved.id;
        return { actor, action: "create", entity: "tasks", entityId: id, before: null, after: this._snapshot(saved) };
      });
      return { task: this.get("tasks", id), duplicated: false };
    }

    // 编辑仅限待复核；批准/执行/关闭后的改动必须走状态机
    updateTask(id, input, actor) {
      actor = this._requireActor(actor);
      this.commit(state => {
        const existing = this._find(state, "tasks", id);
        if (existing.status !== "pending_review")
          throw new ValidationError("ILLEGAL_TRANSITION", "仅待复核潜次可编辑，当前状态：" + STATUS_LABELS[existing.status]);
        if (state.tasks.some(t => t.code === String(input.code || "").trim() && t.id !== id))
          throw new ValidationError("DUPLICATE_CODE", "潜次编号已存在: " + input.code);
        const before = this._snapshot(existing);
        const data = this._normalizeTaskInput(state, { ...existing, ...input });
        Object.assign(existing, data, { updatedAt: this._now() });
        this.validateTask(state, existing);
        return { actor, action: "update", entity: "tasks", entityId: id, before, after: this._snapshot(existing) };
      });
      return this.get("tasks", id);
    }

    deleteTask(id, actor) {
      actor = this._requireActor(actor);
      this.commit(state => {
        const t = this._find(state, "tasks", id);
        if (!["pending_review", "rejected"].includes(t.status))
          throw new ValidationError("ILLEGAL_TRANSITION", "仅待复核或已驳回潜次可删除，当前状态：" + STATUS_LABELS[t.status]);
        const before = this._snapshot(t);
        state.tasks = state.tasks.filter(x => x.id !== id);
        return { actor, action: "delete", entity: "tasks", entityId: id, before, after: null };
      });
      return true;
    }

    _transition(id, action, actor, extra) {
      actor = this._requireActor(actor);
      extra = extra || {};
      this.commit(state => {
        const task = this._find(state, "tasks", id);
        const before = this._snapshot(task);
        if (!TRANSITIONS[action].includes(task.status))
          throw new ValidationError("ILLEGAL_TRANSITION", "不允许的状态变更：" + STATUS_LABELS[task.status] + " → " + action, { from: task.status, action });
        if (action === "reject" && !String(extra.reason || "").trim())
          throw new ValidationError("FIELD_REQUIRED", "驳回必须填写原因", { field: "reason" });

        if (action === "approve") {
          this.validateTask(state, task); // 数据可能已变，批准前复核硬规则
          task.status = "approved"; task.approvedBy = actor; task.approvedAt = this._now();
        } else if (action === "reject") {
          task.status = "rejected"; task.rejectedBy = actor; task.rejectedAt = this._now();
          task.rejectReason = String(extra.reason).trim();
        } else if (action === "start") {
          this.validateTask(state, task);
          task.status = "executing"; task.startedBy = actor; task.actualStart = this._now();
        } else if (action === "close") {
          const outcome = extra.outcome === "abnormal" ? "abnormal" : "normal";
          const actualMin = Number(extra.actualMin);
          if (!(actualMin > 0)) throw new ValidationError("FIELD_REQUIRED", "关闭需填写实际水下分钟数", { field: "actualMin" });
          if (outcome === "abnormal" && !String(extra.reason || "").trim())
            throw new ValidationError("FIELD_REQUIRED", "异常关闭必须填写情况说明", { field: "reason" });
          // 按实际耗气扣减各人气瓶气量；扣到残压保护以下（含其它任务占用）则拒绝关闭，先补气再关闭
          for (const a of task.assignments) {
            const c = state.cylinders.find(x => x.id === a.cylinderId);
            const diver = state.divers.find(d => d.id === a.diverId);
            const used = gasActual(task.depthM, actualMin, diver ? diver.sac : DEFAULT_SAC);
            const free = cylinderFreeLiters(c);
            const reservedByOthers = this._cylinderReserved(state, c.id, task.id);
            if (reservedByOthers + used > free) {
              throw new ValidationError("GAS_SHORTFALL", "实际耗气超出气瓶余量，请先登记补气再关闭", {
                cylinder: c.code, used, reservedByOthers, free, deficit: reservedByOthers + used - free,
              });
            }
            a.actualLiters = used;
            c.pressureBar = Math.round((c.pressureBar - used / c.volumeL) * 10) / 10;
          }
          task.status = "closed";
          task.closedBy = actor; task.closedAt = this._now();
          task.outcome = outcome; task.actualMin = actualMin;
          if (outcome === "abnormal") task.abnormalReason = String(extra.reason).trim();
          if (extra.note) task.closeNote = String(extra.note).trim();
        }
        task.updatedAt = this._now();
        return { actor, action, entity: "tasks", entityId: id, before, after: this._snapshot(task), note: String(extra.reason || "").trim() };
      });
      return this.get("tasks", id);
    }

    approveTask(id, actor) { return this._transition(id, "approve", actor); }
    rejectTask(id, reason, actor) { return this._transition(id, "reject", actor, { reason }); }
    startTask(id, actor) { return this._transition(id, "start", actor); }
    closeTask(id, payload, actor) { return this._transition(id, "close", actor, payload || {}); }

    /* ============ 标记（沿用原单页功能，同样纳入审计与事务） ============ */
    _normalizeMark(input) {
      const data = {
        code: String(input.code || "").trim(),
        type: ["ceramic", "wood", "metal", "unknown"].includes(input.type) ? input.type : "unknown",
        dive: String(input.dive || "").trim(),
        depth: String(input.depth || "").trim(),
        orientation: String(input.orientation || "").trim(),
        condition: String(input.condition || "").trim(),
        note: String(input.note || "").trim(),
        x: Number(input.x), y: Number(input.y),
      };
      if (!data.code) throw new ValidationError("FIELD_REQUIRED", "标记编号必填", { field: "code" });
      if (!data.dive) throw new ValidationError("FIELD_REQUIRED", "潜次必填", { field: "dive" });
      if (!(data.x >= 0 && data.x <= 100 && data.y >= 0 && data.y <= 100))
        throw new ValidationError("FIELD_INVALID", "标记坐标需在 0–100 之间");
      return data;
    }
    upsertMark(input, actor) {
      actor = this._requireActor(actor);
      let id;
      this.commit(state => {
        const data = this._normalizeMark(input);
        if (state.marks.some(m => m.code === data.code && m.id !== input.id))
          throw new ValidationError("DUPLICATE_CODE", "标记编号已存在: " + data.code);
        let saved;
        if (input.id) {
          saved = this._find(state, "marks", input.id);
          const before = this._snapshot(saved);
          Object.assign(saved, data);
          id = saved.id;
          return { actor, action: "update", entity: "marks", entityId: id, before, after: this._snapshot(saved) };
        }
        saved = { id: this._uuid(), ...data };
        state.marks.push(saved);
        id = saved.id;
        return { actor, action: "create", entity: "marks", entityId: id, before: null, after: this._snapshot(saved) };
      });
      return this.get("marks", id);
    }
    deleteMark(id, actor) { return this.deleteRecord("marks", id, actor); }

    static DB_KEY = DB_KEY;
    static LEGACY_MARKS_KEY = LEGACY_MARKS_KEY;
    static TASK_STATUSES = TASK_STATUSES;
    static STATUS_LABELS = STATUS_LABELS;
    static ACTIVE_STATUSES = ACTIVE_STATUSES;
    static COMMITTED_STATUSES = COMMITTED_STATUSES;
    static gasRequired = gasRequired;
    static gasActual = gasActual;
    static cylinderFreeLiters = cylinderFreeLiters;
    static overlap = overlap;
    static ValidationError = ValidationError;
  }

  return Store;
});
