/* 真实浏览器端到端验证（Playwright + Chromium）。
   自动启动零依赖静态服务器，覆盖桌面与手机视口、离线重载、file:// 直开。
   运行：node test/e2e/verify.js
   截图输出到 test/e2e/shots/ */
const { chromium } = require("playwright");
const http = require("http");
const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");

const ROOT = path.join(__dirname, "..", "..");
const SHOTS = path.join(__dirname, "shots");
fs.mkdirSync(SHOTS, { recursive: true });

let passed = 0;
const failures = [];
async function check(name, fn) {
  try { await fn(); passed++; console.log("  ✓ " + name); }
  catch (e) { failures.push([name, e]); console.log("  ✗ " + name + " — " + e.message); }
}
function assert(cond, msg) { if (!cond) throw new Error(msg); }

async function freePort() {
  return new Promise((resolve, reject) => {
    const srv = http.createServer();
    srv.listen(0, "127.0.0.1", () => { const p = srv.address().port; srv.close(() => resolve(p)); });
    srv.on("error", reject);
  });
}
async function startServer(port) {
  return new Promise((resolve, reject) => {
    const srv = spawn(process.execPath, [path.join(ROOT, "tools", "serve.js"), String(port)], { cwd: ROOT });
    let settled = false;
    srv.stdout.on("data", d => { if (String(d).includes("http://") && !settled) { settled = true; resolve(srv); } });
    srv.stderr.on("data", d => {
      const msg = String(d);
      if (msg.includes("EADDRINUSE") && !settled) { settled = true; reject(new Error("port in use")); }
      process.stderr.write(d);
    });
    srv.on("exit", code => { if (!settled) { settled = true; reject(new Error("server exited " + code)); } });
  });
}

async function freshContext(browser, opts) {
  const ctx = await browser.newContext(Object.assign({
    viewport: { width: 1366, height: 900 }, locale: "zh-CN",
  }, opts || {}));
  // 每个上下文使用全新的 localStorage
  const page = await ctx.newPage();
  const consoleErrors = [];
  page.on("console", m => { if (m.type() === "error") consoleErrors.push(m.text()); });
  page.__consoleErrors = consoleErrors;
  return { ctx, page };
}

async function setOperator(page, name) {
  await page.fill("#operator", name);
  await page.dispatchEvent("#operator", "change");
}
async function toastText(page) {
  await page.waitForSelector("#toast:not([hidden])");
  return page.textContent("#toast");
}
async function shot(page, name) { await page.screenshot({ path: path.join(SHOTS, name), fullPage: true }); }

