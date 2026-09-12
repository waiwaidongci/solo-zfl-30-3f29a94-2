"use strict";
/* 数据层自动化测试：node --test（零第三方依赖）。
   运行：npm test  或  node --test */
const test = require("node:test");
const assert = require("node:assert/strict");
const Store = require("../js/store.js");
const { ValidationError } = Store;

// ---- 测试夹具：内存版 localStorage + 固定时钟，便于断言 ----
class MemStorage {
  constructor(failAt = -1) { this.map = new Map(); this.writes = 0; this.failAt = failAt; }
  getItem(k) { return this.map.has(k) ? this.map.get(k) : null; }
  setItem(k, v) { this.writes++; if (this.writes === this.failAt) throw new Error("QuotaExceeded(模拟)"); this.map.set(k, String(v)); }
  removeItem(k) { this.map.delete(k); }
}

const T0 = new Date("2026-09-12T08:00:00").getTime();
let clock = T0;
const now = () => clock;
function makeStore(storage) {
  clock = T0;
  return new Store({ storage: storage === undefined ? new MemStorage() : storage, now, uuid: (() => {
    let n = 0; return () => "uid-" + (++n);
  })() });
}
const H = 3600000, MIN = 60000;
const errCode = fn => { try { fn(); return null; } catch (e) { return e instanceof ValidationError ? e.code : "OTHER:" + e.message; } };

// 明天 09:00–10:00 的标准任务（落在种子良好窗口 08:00–18:00 内）
function basePayload(over) {
  const s = seed();
  return Object.assign({
    code: "DIVE-100", siteId: "site-1",
    start: s.dayStart + H, end: s.dayStart + 2 * H,
    depthM: 18, plannedMin: 30,
    assignments: [{ diverId: "div-2", cylinderId: "cyl-2" }],
  }, over || {});
}
function seed() {
  const dayStart = (Math.floor(T0 / 86400000) + 1) * 86400000 + 8 * H;
  return { dayStart };
}

/* ================= 1. 种子与加载 ================= */
test("种子数据包含遗址/人员/气瓶/窗口/示例任务与两条旧版标记", () => {
  const s = makeStore();
  assert.equal(s.list("sites").length, 1);
  assert.equal(s.list("divers").length, 3);
  assert.equal(s.list("cylinders").length, 3);
  assert.equal(s.list("windows").length, 1);
  assert.equal(s.list("tasks").length, 1);
  assert.equal(s.list("marks").length, 2);
  assert.equal(s.list("tasks")[0].status, "pending_review");
});

test("旧版 zfl30Marks 数据迁移到新库 marks", () => {
  const mem = new MemStorage();
  mem.setItem(Store.LEGACY_MARKS_KEY, JSON.stringify([
    { id: "x1", code: "OLD-1", type: "metal", dive: "DIVE-09", x: 10, y: 20, depth: "12m" },
  ]));
  const s = new Store({ storage: mem, now, uuid: () => "u" });
  assert.equal(s.list("marks").length, 1);
  assert.equal(s.list("marks")[0].code, "OLD-1");
  // 新库已落盘，旧键是否保留不影响；重新加载不应重复迁移
  const s2 = new Store({ storage: mem, now, uuid: () => "u" });
  assert.equal(s2.list("marks").length, 1);
});

test("落盘 JSON 损坏时回退到种子而不是抛错", () => {
  const mem = new MemStorage();
  mem.setItem(Store.DB_KEY, "{not-json");
  const s = new Store({ storage: mem, now, uuid: () => "u" });
  assert.ok(s.list("sites").length >= 1);
});

/* ================= 2. 排班硬规则 ================= */
test("合法排班成功进入待复核", () => {
  const s = makeStore();
  const r = s.createTask(basePayload(), "调度员", "k1");
  assert.equal(r.duplicated, false);
  assert.equal(r.task.status, "pending_review");
  assert.equal(r.task.createdBy, "调度员");
});

test("缺操作者的任何写操作一律拒绝", () => {
  const s = makeStore();
  assert.equal(errCode(() => s.createTask(basePayload(), "")), "MISSING_OPERATOR");
  assert.equal(errCode(() => s.createTask(basePayload(), "   ")), "MISSING_OPERATOR");
  assert.equal(errCode(() => s.approveTask(s.list("tasks")[0].id, "")), "MISSING_OPERATOR");
});

