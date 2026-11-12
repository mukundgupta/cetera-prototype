import { spawn } from "node:child_process";
import { writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const PORT = 9365;
const OUT = join(tmpdir(), "cetera-shots-team3");
mkdirSync(OUT, { recursive: true });
const proc = spawn(
    "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
    ["--headless=new", "--disable-gpu", "--no-sandbox", `--remote-debugging-port=${PORT}`, `--user-data-dir=${join(tmpdir(), "cetera-edge-profile14")}`, "--window-size=1536,960", "about:blank"],
    { stdio: "ignore" }
);
let ws, id = 0;
const pending = new Map();
const send = (method, params = {}) =>
    new Promise((resolve, reject) => {
        const n = ++id;
        const t = setTimeout(() => reject(new Error("CDP timeout: " + method)), 8000);
        pending.set(n, { resolve: (v) => (clearTimeout(t), resolve(v)), reject: (e) => (clearTimeout(t), reject(e)) });
        ws.send(JSON.stringify({ id: n, method, params }));
    });
const ev = async (code) => {
    const r = await send("Runtime.evaluate", { expression: `(() => { ${code} })()`, returnByValue: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.text);
    return r.result.value;
};
const move = (x, y) => send("Input.dispatchMouseEvent", { type: "mouseMoved", x, y });

try {
    for (let i = 0; i < 40; i++) {
        try {
            const list = await (await fetch(`http://127.0.0.1:${PORT}/json`)).json();
            const page = list.find((t) => t.type === "page");
            if (page) {
                ws = new WebSocket(page.webSocketDebuggerUrl);
                await new Promise((res, rej) => ((ws.onopen = res), (ws.onerror = rej)));
                ws.onmessage = (m) => {
                    const msg = JSON.parse(m.data);
                    if (msg.id && pending.has(msg.id)) {
                        const p = pending.get(msg.id);
                        pending.delete(msg.id);
                        msg.error ? p.reject(new Error(msg.error.message)) : p.resolve(msg.result);
                    }
                };
                break;
            }
        } catch { }
        await sleep(250);
    }
    await send("Page.enable");
    await send("Runtime.enable");
    await send("Emulation.setDeviceMetricsOverride", { width: 1536, height: 960, deviceScaleFactor: 1, mobile: false });
    await send("Page.navigate", { url: "file:///D:/CETERA/website/index.html" });
    await sleep(6500);
    await ev(`document.querySelector('[data-go="about"]').click()`);
    await sleep(2500);
    await ev(`const s = document.querySelector('#aboutScroller'); s.scrollTop = s.scrollHeight;`);
    await sleep(800);

    const c = JSON.parse(await ev(`const r = document.querySelectorAll('.tm')[2].getBoundingClientRect(); return JSON.stringify([Math.round(r.left + r.width / 2), Math.round(r.top + r.height / 2)]);`));
    await move(c[0], c[1]);
    await move(c[0] + 2, c[1] + 1);
    await sleep(1000);

    console.log(
        "caption line counts (line-height 22px => 2 lines = one per name/role; 3+ would mean wrapping):",
        await ev(`return JSON.stringify([...document.querySelectorAll('.tm__cap')].map(e => Math.round(e.getBoundingClientRect().height / parseFloat(getComputedStyle(e).lineHeight))));`)
    );
    console.log("column widths:", await ev(`return JSON.stringify([...document.querySelectorAll('.tm')].map(e => Math.round(e.getBoundingClientRect().width)));`));
    console.log(
        "any caption clipped by its column?",
        await ev(`return JSON.stringify([...document.querySelectorAll('.tm')].map(col => { const cap = col.querySelector('.tm__cap').getBoundingClientRect(), c = col.getBoundingClientRect(); return cap.right > c.right + 1; }));`)
    );
    const r = await send("Page.captureScreenshot", { format: "png" });
    writeFileSync(join(OUT, "hover.png"), Buffer.from(r.data, "base64"));
    console.log("done");
} catch (e) {
    console.log("FAILED:", e.message);
} finally {
    try { ws.close(); } catch { }
    proc.kill();
    setTimeout(() => process.exit(0), 300);
}