(async () => {
  const port = await freePort();
  const srv = await startServer(port);
  const browser = await chromium.launch();
  const BASE = `http://127.0.0.1:${port}/index.html`;

  /* ---------------- 桌面端 ---------------- */
  console.log("\n[桌面端 1366×900]");
  {
    const { ctx, page } = await freshContext(browser);
    await page.goto(BASE);
    await page.waitForFunction(() => window.__app && document.querySelectorAll(".task-card").length >= 1);

    await check("页面加载无 JS 控制台错误", async () => {
      assert(page.__consoleErrors.filter(e => !e.includes("favicon")).length === 0, "控制台错误: " + page.__consoleErrors.join(" | "));
    });
    await shot(page, "01-desktop-board.png");

    await check("种子示例任务 DIVE-001 出现在待复核列", async () => {
      const card = page.locator(".kcol").first().locator(".task-card");
      assert(await card.count() === 1, "待复核列卡片数=" + await card.count());
      assert((await card.textContent()).includes("DIVE-001"), "未见 DIVE-001");
    });

    await check("未填操作者时操作被拦截并提示", async () => {
      await page.click(".task-card button[data-act='approve']");
      const t = await toastText(page);
      assert(t.includes("操作者"), "提示不匹配: " + t);
    });

    await setOperator(page, "调度员林澜");

    await check("合法排班：11:00–12:00 林澜/cyl-2 进入待复核", async () => {
      await page.fill("#taskForm [name=code]", "DIVE-010");
      await page.fill("#taskForm [name=start]", "");
      // 直接用 store 读窗口时间拼 11:00（种子窗口为明天08:00起）
      const startVal = await page.evaluate(() => {
        const w = __app.store.list("windows")[0];
        const p = n => String(n).padStart(2, "0");
        const d = new Date(w.from + 3 * 3600000);
        return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
      });
      const endVal = await page.evaluate(() => {
        const w = __app.store.list("windows")[0];
        const p = n => String(n).padStart(2, "0");
        const d = new Date(w.from + 4 * 3600000);
        return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
      });
      await page.fill("#taskForm [name=start]", startVal);
      await page.fill("#taskForm [name=end]", endVal);
      await page.selectOption(".assign-row .a-diver", { label: "林澜（SAC 20）" });
      await page.selectOption(".assign-row .a-cylinder", { label: "C-12L-02 220bar" });
      // 气量预览实时计算
      const preview = await page.textContent("#gasPreview");
      assert(preview.includes("2016L") && preview.includes("✓"), "气量预览异常: " + preview);
      await page.click("#submitTaskBtn");
      const t = await toastText(page);
      assert(t.includes("待复核"), "提示: " + t);
      const count = await page.locator(".kcol").first().locator(".task-card").count();
      assert(count === 2, "待复核列应为 2 张，实际 " + count);
    });

    await check("同人时间冲突在界面被拦住（陈潜与 DIVE-001 同时段）", async () => {
      await page.fill("#taskForm [name=code]", "DIVE-011");
      const [sv, ev] = await page.evaluate(() => {
        const w = __app.store.list("windows")[0];
        const p = n => String(n).padStart(2, "0");
        const f = off => { const d = new Date(w.from + off); return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`; };
        return [f(3600000), f(2 * 3600000)]; // 09:00–10:00 与种子任务重叠
      });
      await page.fill("#taskForm [name=start]", sv);
      await page.fill("#taskForm [name=end]", ev);
      await page.selectOption(".assign-row .a-diver", { label: "陈潜（SAC 18）" });
      await page.selectOption(".assign-row .a-cylinder", { label: "C-12L-03 180bar" });
      await page.click("#submitTaskBtn");
      const t = await toastText(page);
      assert(t.includes("人员时间冲突"), "应拦截人员冲突，实际: " + t);
      assert(await page.locator(".task-card", { hasText: "DIVE-011" }).count() === 0, "冲突任务竟被创建");
    });

    await check("恶劣天气窗口内排班被拦住", async () => {
      await page.click('#tabs button[data-tab="data"]');
      await page.selectOption("#windowForm [name=siteId]", { index: 1 });
      await page.check("#windowForm [name=stateBadge]");
      const [sv, ev] = await page.evaluate(() => {
        const w = __app.store.list("windows")[0];
        const p = n => String(n).padStart(2, "0");
        const f = off => { const d = new Date(w.from + off); return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`; };
        return [f(5 * 3600000), f(6 * 3600000)]; // 13:00–14:00
      });
      await page.fill("#windowForm [name=from]", sv);
      await page.fill("#windowForm [name=to]", ev);
      await page.fill("#windowForm [name=note]", "雷暴大风");
      await page.click("#windowForm button");
      await page.click('#tabs button[data-tab="board"]');
      await page.fill("#taskForm [name=code]", "DIVE-012");
      await page.fill("#taskForm [name=start]", sv);
      await page.fill("#taskForm [name=end]", ev);
      await page.fill("#taskForm [name=plannedMin]", "15"); // 缩短时长避免气量先于天气被拦
      await page.selectOption(".assign-row .a-diver", { label: "高岸（SAC 22）" });
      await page.selectOption(".assign-row .a-cylinder", { label: "C-12L-03 180bar" });
      await page.click("#submitTaskBtn");
      const t = await toastText(page);
      assert(t.includes("天气窗口"), "应拦截天气，实际: " + t);
    });

    await check("状态机：批准→开始执行→关闭 全链路，关闭后气瓶扣压", async () => {
      const pressureBefore = await page.evaluate(() => __app.store.get("cylinders", "cyl-1").pressureBar);
      const card = page.locator(".task-card", { hasText: "DIVE-001" });
      await card.locator("button[data-act='approve']").click();
      await toastText(page);
      assert(await page.locator(".kcol").nth(1).locator(".task-card", { hasText: "DIVE-001" }).count() === 1, "未进入已批准列");
      await page.locator(".task-card", { hasText: "DIVE-001" }).locator("button[data-act='start']").click();
      await toastText(page);
      await page.locator(".task-card", { hasText: "DIVE-001" }).locator("button[data-act='close']").click();
      await page.waitForSelector("#modalBackdrop:not([hidden])");
      await page.click("#modalConfirm");
      await page.waitForSelector("#modalBackdrop", { state: "hidden" });
      const t = await toastText(page);
      assert(t.includes("已关闭"), "关闭提示: " + t);
      const pressureAfter = await page.evaluate(() => __app.store.get("cylinders", "cyl-1").pressureBar);
      // 实耗 18×30×2.8=1512L / 12L = 126bar
      assert(Math.abs(pressureBefore - pressureAfter - 126) < 0.2, `扣压错误: ${pressureBefore}→${pressureAfter}`);
    });

    await check("越级变更：已关闭任务没有任何流转按钮", async () => {
      const card = page.locator(".task-card", { hasText: "DIVE-001" });
      assert(await card.locator("button[data-act='approve'],button[data-act='start'],button[data-act='close']").count() === 0, "仍存在越级按钮");
    });

    await check("驳回必须填写原因", async () => {
      const card = page.locator(".task-card", { hasText: "DIVE-010" });
      await card.locator("button[data-act='reject']").click();
      await page.waitForSelector("#modalBackdrop:not([hidden])");
      await page.click("#modalConfirm"); // 不填原因
      assert(await page.isVisible("#modalBackdrop:not([hidden])"), "空原因竟允许提交（HTML必填应拦截）");
      await page.fill("#modalForm [name=reason]", "海况转差");
      await page.click("#modalConfirm");
      await page.waitForSelector("#modalBackdrop", { state: "hidden" });
      const t = await toastText(page);
      assert(t.includes("已驳回"), "提示: " + t);
      assert((await page.locator(".kcol").nth(4).locator(".task-card", { hasText: "DIVE-010" }).count()) === 1, "未进入已驳回列");
    });

    await check("重复提交幂等：同一 clientKey 只产生一条（浏览器内数据层验证）", async () => {
      const r = await page.evaluate(() => {
        const w = __app.store.list("windows")[0];
        const payload = { code: "DIVE-050", siteId: "site-1", start: w.from + 6 * 3600000, end: w.from + 7 * 3600000, depthM: 18, plannedMin: 20, assignments: [{ diverId: "div-3", cylinderId: "cyl-3" }] };
        const a = __app.store.createTask(payload, "调度员林澜", "idem-key-1");
        const b = __app.store.createTask(payload, "调度员林澜", "idem-key-1");
        return { dup: b.duplicated, same: a.task.id === b.task.id, n: __app.store.list("tasks").filter(t => t.code === "DIVE-050").length };
      });
      assert(r.dup && r.same && r.n === 1, JSON.stringify(r));
    });

    await check("原功能：标记图新增/编辑/类型筛选/时间线/导出全部可用", async () => {
      await page.click('#tabs button[data-tab="map"]');
      const box = await page.locator("#map").boundingBox();
      await page.mouse.click(box.x + box.width * 0.5, box.y + box.height * 0.5);
      await page.fill("#markForm [name=code]", "M-050");
      await page.fill("#markForm [name=dive]", "DIVE-003");
      await page.fill("#markForm [name=depth]", "16.0m");
      await page.click("#markForm button[type=submit]");
      await page.waitForTimeout(100);
      assert(await page.locator(".marker").count() === 3, "标记数应为3（2种子+1新）");
      await shot(page, "02-desktop-map.png");
      // 筛选 wood
      await page.selectOption("#filter", "wood");
      assert(await page.locator(".marker").count() === 1, "wood 筛选应只剩1个");
      await page.selectOption("#filter", "");
      // 时间线视图
      await page.selectOption("#view", "timeline");
      const tl = await page.textContent("#list");
      assert(tl.includes("DIVE-003"), "时间线缺少新潜次分组");
      await page.selectOption("#view", "list");
      // 导出
      const [dl] = await Promise.all([
        page.waitForEvent("download"),
        page.click("#exportMarksBtn"),
      ]);
      assert(dl.suggestedFilename() === "dive-marks.json", "导出文件名不符: " + dl.suggestedFilename());
      const content = JSON.parse(fs.readFileSync(await dl.path(), "utf8"));
      assert(Array.isArray(content) && content.some(m => m.code === "M-050"), "导出 JSON 不含新标记");
    });

    await check("原功能：全量数据导出（含审计）", async () => {
      const [dl] = await Promise.all([
        page.waitForEvent("download"),
        page.click("#exportAllBtn"),
      ]);
      assert(dl.suggestedFilename().startsWith("dive-ops-"), "全量导出名: " + dl.suggestedFilename());
    });

    await check("审计页记录操作者、时间、动作与前后状态", async () => {
      await page.click('#tabs button[data-tab="audit"]');
      const text = await page.textContent("#auditList");
      assert(text.includes("调度员林澜"), "缺少操作者");
      assert(text.includes("批准"), "缺少批准动作");
      assert(text.includes("关闭"), "缺少关闭动作");
      assert(await page.locator("details pre").count() >= 2, "缺少前后状态快照");
      await shot(page, "03-desktop-audit.png");
      // 驳回原因写入审计 note
      assert(text.includes("海况转差"), "审计缺少驳回说明");
    });

    await check("筛选：只看已关闭任务", async () => {
      await page.click('#tabs button[data-tab="board"]');
      await page.selectOption("#taskStatusFilter", "closed");
      const visible = await page.locator(".task-card:visible").count();
      const closedCards = await page.locator(".kcol").nth(3).locator(".task-card").count();
      assert(closedCards === 1, "已关闭列应有1张");
      let totalOther = 0;
      for (let i = 0; i < 5; i++) if (i !== 3) totalOther += await page.locator(".kcol").nth(i).locator(".task-card").count();
      assert(totalOther === 0, "筛选后其它列仍有卡片");
      await page.selectOption("#taskStatusFilter", "");
    });

    await ctx.close();
  }

  /* ---------------- 手机端 ---------------- */
  console.log("\n[手机端 390×844 触屏]");
  {
    const { ctx, page } = await freshContext(browser, {
      viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true, deviceScaleFactor: 3,
    });
    await page.goto(BASE);
    await page.waitForFunction(() => window.__app);

    await check("看板在手机上单列排布", async () => {
      const cols = await page.locator("#kanban").evaluate(el => getComputedStyle(el).gridTemplateColumns);
      assert(cols.split(" ").length === 1, "网格列数: " + cols);
    });
    await shot(page, "04-mobile-board.png");

    await check("手机上可完成排班：新增待复核任务", async () => {
      await setOperator(page, "手机值班高岸");
      const [sv, ev] = await page.evaluate(() => {
        const w = __app.store.list("windows")[0];
        const p = n => String(n).padStart(2, "0");
        const f = off => { const d = new Date(w.from + off); return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`; };
        return [f(2 * 3600000), f(170 * 60000)]; // 10:00–10:50
      });
      await page.fill("#taskForm [name=code]", "DIVE-020");
      await page.fill("#taskForm [name=start]", sv);
      await page.fill("#taskForm [name=end]", ev);
      await page.selectOption(".assign-row .a-diver", { label: "林澜（SAC 20）" });
      await page.selectOption(".assign-row .a-cylinder", { label: "C-12L-02 220bar" });
      await page.click("#submitTaskBtn");
      const t = await toastText(page);
      assert(t.includes("待复核"), t);
    });

    await check("手机上可完成复核：驳回（弹层+原因）", async () => {
      const card = page.locator(".task-card", { hasText: "DIVE-020" });
      await card.scrollIntoViewIfNeeded();
      await card.locator("button[data-act='reject']").click();
      await page.waitForSelector("#modalBackdrop:not([hidden])");
      await page.fill("#modalForm [name=reason]", "手机端复核：能见度不足");
      await page.click("#modalConfirm");
      await page.waitForSelector("#modalBackdrop", { state: "hidden" });
      assert(await page.locator(".kcol").nth(4).locator(".task-card", { hasText: "DIVE-020" }).count() === 1, "驳回后未入列");
    });

    await check("手机上可完成异常处置：批准→执行→异常关闭", async () => {
      const card0 = page.locator(".task-card", { hasText: "DIVE-001" });
      await card0.locator("button[data-act='approve']").click(); await toastText(page);
      await page.locator(".task-card", { hasText: "DIVE-001" }).locator("button[data-act='start']").click(); await toastText(page);
      await page.locator(".task-card", { hasText: "DIVE-001" }).locator("button[data-act='close']").click();
      await page.waitForSelector("#modalBackdrop:not([hidden])");
      await page.check("#modalForm [name=abnormal]");
      await page.fill("#modalForm [name=reason]", "潜水员面镜进水，提前出水");
      await page.fill("#modalForm [name=actualMin]", "12");
      await page.click("#modalConfirm");
      await page.waitForSelector("#modalBackdrop", { state: "hidden" });
      const t = await toastText(page);
      assert(t.includes("已关闭"), t);
      const closed = await page.evaluate(() => {
        const task = __app.store.list("tasks").find(x => x.code === "DIVE-001");
        return { outcome: task.outcome, reason: task.abnormalReason, min: task.actualMin };
      });
      assert(closed.outcome === "abnormal" && closed.min === 12 && closed.reason.includes("面镜"), JSON.stringify(closed));
    });

    await check("手机上基础数据页可用（登记补气）", async () => {
      await page.click('#tabs button[data-tab="data"]');
      // 点击第一个气瓶 mini-item 载入表单，改压力后保存
      await page.locator("#cylinderList .mini-item").first().click();
      await page.fill("#cylinderForm [name=pressureBar]", "230");
      await page.click("#cylinderForm button");
      const t = await toastText(page);
      assert(t.includes("已保存"), t);
      const p = await page.evaluate(() => __app.store.list("cylinders")[0].pressureBar);
      assert(p === 230, "补气后压力=" + p);
      await shot(page, "05-mobile-data.png");
    });

    await ctx.close();
  }

  /* ---------------- 离线（Service Worker） ---------------- */
  console.log("\n[离线能力]");
  {
    const { ctx, page } = await freshContext(browser);
    await page.goto(BASE);
    await page.waitForFunction(async () => (await navigator.serviceWorker?.getRegistration()) || location.protocol === "file:");
    await page.waitForTimeout(500); // 等 SW 缓存写完
    await check("断网后刷新仍可打开并完成排班/复核", async () => {
      await ctx.setOffline(true);
      await page.reload({ waitUntil: "load" });
      await page.waitForFunction(() => window.__app);
      await setOperator(page, "离线值班员");
      // 数据仍在 localStorage
      assert(await page.locator(".task-card").count() >= 1, "离线后任务数据丢失");
      // 驳回种子任务
      await page.locator(".task-card", { hasText: "DIVE-001" }).locator("button[data-act='reject']").click();
      await page.waitForSelector("#modalBackdrop:not([hidden])");
      await page.fill("#modalForm [name=reason]", "离线演练驳回");
      await page.click("#modalConfirm");
      await page.waitForSelector("#modalBackdrop", { state: "hidden" });
      const t = await toastText(page);
      assert(t.includes("已驳回"), "离线下驳回失败: " + t);
      await shot(page, "06-offline.png");
      await ctx.setOffline(false);
    });
    await ctx.close();
  }

  /* ---------------- file:// 直开 ---------------- */
  {
    const { ctx, page } = await freshContext(browser);
    await check("file:// 直接双击打开方式可用（无需服务器）", async () => {
      await page.goto("file://" + path.join(ROOT, "index.html"));
      await page.waitForFunction(() => window.__app);
      await setOperator(page, "直开用户");
      assert(await page.locator(".task-card").count() >= 1, "无任务卡片");
      await page.locator(".task-card", { hasText: "DIVE-001" }).locator("button[data-act='approve']").click();
      const t = await toastText(page);
      assert(t.includes("已批准"), t);
    });
    await ctx.close();
  }

  await browser.close();
  srv.kill();

  console.log(`\n结果：${passed} 通过，${failures.length} 失败`);
  if (failures.length) { for (const [n, e] of failures) console.error("FAIL " + n, e.stack || e); process.exit(1); }
  console.log("截图：" + SHOTS);
})().catch(e => { console.error(e); process.exit(1); });