test("同人时间冲突被拦住（与已批准任务重叠）", () => {
  const s = makeStore();
  const t0 = s.list("tasks")[0]; // 陈潜/div-1，明天09:00–10:00
  s.approveTask(t0.id, "复核员");
  const p = basePayload({
    code: "DIVE-101",
    start: t0.start + 30 * MIN, end: t0.end + 30 * MIN,
    assignments: [{ diverId: "div-1", cylinderId: "cyl-2" }],
  });
  const code = errCode(() => s.createTask(p, "调度员"));
  assert.equal(code, "PERSON_CONFLICT");
  assert.equal(s.list("tasks").length, 1, "被拦后不得留下任务");
});

test("同一气瓶同时段分给两个潜次被拦住", () => {
  const s = makeStore();
  const p = basePayload(); // div-2 / cyl-2
  s.createTask(p, "调度员", "k1");
  const p2 = basePayload({
    code: "DIVE-101",
    assignments: [{ diverId: "div-3", cylinderId: "cyl-2" }],
  });
  assert.equal(errCode(() => s.createTask(p2, "调度员", "k2")), "CYLINDER_CONFLICT");
});

test("不重叠时段允许同一人（需换瓶）；同一瓶在补气前不重复安排", () => {
  const s = makeStore();
  const { dayStart } = seed();
  // 首尾相接不算重叠：陈潜换 cyl-2 可再排
  s.createTask(basePayload({ code: "DIVE-101", start: dayStart + 2 * H, end: dayStart + 3 * H,
    assignments: [{ diverId: "div-1", cylinderId: "cyl-2" }] }), "调度员", "k2");
  assert.equal(s.list("tasks").length, 2);
  // 同一瓶不补气、即使时段不重叠，累计气量超余量仍被拦（保守口径：关闭扣瓶前视为已占用）
  assert.equal(errCode(() => s.createTask(basePayload({ code: "DIVE-102", start: dayStart + 3 * H, end: dayStart + 4 * H,
    assignments: [{ diverId: "div-2", cylinderId: "cyl-2" }] }), "调度员", "k3")), "GAS_SHORTFALL");
});

test("已关闭/已驳回潜次不再占用人员与气瓶（关闭扣瓶后需补气再排）", () => {
  const s = makeStore();
  const t0 = s.list("tasks")[0];
  s.approveTask(t0.id, "复核员");
  s.startTask(t0.id, "现场指挥");
  s.closeTask(t0.id, { actualMin: 25, outcome: "normal" }, "现场指挥");
  // 关闭后该瓶压力已按实耗扣减，先登记补气
  const c = s.get("cylinders", "cyl-1");
  s.upsertCylinder({ ...c, pressureBar: 220 }, "器材员");
  // 同人同时段再排，不再有人员冲突
  const p = basePayload({ assignments: [{ diverId: "div-1", cylinderId: "cyl-1" }] });
  assert.equal(s.createTask(p, "调度员", "k2").duplicated, false);
});

test("气量不足被拦住：高压要求超出气瓶可用气量", () => {
  const s = makeStore();
  // cyl-3：12L × (180-50) = 1560L 可用；div-3 SAC22，30m/40min 需求远超
  const p = basePayload({
    code: "DIVE-200", depthM: 30, plannedMin: 40,
    assignments: [{ diverId: "div-3", cylinderId: "cyl-3" }],
  });
  const code = errCode(() => s.createTask(p, "调度员", "kx"));
  assert.equal(code, "GAS_SHORTFALL");
});

test("两个任务对同一气瓶的累计计划气量超余量时第二个被拦", () => {
  const s = makeStore();
  const { dayStart } = seed();
  // cyl-2 可用 12×(220-50)=2040L。先排一个 15 分钟任务：需求 SAC20×15×2.8×1.2=1008L
  s.createTask(basePayload({ code: "A1", start: dayStart + 4 * H, end: dayStart + 5 * H, depthM: 18, plannedMin: 15,
    assignments: [{ diverId: "div-2", cylinderId: "cyl-2" }] }), "调度员", "g1");
  // 再排不重叠的 30 分钟任务：累计 1008+2016=3024 > 2040，应被拦
  const p2 = basePayload({ code: "A2", depthM: 18, plannedMin: 30,
    start: dayStart + 6 * H, end: dayStart + 7 * H,
    assignments: [{ diverId: "div-3", cylinderId: "cyl-2" }] });
  assert.equal(errCode(() => s.createTask(p2, "调度员", "g2")), "GAS_SHORTFALL");
  assert.equal(s.list("tasks").filter(t => t.code === "A2").length, 0);
});

test("恶劣天气窗口覆盖时段被拦；良好窗口覆盖不足被拦", () => {
  const s = makeStore();
  const { dayStart } = seed();
  const win = s.list("windows")[0];
  // 在良好窗口内插入恶劣窗口
  s.upsertWindow({ siteId: "site-1", from: dayStart + 90 * MIN, to: dayStart + 2 * H, state: "bad", note: "雷暴" }, "气象员");
  const p = basePayload({ code: "DIVE-W1", start: dayStart + H, end: dayStart + 2 * H });
  assert.equal(errCode(() => s.createTask(p, "调度员", "w1")), "WEATHER_BLOCK");
  // 任务超出良好窗口结束（18:00）
  const p2 = basePayload({ code: "DIVE-W2", start: dayStart + 9 * H, end: dayStart + 11 * H });
  assert.equal(errCode(() => s.createTask(p2, "调度员", "w2")), "WEATHER_BLOCK");
});

test("天气只影响对应遗址", () => {
  const s = makeStore();
  const { dayStart } = seed();
  s.upsertSite({ code: "SITE-02", name: "二号点", depthM: 10 }, "调度员");
  // 二号点无任何窗口 → 应拦
  const p = basePayload({ code: "DIVE-OT", siteId: s.list("sites")[1].id, start: dayStart + H, end: dayStart + 2 * H,
    assignments: [{ diverId: "div-2", cylinderId: "cyl-2" }] });
  assert.equal(errCode(() => s.createTask(p, "调度员", "ot")), "WEATHER_BLOCK");
});

test("字段缺失/时间倒置/同潜次重复人员被拦", () => {
  const s = makeStore();
  assert.equal(errCode(() => s.createTask(basePayload({ code: "" }), "调度员", "f1")), "FIELD_REQUIRED");
  assert.equal(errCode(() => s.createTask(basePayload({ end: basePayload().start - 1 }), "调度员", "f2")), "FIELD_INVALID");
  assert.equal(errCode(() => s.createTask(basePayload({ assignments: [] }), "调度员", "f3")), "FIELD_REQUIRED");
  assert.equal(errCode(() => s.createTask(basePayload({
    assignments: [{ diverId: "div-2", cylinderId: "cyl-2" }, { diverId: "div-2", cylinderId: "cyl-3" }],
  }), "调度员", "f4")), "DUPLICATE_DIVER");
  assert.equal(errCode(() => s.createTask(basePayload({
    assignments: [{ diverId: "div-2", cylinderId: "cyl-2" }, { diverId: "div-3", cylinderId: "cyl-2" }],
  }), "调度员", "f5")), "DUPLICATE_CYLINDER");
});

test("潜次编号重复被拦（含与历史编号撞号）", () => {
  const s = makeStore();
  assert.equal(errCode(() => s.createTask(basePayload({ code: "DIVE-001" }), "调度员", "dup")), "DUPLICATE_CODE");
});

/* ================= 3. 状态机：流转与越级 ================= */
test("完整合法流转：待复核→批准→执行→关闭，并按实际耗气扣瓶", () => {
  const s = makeStore();
  const t = s.list("tasks")[0];
  const cylBefore = s.get("cylinders", "cyl-1").pressureBar;
  s.approveTask(t.id, "复核员");
  s.startTask(t.id, "现场指挥");
  const closed = s.closeTask(t.id, { actualMin: 25, outcome: "normal" }, "现场指挥");
  assert.equal(closed.status, "closed");
  assert.equal(closed.outcome, "normal");
  const cylAfter = s.get("cylinders", "cyl-1");
  // 实耗 = 18 × 25 × 2.8 = 1260L → 105bar，210 → 105
  assert.equal(cylAfter.pressureBar, Math.round((cylBefore - 1260 / 12) * 10) / 10);
  assert.ok(cylAfter.pressureBar > 50);
});

test("越级变更全部被拦", () => {
  const s = makeStore();
  const id = s.list("tasks")[0].id;
  assert.equal(errCode(() => s.startTask(id, "x")), "ILLEGAL_TRANSITION");       // 待复核→执行
  assert.equal(errCode(() => s.closeTask(id, { actualMin: 20 }, "x")), "ILLEGAL_TRANSITION"); // 待复核→关闭
  s.approveTask(id, "复核员");
  assert.equal(errCode(() => s.approveTask(id, "x")), "ILLEGAL_TRANSITION");    // 重复批准
  s.rejectTask(id, "天气转差", "复核员");
  assert.equal(errCode(() => s.startTask(id, "x")), "ILLEGAL_TRANSITION");      // 驳回→执行
});

test("驳回必须有原因；异常关闭必须有说明", () => {
  const s = makeStore();
  const id = s.list("tasks")[0].id;
  assert.equal(errCode(() => s.rejectTask(id, "  ", "复核员")), "FIELD_REQUIRED");
  s.approveTask(id, "复核员");
  s.startTask(id, "现场指挥");
  assert.equal(errCode(() => s.closeTask(id, { actualMin: 20, outcome: "abnormal", reason: "" }, "x")), "FIELD_REQUIRED");
  const c = s.closeTask(id, { actualMin: 20, outcome: "abnormal", reason: "潜水员轻度缠绕，按预案出水" }, "现场指挥");
  assert.equal(c.outcome, "abnormal");
});

test("批准时再次校验硬规则：批准前登记恶劣窗口则批准被拦", () => {
  const s = makeStore();
  const t = s.list("tasks")[0];
  const { dayStart } = seed();
  // t: 09:00–10:00
  s.upsertWindow({ siteId: "site-1", from: t.start, to: t.end, state: "bad", note: "突风" }, "气象员");
  assert.equal(errCode(() => s.approveTask(t.id, "复核员")), "WEATHER_BLOCK");
  assert.equal(s.get("tasks", t.id).status, "pending_review");
});

test("仅待复核潜次可编辑；已批准编辑被拦", () => {
  const s = makeStore();
  const t = s.list("tasks")[0];
  s.updateTask(t.id, { ...t, plannedMin: 20, note: "改短" }, "调度员");
  assert.equal(s.get("tasks", t.id).plannedMin, 20);
  s.approveTask(t.id, "复核员");
  assert.equal(errCode(() => s.updateTask(t.id, { ...t, plannedMin: 10 }, "调度员")), "ILLEGAL_TRANSITION");
});

test("编辑后产生人员冲突被拦且数据不变", () => {
  const s = makeStore();
  const { dayStart } = seed();
  const second = s.createTask(basePayload({ code: "DIVE-101", start: dayStart + 2 * H, end: dayStart + 3 * H }), "调度员", "k2").task;
  const t0 = s.list("tasks")[0];
  // 把示例任务（div-1）改到与 second（div-2）无关——改用 div-2 同时间制造冲突
  const code = errCode(() => s.updateTask(t0.id, {
    ...t0, start: second.start + 5 * MIN, end: second.end,
    assignments: [{ diverId: "div-2", cylinderId: "cyl-1" }],
  }, "调度员"));
  assert.equal(code, "PERSON_CONFLICT");
  assert.equal(s.get("tasks", t0.id).assignments[0].diverId, "div-1", "原数据保持不变");
});

test("删除限制：只有待复核/已驳回可删", () => {
  const s = makeStore();
  const id = s.list("tasks")[0].id;
  s.deleteTask(id, "调度员");
  assert.equal(s.list("tasks").length, 0);
  const t2 = s.createTask(basePayload(), "调度员", "k9").task;
  s.approveTask(t2.id, "复核员");
  assert.equal(errCode(() => s.deleteTask(t2.id, "调度员")), "ILLEGAL_TRANSITION");
});

/* ================= 4. 重复提交幂等 ================= */
test("同一 clientKey 重复提交只产生一条任务且不重复落审计", () => {
  const storage = new MemStorage();
  const s = makeStore(storage);
  const beforeAudits = s.audits().length;
  const r1 = s.createTask(basePayload(), "调度员", "same-key");
  const r2 = s.createTask(basePayload(), "调度员", "same-key");
  const r3 = s.createTask(basePayload(), "调度员", "same-key");
  assert.equal(r1.task.id, r2.task.id);
  assert.equal(r2.duplicated, true);
  assert.equal(r3.duplicated, true);
  assert.equal(s.list("tasks").length, 2); // 种子1 + 1
  assert.equal(s.audits().length, beforeAudits + 1, "只有首次写审计");
});

test("不同 clientKey 同内容撞编号，第二次被业务规则拒绝", () => {
  const s = makeStore();
  s.createTask(basePayload(), "调度员", "key-a");
  assert.equal(errCode(() => s.createTask(basePayload(), "调度员", "key-b")), "DUPLICATE_CODE");
});

/* ================= 5. 审计日志 ================= */
test("每次修改记录操作者、时间、动作和前后状态", () => {
  const s = makeStore();
  clock = T0 + 1000;
  const t = s.list("tasks")[0];
  s.approveTask(t.id, "复核员张三");
  const a = s.audits()[0];
  assert.equal(a.actor, "复核员张三");
  assert.equal(a.ts, T0 + 1000);
  assert.equal(a.action, "approve");
  assert.equal(a.entity, "tasks");
  assert.equal(a.before.status, "pending_review");
  assert.equal(a.after.status, "approved");
  assert.ok(a.before.approvedAt === undefined);
  assert.ok(a.after.approvedAt);
});

test("基础数据与标记变更也全部入审计，删除留 before 快照", () => {
  const s = makeStore();
  const site = s.upsertSite({ code: "S-9", name: "临时点", depthM: 8 }, "调度员");
  s.upsertSite({ id: site.id, code: "S-9", name: "临时点改名", depthM: 9 }, "调度员");
  s.deleteRecord("sites", site.id, "调度员");
  const acts = s.audits().slice(0, 3).map(a => a.action);
  assert.deepEqual(acts, ["delete", "update", "create"]);
  assert.equal(s.audits()[0].before.code, "S-9");
  assert.equal(s.audits()[0].after, null);

  const m = s.upsertMark({ code: "M-900", type: "metal", dive: "DIVE-X", x: 1, y: 2, depth: "9m" }, "绘图员");
  assert.equal(s.audits()[0].entity, "marks");
  s.deleteMark(m.id, "绘图员");
  assert.equal(s.audits()[0].action, "delete");
});

/* ================= 6. 事务原子性 ================= */
test("业务校验失败不写盘：storage 写入次数不增加且重载数据不变", () => {
  const mem = new MemStorage();
  const s = makeStore(mem);
  const writesBefore = mem.writes;
  const stateBefore = JSON.stringify(s.state);
  assert.equal(errCode(() => s.createTask(basePayload({ code: "" }), "调度员", "x")), "FIELD_REQUIRED");
  assert.equal(errCode(() => s.createTask(basePayload({ depthM: 40, plannedMin: 60, assignments: [{ diverId: "div-3", cylinderId: "cyl-3" }] }), "调度员", "y")), "GAS_SHORTFALL");
  assert.equal(mem.writes, writesBefore, "失败路径不允许 setItem");
  assert.equal(JSON.stringify(s.state), stateBefore, "内存状态不变");
  const reloaded = new Store({ storage: mem, now, uuid: () => "u" });
  assert.equal(reloaded.list("tasks").length, 1);
});

test("setItem 抛错时内存数据回滚（不留下部分数据）", () => {
  const mem = new MemStorage(1); // 第一次写就失败
  const s = new Store({ storage: mem, now, uuid: () => "u" });
  assert.throws(() => s.upsertSite({ code: "X", name: "不应存在", depthM: 5 }, "调度员"));
  assert.equal(s.list("sites").some(x => x.code === "X"), false);
});

/* ================= 7. 基础数据约束与联动 ================= */
test("气瓶残压保护与占用联动：下调压力击穿占用时被拦", () => {
  const s = makeStore();
  // 种子任务占用 cyl-1 计划 1815L（18m/30min SAC18）。可用=12×170=2040L
  // 把表压从 220 降到 200 → 可用 1800 < 1815，应拦
  const c = s.get("cylinders", "cyl-1");
  assert.equal(errCode(() => s.upsertCylinder({ ...c, pressureBar: 200 }, "器材员")), "GAS_SHORTFALL");
});

test("关闭时实际耗气超出余量（含其它任务占用）则拒绝关闭，需先补气", () => {
  const s = makeStore();
  const { dayStart } = seed();
  // 两个执行链各占一瓶：先制造一个 approved 任务占用 cyl-2 大量气量
  const t0 = s.list("tasks")[0];
  s.approveTask(t0.id, "复核员");
  s.startTask(t0.id, "现场指挥");
  // 尝试用 90 分钟关闭：实耗 18×90×2.8=4536L，cyl-1 可用仅 1920L
  assert.equal(errCode(() => s.closeTask(t0.id, { actualMin: 90, outcome: "normal" }, "现场指挥")), "GAS_SHORTFALL");
  assert.equal(s.get("tasks", t0.id).status, "executing", "气量不足不得关闭");
  // 补气后关闭成功
  const c = s.get("cylinders", "cyl-1");
  s.upsertCylinder({ ...c, pressureBar: 250 }, "器材员");
  s.closeTask(t0.id, { actualMin: 30, outcome: "normal" }, "现场指挥");
  assert.equal(s.get("tasks", t0.id).status, "closed");
});

test("被活动潜次引用的人员/气瓶不能删除", () => {
  const s = makeStore();
  assert.equal(errCode(() => s.deleteRecord("divers", "div-1", "调度员")), "IN_USE");
  assert.equal(errCode(() => s.deleteRecord("cylinders", "cyl-1", "调度员")), "IN_USE");
  assert.equal(errCode(() => s.deleteRecord("sites", "site-1", "调度员")), "IN_USE");
});

test("删除唯一良好天气窗口会使任务失去覆盖时被拦", () => {
  const s = makeStore();
  const win = s.list("windows")[0];
  assert.equal(errCode(() => s.deleteRecord("windows", win.id, "气象员")), "WEATHER_BLOCK");
});

test("关闭后气瓶压力扣减持久化并影响后续排班", () => {
  const s = makeStore();
  const t = s.list("tasks")[0];
  s.approveTask(t.id, "r"); s.startTask(t.id, "r");
  s.closeTask(t.id, { actualMin: 30, outcome: "normal" }, "r");
  const c = s.get("cylinders", "cyl-1");
  // 220 − 1512/12 = 94bar
  assert.equal(c.pressureBar, 94);
  // 重新加载后数据仍在
  const s2 = new Store({ storage: s.storage === null ? null : (s.storage || null), now, uuid: () => "u" });
  assert.equal(s2.get("cylinders", "cyl-1").pressureBar, 94);
});

/* ================= 8. 标记沿用功能 ================= */
test("标记编号唯一、坐标校验、增删改可用", () => {
  const s = makeStore();
  const m = s.upsertMark({ code: "M-100", type: "ceramic", dive: "DIVE-1", x: 50, y: 50, depth: "10m" }, "绘图员");
  assert.equal(m.code, "M-100");
  assert.equal(errCode(() => s.upsertMark({ code: "M-100", type: "wood", dive: "DIVE-1", x: 1, y: 1, depth: "10m" }, "绘图员")), "DUPLICATE_CODE");
  assert.equal(errCode(() => s.upsertMark({ code: "M-101", type: "wood", dive: "DIVE-1", x: 120, y: 1, depth: "10m" }, "绘图员")), "FIELD_INVALID");
  s.upsertMark({ id: m.id, code: "M-100", type: "metal", dive: "DIVE-2", x: 51, y: 51, depth: "11m" }, "绘图员");
  assert.equal(s.get("marks", m.id).type, "metal");
  const n0 = s.list("marks").length;
  s.deleteMark(m.id, "绘图员");
  assert.equal(s.list("marks").length, n0 - 1);
});

test("纯 memory（无 storage）模式同样工作，便于嵌入环境", () => {
  const s = new Store({ storage: null, now, uuid: () => "u" });
  const r = s.createTask(basePayload(), "调度员", "m1");
  assert.equal(r.task.status, "pending_review");
});
