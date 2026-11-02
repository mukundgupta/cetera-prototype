// CETERA site: loader, continuous scroll-and-snap navigation, and small interactions.
//
// The site is one 2D "world" with no native page scrolling. Everything you can reach is a
// stop on a single path:
//     hero -> who are we -> philosophy 01 -> (right) 02 -> (down) 03 -> services -> contact -> footer sheet
// The camera sits at a position along that path. The wheel / trackpad / finger move it 1:1.
// When the input stops, a spring settles it on the nearest stop (carrying any flick speed).
// Panels that need to scroll a little (who are we, contact) scroll natively first, then hand
// the gesture to the path once they reach their edge.
//
// At the very end the thing you pull up is the footer sheet. Once it fills the screen the
// CETERA stack rises, the tiles cover everything, and the page jumps back to the top.

(() => {
    "use strict";

    const $ = (sel, root = document) => root.querySelector(sel);
    const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));
    const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
    const pad2 = (n) => String(n).padStart(2, "0");
    const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
    const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

    // ------------------------------------------------------------------
    // Elements
    // ------------------------------------------------------------------
    const viewport = $("#viewport");
    const world = $("#world");
    const stage = $("#stage");
    const sheet = $("#footer"); // footer sheet, pulled up from below at the very end
    const panels = $$(".panel", world);

    const loaderEl = $("#loader");
    const columns = $$(".loader-column");

    const hdr = $("#hdr");
    const hdrRow = $("#hdrRow");

    const menu = $("#menu");
    const menuList = $("#menuList");
    const menuBtn = $("#menuBtn");
    const menuLabel = $("#menuLabel");
    const wordmark = $("#wordmark");
    const minimapNodes = $$("#minimap circle");

    // ------------------------------------------------------------------
    // Tuning
    // ------------------------------------------------------------------
    const INTRO_HOLD = reduceMotion ? 0 : 900; // the stretched wordmark holds on the black screen
    const INTRO_MS = reduceMotion ? 1 : 1500; // ...then relaxes to its normal shape as it moves up
    const TILES_AT = reduceMotion ? 0 : 650; // the tiles start lifting this long after it starts moving
    const COL_STAGGER = 120; // delay between loader columns
    const COL_DUR = 700; // one column's slide

    // Spring stiffness (rad/s) for a critically damped spring: higher = tighter.
    const FOLLOW_W = reduceMotion ? 60 : 24; // while input is arriving: stays close to the finger
    const SNAP_W = reduceMotion ? 60 : 9.5; // settling on a stop
    const JUMP_W = reduceMotion ? 60 : 7.5; // menu jumps across several panels

    const RELEASE_MS = 80; // wheel silence that counts as "let go"
    const NEED_PANEL = 0.04; // fraction of a segment you must travel for it to commit (touch / slow drags)
    const NEED_PANEL_FLICK = 0.012; // ...when it was a flick in that direction
    // Trackpad / wheel: commit the moment you have moved this far, without waiting for the
    // scrolling to go quiet (a trackpad keeps coasting for a second after the fingers lift).
    const EAGER_FRAC = 0.05; // of the distance to the next stop...
    const EAGER_MIN = 34; // ...but never less than this many px
    const EAGER_MAX = 64; // ...nor more than this many
    // The footer sheet: heavy at first, then it gives. Pulled this far (fraction of the screen
    // height) it commits on the spot and fills the screen, without waiting for you to let go.
    const SHEET_COMMIT = 0.12;
    const SHEET_COMMIT_FLICK = 0.05;
    const SHEET_RESIST = 0.6; // share of your movement the sheet follows at the very start...
    const SHEET_RESIST_FADE = 0.5; // ...easing off by this much as it comes up (so it feels like it gives)
    const SHEET_W = reduceMotion ? 60 : 14; // how fast it snaps to full screen once committed
    const NOTCH_RELEASE_MS = 500; // mouse notches are far apart, so wait longer before letting go
    const FLICK_PX = 45; // px within FLICK_WINDOW that makes a gesture a flick
    const FLICK_WINDOW = 110; // ms
    const NOTCH_COOLDOWN = 350; // ms between mouse-wheel notches

    // ------------------------------------------------------------------
    // Steps: one entry per stop. Philosophy contributes one per cell.
    // ------------------------------------------------------------------
    const steps = [];
    panels.forEach((panel, pi) => {
        const cells = $$(".cell", panel);
        if (cells.length) {
            cells.forEach((cell, sub) => {
                steps.push({
                    panel,
                    pi,
                    scope: cell,
                    sx: Number(cell.dataset.x),
                    sy: Number(cell.dataset.y),
                    sub,
                    label: panel.dataset.label,
                    scroller: null,
                });
            });
        } else {
            steps.push({
                panel,
                pi,
                scope: panel,
                label: panel.dataset.label,
                // panels with a .scroller scroll a little on their own before the path takes over
                scroller: $(".scroller", panel),
            });
        }
    });

    const scopes = steps.map((s) => s.scope);
    const last = steps.length - 1;
    const firstSide = steps.findIndex((s) => s.sx !== undefined);
    const lastSide = steps.length - 1 - [...steps].reverse().findIndex((s) => s.sx !== undefined);

    // Can the panel's own scroller still move in this direction (1 = down, -1 = up)?
    function canScroll(sc, dir) {
        if (!sc) return false;
        return dir > 0 ? sc.scrollTop + sc.clientHeight < sc.scrollHeight - 2 : sc.scrollTop > 2;
    }

    // ------------------------------------------------------------------
    // The path
    // ------------------------------------------------------------------
    let W = 0;
    let H = 0;
    let pts = []; // per-step camera position: world y, stage x, stage y (px)
    let cum = []; // distance along the path to each step (px)

    function layout() {
        W = viewport.clientWidth;
        H = viewport.clientHeight;

        pts = steps.map((s, i) => {
            // before the philosophy panel the stage rests on cell 01, after it on the last cell
            const side = s.sx !== undefined ? s : i < firstSide ? steps[firstSide] : steps[lastSide];
            return { wy: s.pi * H, sx: side.sx * W, sy: side.sy * H };
        });

        cum = [0];
        for (let i = 1; i < pts.length; i++) {
            const a = pts[i - 1];
            const b = pts[i];
            cum[i] = cum[i - 1] + Math.hypot(b.wy - a.wy, b.sx - a.sx, b.sy - a.sy);
        }
    }

    // Camera at distance p along the path. Past the last stop, `sheet` is how far the footer is up.
    function cameraAt(p) {
        if (p <= 0) return { ...pts[0], sheet: 0 };
        if (p >= cum[last]) return { ...pts[last], sheet: Math.min(H, p - cum[last]) };

        let k = 0;
        while (k < last - 1 && p > cum[k + 1]) k++;
        const t = (p - cum[k]) / (cum[k + 1] - cum[k]);
        const a = pts[k];
        const b = pts[k + 1];
        return {
            wy: a.wy + (b.wy - a.wy) * t,
            sx: a.sx + (b.sx - a.sx) * t,
            sy: a.sy + (b.sy - a.sy) * t,
            sheet: 0,
        };
    }

    // ------------------------------------------------------------------
    // State
    // ------------------------------------------------------------------
    let anchor = 0; // the stop the camera is settled on (or heading to)
    let peek = -1; // neighbouring stop being revealed while you drag toward it
    let pos = 0; // camera position along the path (px)
    let vel = 0;
    let target = 0; // where the spring is heading
    let omega = SNAP_W;
    let painted = NaN;

    let locked = true; // locked while the loader plays / the loop runs
    let armed = false; // reveal animations only run once the loader lifts
    let looping = false;
    let sheetPending = false; // heading for the full-screen footer sheet
    let menuOpen = false;
    let releaseTimer = 0;

    // ------------------------------------------------------------------
    // Header: the wordmark, and the MENU / links row that rides under it
    // ------------------------------------------------------------------
    const WM_RATIO = 248 / 1479; // wordmark file: height / width
    let introT = 0; // seconds since the wordmark let go of its stretch (loader)
    let introDone = false; // true once it has settled at the top of the hero
    let hdrP = 0; // 0 = huge across the hero, 1 = small in the middle of the header (driven by scrolling)
    let menuP = 0; // same scale, driven by the menu: eases to 1 while the menu is open, so the wordmark steps aside
    let hdrEff = 0; // whichever of the two is further along
    const smooth = (t) => t * t * (3 - 2 * t);
    const lerp = (a, b, t) => a + (b - a) * t;

    // The seven letters (C E T E R A .) each get their own underdamped spring, so they wobble.
    const WM_UNITS_W = 1479;
    let wmState = { x: 0, y: 0, sx: 1, sy: 1, u: 1 }; // where the wordmark is on screen (set by placeHeader)
    const letters = $$(".wm-l", wordmark).map((g) => ({
        g,
        cx: Number(g.dataset.cx),
        cy: Number(g.dataset.cy),
        x: 0, y: 0, r: 0, s: 1,
        vx: 0, vy: 0, vr: 0, vs: 0,
        dirty: false,
    }));

    // How lively the letters are. Turn the first five down for a calmer wordmark; raise LETTER_DAMP to
    // make the wobble die out sooner (1 = the original springiness).
    const LETTER_PUSH = 20; // how far the letters near the pointer are pushed away (drawing units)
    const LETTER_LIFT = 9; // ...and lifted
    const LETTER_TILT = 4; // ...and tilted (degrees)
    const LETTER_SWELL = 0.045; // ...and swelled (0.045 = 4.5%)
    const LETTER_HOP = 340; // how hard they hop one after another when the wordmark lands
    const LETTER_DAMP = 1.45;

    function hopLetters() {
        letters.forEach((L, i) => {
            setTimeout(() => {
                L.vy -= LETTER_HOP;
                L.vr += (i % 2 ? 1 : -1) * LETTER_HOP * 0.18;
                L.vs += LETTER_HOP / 120;
            }, i * 55);
        });
    }

    // While the menu is open the wordmark shrinks to its header size (and grows back when it closes),
    // so the big wordmark is not sitting on top of the menu. Only matters on the home screen: anywhere
    // else it is already small.
    function updateMenuScale(dt) {
        const goal = menuOpen ? 1 : 0;
        if (menuP === goal) return;
        menuP = reduceMotion ? goal : menuP + (goal - menuP) * (1 - Math.exp(-dt / 0.12));
        if (Math.abs(menuP - goal) < 0.001) menuP = goal;
        placeHeader();
    }

    function updateLetters(dt) {
        const calm = 1 - 0.55 * hdrEff; // quieter once the wordmark has shrunk into the header
        const live = pointer.x !== FAR && !reduceMotion && !locked;
        // the pointer in the wordmark own coordinates (the 1479 x 248 drawing)
        const px = (pointer.x - wmState.x) / (wmState.sx * wmState.u);
        const py = (pointer.y - wmState.y) / (wmState.sy * wmState.u);

        const n = Math.max(1, Math.ceil(dt / (1 / 120)));
        const h = dt / n;
        for (const L of letters) {
            let tx = 0, ty = 0, tr = 0, ts = 1;
            if (live) {
                const dx = L.cx - px;
                const dy = L.cy - py;
                const d = Math.hypot(dx, dy) || 1;
                const f = Math.exp(-(d * d) / (2 * 270 * 270)) * calm; // 1 right under the pointer, fading with distance
                tx = (dx / d) * LETTER_PUSH * f; // pushed away from the pointer
                ty = (dy / d) * LETTER_PUSH * 0.55 * f - LETTER_LIFT * f; // ...and lifted a little
                tr = clamp(-dx / 320, -1, 1) * LETTER_TILT * f; // leaning away
                ts = 1 + LETTER_SWELL * f; // the nearest letter swells
            }
            for (let i = 0; i < n; i++) {
                L.vx += (-9 * LETTER_DAMP * L.vx - 210 * (L.x - tx)) * h;
                L.vy += (-9 * LETTER_DAMP * L.vy - 210 * (L.y - ty)) * h;
                L.vr += (-10 * LETTER_DAMP * L.vr - 260 * (L.r - tr)) * h;
                L.vs += (-12 * LETTER_DAMP * L.vs - 300 * (L.s - ts)) * h;
                L.x += L.vx * h;
                L.y += L.vy * h;
                L.r += L.vr * h;
                L.s += L.vs * h;
            }
            const moving =
                Math.abs(L.vx) + Math.abs(L.vy) + Math.abs(L.vr) + Math.abs(L.vs) > 0.04 ||
                Math.abs(L.x - tx) + Math.abs(L.y - ty) + Math.abs(L.r - tr) + Math.abs(L.s - ts) > 0.02;
            if (moving || L.dirty) {
                L.g.setAttribute(
                    "transform",
                    `translate(${L.x.toFixed(2)} ${L.y.toFixed(2)}) translate(${L.cx} ${L.cy}) rotate(${L.r.toFixed(2)}) scale(${L.s.toFixed(4)}) translate(${-L.cx} ${-L.cy})`
                );
                L.dirty = moving;
            }
        }
    }

    // Measurements are taken from the screen designs (1536px wide hero, 1440px header frame).
    function placeHeader() {
        // huge, across the top of the hero
        const wBig = W * 0.9655;
        const hBig = wBig * WM_RATIO;
        const xBig = W * 0.0143;
        const yBig = H * 0.0625;
        const rowBig = yBig + hBig + H * 0.04;

        // small, centred in the header
        const wSmall = W * 0.149;
        const k = wSmall / wBig;
        const rowSmall = Math.max(34, W * 0.0375);
        const ySmall = rowSmall - (wSmall * WM_RATIO) / 2;

        // loader: stretched tall and centred, relaxing to its normal shape at the top
        // The height snaps back like a spring (underdamped: it squashes past its normal shape, then
        // rebounds and settles); the position glides up with no overshoot.
        const stretch = clamp((H * 0.88) / hBig, 1, 6);
        let eS = 1;
        let eY = 1;
        if (!introDone) {
            const t = introT;
            const z = 0.7; // damping ratio: < 1 means it overshoots; closer to 1 = gentler
            const om = 10; // rad/s
            const wd = om * Math.sqrt(1 - z * z);
            eS = 1 - Math.exp(-z * om * t) * (Math.cos(wd * t) + ((z * om) / wd) * Math.sin(wd * t));
            const w = 7.5;
            eY = 1 - (1 + w * t) * Math.exp(-w * t);
        }
        const syIntro = lerp(stretch, 1, eS);
        const yIntro = lerp((H - hBig * stretch) / 2, yBig, eY);
        // squashed = a little wider (keeps it centred while it does)
        const sxIntro = 1 + 0.12 * Math.max(0, 1 - syIntro);
        const xIntro = xBig - ((sxIntro - 1) * wBig) / 2;

        // scroll (or the menu): big -> small
        hdrEff = Math.max(hdrP, menuP);
        const e = smooth(hdrEff);
        const sx = lerp(sxIntro, k, e);
        const sy = lerp(syIntro, k, e);
        const x = lerp(xIntro, (W - wSmall) / 2, e);
        const y = lerp(yIntro, ySmall, e);

        wmState = { x, y, sx, sy, u: wBig / WM_UNITS_W };
        wordmark.style.width = `${wBig}px`;
        wordmark.style.transform = `translate3d(${x}px, ${y}px, 0) scale(${sx}, ${sy})`;
        hdrRow.style.top = `${lerp(rowBig, rowSmall, e)}px`;
    }

    // ------------------------------------------------------------------
    // Painting
    // ------------------------------------------------------------------
    function paint() {
        if (pos === painted) return;
        painted = pos;
        const c = cameraAt(pos);
        world.style.transform = `translate3d(0, ${-c.wy}px, 0)`;
        stage.style.transform = `translate3d(${-c.sx}px, ${-c.sy}px, 0)`;
        // 0 on the philosophy title card, 1 once the camera has reached 01: sweeps the big title away
        stage.style.setProperty("--ph", clamp(c.sy / H, 0, 1).toFixed(3));
        sheet.style.transform = `translate3d(0, ${H - c.sheet}px, 0)`;

        // the wordmark shrinks into the header over the first 65% of the move off the hero
        hdrP = clamp(pos / (H * 0.65), 0, 1);
        placeHeader();
    }

    function applyScope() {
        const cur = steps[anchor].scope;
        const pk = peek >= 0 ? steps[peek].scope : null;
        scopes.forEach((el) => el.classList.toggle("is-current", armed && (el === cur || el === pk)));
    }

    function updateUI() {
        const cur = steps[anchor];
        // over the (black) menu the header is always cream, even on a light panel
        hdr.dataset.header = menuOpen ? "cream" : cur.panel.dataset.header || "cream";
        // the title card is sub 0; the three minimap dots are philosophies 01, 02, 03
        minimapNodes.forEach((node, n) => node.classList.toggle("is-on", cur.sub === n + 1));
        $$("button", menuList).forEach((btn) => {
            if (Number(btn.dataset.panel) === cur.pi) btn.setAttribute("aria-current", "step");
            else btn.removeAttribute("aria-current");
        });
    }

    // Entering a self-scrolling panel: start at its top, unless we arrive from directly below,
    // in which case start at its bottom (so scrolling up retraces it).
    function prepareScroller(i) {
        const s = steps[i];
        if (!s.scroller || s.panel === steps[anchor].panel) return;
        const fromBelow = steps[anchor].pi - s.pi === 1;
        s.scroller.scrollTop = fromBelow ? s.scroller.scrollHeight : 0;
    }

    function setPeek(i) {
        if (i === peek) return;
        peek = i;
        if (i >= 0) prepareScroller(i);
        applyScope();
    }

    // ------------------------------------------------------------------
    // Moving the camera
    // ------------------------------------------------------------------
    function stepCamera(dt) {
        if (pos === target && vel === 0) return;

        // critically damped spring, integrated in small sub-steps for stability
        const n = Math.max(1, Math.ceil(dt / (1 / 120)));
        const h = dt / n;
        for (let i = 0; i < n; i++) {
            const acc = -2 * omega * vel - omega * omega * (pos - target);
            vel += acc * h;
            pos += vel * h;
        }

        if (Math.abs(pos - target) < 0.08 && Math.abs(vel) < 1) {
            pos = target;
            vel = 0;
            paint();
            onSettled();
            return;
        }
        paint();
    }

    function onSettled() {
        if (peek !== -1 && peek !== anchor) {
            peek = -1;
            applyScope();
        }
    }

    // The footer is committed: the sheet snaps to full screen and the whole loop runs from here.
    function commitSheet() {
        clearTimeout(releaseTimer);
        locked = true;
        sheetPending = true;
        omega = SHEET_W;
        target = cum[last] + H;
        runLoop();
    }

    // Heads for stop i, or for the full-screen footer sheet when i > last.
    function snapTo(i, w = SNAP_W) {
        if (i > last) {
            commitSheet();
            return;
        }
        const idx = i;
        omega = w;
        sheetPending = false;
        target = cum[idx];

        if (idx !== anchor) {
            anchor = idx;
            peek = -1;
            applyScope();
            updateUI();
        }
    }

    function goTo(i) {
        if (locked || i < 0 || i > last) return;
        if (i === anchor && Math.abs(target - cum[anchor]) < 0.5) return;
        clearTimeout(releaseTimer);
        prepareScroller(i);
        snapTo(i, Math.abs(i - anchor) > 2 ? JUMP_W : SNAP_W);
    }

    // One stop forward / back from where the camera is heading.
    function goStep(dir) {
        if (locked) return;
        clearTimeout(releaseTimer);

        // pushing against the current displacement just means "go back to the stop"
        const disp = target - cum[anchor];
        if (dir * disp < -1) {
            snapTo(anchor);
            return;
        }
        if (dir > 0 && anchor === last) {
            snapTo(last + 1);
            return;
        }
        const i = anchor + dir;
        if (i < 0) return;
        prepareScroller(i);
        snapTo(i);
    }

    // Input arrived (px, positive = forward): the camera follows it 1:1 within one segment.
    function feed(d, eager = false) {
        if (locked) return;
        const lo = cum[Math.max(anchor - 1, 0)];
        const hi = anchor === last ? cum[last] + H : cum[anchor + 1];

        // Pulling the footer sheet up: it resists, easing off the further it comes. Letting it
        // back down is 1:1, so releasing the weight feels natural.
        let move = d;
        if (anchor === last && d > 0) {
            const s = Math.max(0, target - cum[last]);
            const give = clamp(s / (H * 0.3), 0, 1);
            move = d * SHEET_RESIST * (1 - SHEET_RESIST_FADE * give);
        }

        target = clamp(target + move, lo, hi);
        omega = FOLLOW_W;
        sheetPending = false;

        // far enough already: go to the next stop now (the footer sheet has its own rule above)
        if (eager && !(anchor === last && target > cum[last] + 0.5)) {
            const away = target - cum[anchor];
            const dirN = Math.sign(away);
            const nextI = anchor + dirN;
            if (dirN && nextI >= 0 && nextI <= last) {
                const seg = Math.abs(cum[nextI] - cum[anchor]);
                if (Math.abs(away) >= clamp(EAGER_FRAC * seg, EAGER_MIN, EAGER_MAX)) {
                    swallowUntilQuiet = true; // the coasting tail of this swipe must not trigger another move
                    clearTimeout(releaseTimer);
                    goStep(dirN);
                    return;
                }
            }
        }

        // far enough: it commits on the spot and fills the screen
        if (anchor === last && target - cum[last] >= SHEET_COMMIT * H) {
            commitSheet();
            return;
        }

        const disp = target - cum[anchor];
        if (disp > 0.5 && anchor < last) setPeek(anchor + 1);
        else if (disp < -0.5 && anchor > 0) setPeek(anchor - 1);
        else setPeek(-1);
    }

    // Input stopped: settle on a stop. `flick` is +1/-1 when the last movement was fast.
    function release(flick = 0) {
        clearTimeout(releaseTimer);
        if (locked) return;

        const base = cum[anchor];
        const disp = target - base;
        if (Math.abs(disp) < 0.5) {
            snapTo(anchor);
            return;
        }

        const dir = Math.sign(disp);
        const toSheet = anchor === last && dir > 0;
        const seg = toSheet ? H : Math.abs(cum[anchor + dir] - base);
        const frac = Math.abs(disp) / seg;
        const need = toSheet
            ? flick === dir ? SHEET_COMMIT_FLICK : SHEET_COMMIT
            : flick === dir ? NEED_PANEL_FLICK : NEED_PANEL;

        if (frac >= need) snapTo(toSheet ? last + 1 : anchor + dir);
        else snapTo(anchor);
    }

    // Recent-movement tracker, to tell a flick from a slow drag.
    let samples = [];
    function noteMove(d) {
        const now = performance.now();
        samples.push({ t: now, d });
        samples = samples.filter((s) => now - s.t <= FLICK_WINDOW);
    }
    function flickDir() {
        const sum = samples.reduce((a, s) => a + s.d, 0);
        samples = [];
        return Math.abs(sum) >= FLICK_PX ? Math.sign(sum) : 0;
    }
    const scheduleRelease = (ms = RELEASE_MS) => {
        clearTimeout(releaseTimer);
        releaseTimer = setTimeout(() => release(flickDir()), ms);
    };

    // Resolves once cond() is true (checked every frame), or after a timeout.
    const until = (cond, timeout = 1500) =>
        new Promise((resolve) => {
            const t0 = performance.now();
            (function poll() {
                if (cond() || performance.now() - t0 > timeout) resolve();
                else requestAnimationFrame(poll);
            })();
        });

    // ------------------------------------------------------------------
    // Loader (first load) and the loop
    // ------------------------------------------------------------------
    async function revealColumns() {
        columns.forEach((col, i) => {
            col.style.transform = "";
            setTimeout(() => col.classList.add("is-revealed"), i * COL_STAGGER);
        });
        await wait((columns.length - 1) * COL_STAGGER + COL_DUR);
    }

    // Columns rise from the bottom, continuing the "going up" motion.
    async function coverColumns() {
        columns.forEach((col) => {
            col.classList.remove("is-revealed");
            col.style.transition = "none";
            col.style.transform = "translateY(100%)";
        });
        void loaderEl.offsetWidth;
        columns.forEach((col, i) => {
            col.style.transition = "";
            setTimeout(() => {
                col.style.transform = "translateY(0)";
            }, i * COL_STAGGER);
        });
        await wait((columns.length - 1) * COL_STAGGER + COL_DUR);
    }

    // Plays once, on load: the wordmark starts stretched tall on a black screen, relaxes to its
    // normal shape while moving up to the top of the hero, and the black tiles lift off behind it.
    const tween = (ms, fn) =>
        new Promise((resolve) => {
            const t0 = performance.now();
            (function tick(now) {
                const t = clamp((now - t0) / ms, 0, 1);
                fn(t);
                if (t < 1) requestAnimationFrame(tick);
                else resolve();
            })(t0);
        });

    async function runLoader() {
        await wait(INTRO_HOLD);

        const relax = tween(INTRO_MS, (t) => {
            introT = t * (INTRO_MS / 1000);
            placeHeader();
        }).then(() => {
            introDone = true;
            placeHeader();
        });
        // the letters hop one after another as it lands
        setTimeout(hopLetters, reduceMotion ? 0 : 480);

        // once the wordmark is well on its way, the tiles lift off the hero
        await wait(TILES_AT);
        armed = true; // the hero text starts as the tiles lift
        applyScope();
        const lift = revealColumns();

        await relax;
        hdr.classList.remove("is-intro"); // MENU and the links fade in
        await lift;
        hdr.classList.remove("is-above"); // back below the tiles, which the footer loop covers it with
    }

    // The footer is committed: the sheet fills the screen, the CETERA stack starts rising the
    // moment it does, the tiles start rising while the stack is still on its way up, and the page
    // jumps back to the top. There are no fixed holds between these steps: each one starts as the
    // previous one is nearly done. The dots loader does not replay; the tiles just lift off the hero.
    async function runLoop() {
        if (looping) return;
        looping = true;
        locked = true;
        clearTimeout(releaseTimer);
        if (menuOpen) toggleMenu(false, false);

        // 1. the sheet is (almost) full screen...
        await until(() => pos - cum[last] >= H * 0.8, 900);
        // 2. ...so the stack starts moving up right away, while the sheet is still settling
        sheet.classList.add("is-leaving");
        // 3. the tiles start rising while the stack is still on its way
        await wait(260);
        await coverColumns();

        // unseen jump back to the top, sheet parked below again
        armed = false;
        anchor = 0;
        peek = -1;
        sheetPending = false;
        pos = target = 0;
        vel = 0;
        painted = NaN;
        paint();
        applyScope();
        updateUI();
        sheet.classList.remove("is-leaving");

        await wait(200);
        armed = true; // hero reveal starts as the tiles lift
        applyScope();
        await revealColumns();

        locked = false;
        looping = false;
    }

    // ------------------------------------------------------------------
    // Menu (simple placeholder; the isometric version comes later)
    // ------------------------------------------------------------------
    panels.forEach((panel, pi) => {
        if (panel.dataset.menu === "false") return;
        const stepIndex = steps.findIndex((s) => s.panel === panel);

        const li = document.createElement("li");
        const btn = document.createElement("button");
        btn.type = "button";
        btn.dataset.step = String(stepIndex);
        btn.dataset.panel = String(pi);
        btn.innerHTML = `<span class="mono">${pad2(menuList.children.length + 1)}</span><span>${panel.dataset.label}</span>`;
        li.appendChild(btn);
        menuList.appendChild(li);
    });

    function toggleMenu(open, restoreFocus = true) {
        menuOpen = open;
        updateUI();
        menu.classList.toggle("is-open", open);
        menu.inert = !open;
        menuBtn.setAttribute("aria-expanded", String(open));
        menuLabel.textContent = open ? "close" : "menu";
        if (open) {
            const t = $("button[aria-current]", menuList) || $("button", menuList);
            if (t) t.focus();
        } else if (restoreFocus) {
            menuBtn.focus();
        }
    }

    menuBtn.addEventListener("click", () => toggleMenu(!menuOpen));

    menuList.addEventListener("click", (e) => {
        const btn = e.target.closest("button[data-step]");
        if (!btn) return;
        toggleMenu(false, false);
        goTo(Number(btn.dataset.step));
    });

    wordmark.addEventListener("click", () => {
        if (menuOpen) toggleMenu(false, false);
        goTo(0);
    });

    // header links: about, work (the services panel for now), contact
    $$("[data-go]").forEach((a) => {
        a.addEventListener("click", (e) => {
            e.preventDefault();
            const panel = panels.find((p) => p.dataset.label === a.dataset.go);
            if (!panel) return;
            if (menuOpen) toggleMenu(false, false);
            goTo(steps.findIndex((s) => s.panel === panel));
        });
    });

    // The team strip grows from its inset size to the full screen as you scroll through
    // .team-expand (a tall block whose stage sticks to the screen). CSS reads --x (0 -> 1).
    const aboutScroller = $("#aboutScroller");
    const teamExpand = $("#teamExpand");
    function updateTeam() {
        if (!aboutScroller || !teamExpand) return;
        const range = teamExpand.offsetHeight - aboutScroller.clientHeight;
        const x = range > 0 ? clamp((aboutScroller.scrollTop - teamExpand.offsetTop) / range, 0, 1) : 0;
        teamExpand.style.setProperty("--x", x.toFixed(4));
    }
    if (aboutScroller) aboutScroller.addEventListener("scroll", updateTeam, { passive: true });
    window.addEventListener("resize", updateTeam);

    // ------------------------------------------------------------------
    // Input: wheel / trackpad, touch, keys
    // ------------------------------------------------------------------
    // Is the camera sitting on its stop (so the panel's own scroller may take the input)?
    const atRest = () => Math.abs(target - cum[anchor]) < 0.5;

    let lastWheelAt = 0;
    let swallowUntilQuiet = false; // after an eager move, ignore the rest of that swipe
    let lastNotchAt = 0;

    window.addEventListener(
        "wheel",
        (e) => {
            const now = performance.now();
            const gap = now - lastWheelAt;
            lastWheelAt = now;

            if (menuOpen || locked) {
                e.preventDefault();
                return;
            }

            // the tail of a swipe that has already moved the page: swallow it until things go quiet
            if (swallowUntilQuiet) {
                if (gap > 140) swallowUntilQuiet = false;
                else {
                    e.preventDefault();
                    return;
                }
            }

            let d = Math.abs(e.deltaY) >= Math.abs(e.deltaX) ? e.deltaY : e.deltaX;
            if (e.deltaMode === 1) d *= 33; // lines -> px (some mice)
            else if (e.deltaMode === 2) d *= H; // pages -> px
            if (!d) return;
            const dir = d > 0 ? 1 : -1;

            // 1) the panel can still scroll on its own: let the browser do it (smooth, native)
            const sc = steps[anchor].scroller;
            if (sc && atRest() && canScroll(sc, dir)) return;

            e.preventDefault();

            // heading back over the stop while the panel can still scroll that way:
            // stop exactly on the stop, the next events then scroll the panel natively
            const disp = target - cum[anchor];
            if (sc && disp !== 0 && Math.sign(disp) === -dir && Math.abs(d) >= Math.abs(disp) && canScroll(sc, dir)) {
                target = cum[anchor];
                setPeek(-1);
                scheduleRelease();
                return;
            }

            // 2) a mouse-wheel notch: go straight to the next stop, no waiting
            const notch =
                e.deltaMode !== 0 || (Math.abs(e.deltaY) >= 80 && Number.isInteger(e.deltaY) && gap > 70);

            // ...except at the end of the page: notches pull the footer sheet up, one heavy
            // notch after another, instead of jumping (so a mouse feels like the trackpad does)
            if (notch && anchor === last && (dir > 0 || target > cum[last] + 0.5)) {
                noteMove(d);
                feed(d);
                scheduleRelease(NOTCH_RELEASE_MS);
                return;
            }

            if (notch) {
                if (now - lastNotchAt < NOTCH_COOLDOWN) return;
                lastNotchAt = now;
                goStep(dir);
                return;
            }

            // 3) trackpad: follow it 1:1; moves on as soon as you have gone far enough, or when it stops
            noteMove(d);
            feed(d, true);
            scheduleRelease();
        },
        { passive: false }
    );

    let touch = null;
    viewport.addEventListener(
        "touchstart",
        (e) => {
            if (menuOpen || locked) return;
            const t = e.touches[0];
            clearTimeout(releaseTimer);
            samples = [];
            touch = { x: t.clientX, y: t.clientY };
        },
        { passive: true }
    );
    viewport.addEventListener(
        "touchmove",
        (e) => {
            if (!touch || menuOpen || locked) return;
            const t = e.touches[0];
            const dx = touch.x - t.clientX;
            const dy = touch.y - t.clientY;
            touch.x = t.clientX;
            touch.y = t.clientY;

            const d = Math.abs(dy) >= Math.abs(dx) ? dy : dx;
            if (!d) return;
            const dir = d > 0 ? 1 : -1;

            // the panel can still scroll under the finger: leave it to the browser
            const sc = steps[anchor].scroller;
            if (sc && atRest() && canScroll(sc, dir)) return;

            if (e.cancelable) e.preventDefault();
            noteMove(d);
            feed(d); // the page moves exactly with the finger
        },
        { passive: false }
    );
    const endTouch = () => {
        if (!touch) return;
        touch = null;
        if (!locked && !menuOpen) release(flickDir());
    };
    viewport.addEventListener("touchend", endTouch, { passive: true });
    viewport.addEventListener("touchcancel", endTouch, { passive: true });

    window.addEventListener("keydown", (e) => {
        if (e.key === "Escape" && menuOpen) {
            toggleMenu(false);
            return;
        }
        if (menuOpen || locked || e.altKey || e.ctrlKey || e.metaKey) return;

        const t = e.target;
        // never hijack typing in the form
        if (t.closest && t.closest("input, textarea, select")) return;
        const onControl = t.closest && t.closest("button, a");
        if (onControl && (e.key === " " || e.key === "Enter")) return;

        // arrows/space first scroll the panel itself, then move on
        const move = (dir) => {
            const sc = steps[anchor].scroller;
            if (sc && atRest() && canScroll(sc, dir)) {
                sc.scrollBy({
                    top: dir * sc.clientHeight * 0.85,
                    behavior: reduceMotion ? "auto" : "smooth",
                });
            } else {
                goStep(dir);
            }
        };

        switch (e.key) {
            case "ArrowDown":
            case "ArrowRight":
            case "PageDown":
            case " ":
                e.preventDefault();
                move(1);
                break;
            case "ArrowUp":
            case "ArrowLeft":
            case "PageUp":
                e.preventDefault();
                move(-1);
                break;
            case "Home":
                e.preventDefault();
                goTo(0);
                break;
            case "End":
                e.preventDefault();
                goTo(last);
                break;
            default:
        }
    });

    // Tabbing into an off-screen panel should bring it into view, not scroll the clip box.
    viewport.addEventListener("focusin", (e) => {
        const cell = e.target.closest(".cell");
        const panel = e.target.closest(".panel");
        const i = steps.findIndex((s) => (cell ? s.scope === cell : s.panel === panel));
        if (i >= 0 && i !== anchor) goTo(i);
        viewport.scrollTop = 0;
        viewport.scrollLeft = 0;
        panels.forEach((p) => {
            p.scrollTop = 0;
            p.scrollLeft = 0;
        });
    });

    window.addEventListener("resize", () => {
        layout();
        pos = target = cum[anchor] + (sheetPending ? H : 0);
        vel = 0;
        painted = NaN;
        paint();
    });

    // placeholder links shouldn't jump anywhere yet
    $$("a[data-placeholder]").forEach((a) => a.addEventListener("click", (e) => e.preventDefault()));

    // Scroll-reveal for content that sits below the fold of a self-scrolling panel
    $$("[data-sreveal]").forEach((el) => {
        if (!("IntersectionObserver" in window)) {
            el.classList.add("is-seen");
            return;
        }
        const io = new IntersectionObserver(
            (entries) => entries.forEach((en) => en.target.classList.toggle("is-seen", en.isIntersecting)),
            { root: el.closest(".scroller"), threshold: 0.2 }
        );
        io.observe(el);
    });

    // Contact form: not connected to anything yet, so it must not claim to have sent.
    const form = $("#contactForm");
    const formStatus = $("#formStatus");
    if (form) {
        form.addEventListener("submit", (e) => {
            e.preventDefault();
            if (!form.reportValidity()) return;
            formStatus.textContent = "[ form isn't connected yet, nothing was sent ]";
        });
    }

    // ------------------------------------------------------------------
    // Pointer (used by the dot grids)
    // ------------------------------------------------------------------
    const FAR = -9999;
    const pointer = { x: FAR, y: FAR, lastMove: 0 };

    window.addEventListener(
        "pointermove",
        (e) => {
            pointer.x = e.clientX;
            pointer.y = e.clientY;
            pointer.lastMove = performance.now();
        },
        { passive: true }
    );
    window.addEventListener(
        "pointerup",
        (e) => {
            if (e.pointerType === "touch") pointer.x = pointer.y = FAR;
        },
        { passive: true }
    );
    document.addEventListener("mouseleave", () => {
        pointer.x = pointer.y = FAR;
    });

    // ------------------------------------------------------------------
    // Cursor: a dot, and a smaller dot trailing it. Over anything interactive the dot grows into a
    // disc. Both are blended with the page (see .cursor in styles.css), which is what flips the
    // colours of whatever is underneath.
    // ------------------------------------------------------------------
    const cursorDot = $("#cursorDot");
    const cursorTrail = $("#cursorTrail");
    const finePointer = window.matchMedia("(hover: hover) and (pointer: fine)").matches;
    const INTERACTIVE = `a, button, [role="button"], summary, select, [data-cursor]`;
    const TEXTFIELD = "input, textarea";
    const trail = { x: 0, y: 0, ready: false };
    let cursorState = "";
    let cursorFrame = 0;

    if (finePointer && cursorDot && cursorTrail) {
        document.documentElement.classList.add("has-cursor");
        window.addEventListener("pointerdown", () => cursorDot.classList.add("is-down"), { passive: true });
        window.addEventListener("pointerup", () => cursorDot.classList.remove("is-down"), { passive: true });
        document.documentElement.addEventListener("mouseleave", () => {
            pointer.x = pointer.y = FAR;
        });
    }

    function updateCursor(dt) {
        if (!finePointer || !cursorDot) return;
        const hidden = pointer.x === FAR;
        cursorDot.classList.toggle("is-on", !hidden);
        cursorTrail.classList.toggle("is-on", !hidden);
        if (hidden) {
            trail.ready = false;
            return;
        }
        if (!trail.ready) {
            trail.x = pointer.x;
            trail.y = pointer.y;
            trail.ready = true;
        }

        // the small dot eases toward the pointer (frame-rate independent)
        const k = reduceMotion ? 1 : 1 - Math.exp(-dt / 0.085);
        trail.x += (pointer.x - trail.x) * k;
        trail.y += (pointer.y - trail.y) * k;
        cursorDot.style.transform = `translate3d(${pointer.x}px, ${pointer.y}px, 0)`;
        cursorTrail.style.transform = `translate3d(${trail.x.toFixed(2)}px, ${trail.y.toFixed(2)}px, 0)`;

        // what is under the pointer? (re-checked every few frames, since the page also moves under a still pointer)
        if (++cursorFrame % 3 === 0) {
            const el = document.elementFromPoint(pointer.x, pointer.y);
            let state = "";
            if (el) {
                const hit = el.closest(INTERACTIVE);
                if (el.closest(TEXTFIELD)) state = "text";
                else if (hit && !hit.disabled && !hit.closest("[inert]")) state = "hover";
            }
            if (state !== cursorState) {
                cursorState = state;
                cursorDot.classList.toggle("is-hover", state === "hover");
                cursorDot.classList.toggle("is-text", state === "text");
            }
        }
    }

    // ------------------------------------------------------------------
    // Dot grid: dots push away from the cursor and spring back
    // ------------------------------------------------------------------
    function createDotGrid(canvas, opts = {}) {
        const gap = opts.gap ?? 30;
        const radius = opts.radius ?? 1.7;
        const influence = opts.influence ?? 150;
        const push = opts.push ?? 42;

        const ctx = canvas.getContext("2d");
        let w = 0;
        let h = 0;
        let color = "#000";
        let dots = [];

        function draw() {
            ctx.clearRect(0, 0, w, h);
            ctx.fillStyle = color;
            ctx.beginPath();
            for (const d of dots) {
                ctx.moveTo(d.x + radius, d.y);
                ctx.arc(d.x, d.y, radius, 0, Math.PI * 2);
            }
            ctx.fill();
        }

        function resize() {
            const dpr = Math.min(window.devicePixelRatio || 1, 2);
            w = canvas.offsetWidth;
            h = canvas.offsetHeight;
            canvas.width = Math.round(w * dpr);
            canvas.height = Math.round(h * dpr);
            ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
            color = getComputedStyle(canvas).color;

            const cols = Math.ceil(w / gap) + 1;
            const rows = Math.ceil(h / gap) + 1;
            const ox = (w - (cols - 1) * gap) / 2;
            const oy = (h - (rows - 1) * gap) / 2;

            dots = [];
            for (let r = 0; r < rows; r++) {
                for (let c = 0; c < cols; c++) {
                    const hx = ox + c * gap;
                    const hy = oy + r * gap;
                    dots.push({ hx, hy, x: hx, y: hy, vx: 0, vy: 0 });
                }
            }
            draw();
        }

        function update() {
            if (reduceMotion) return;
            const rect = canvas.getBoundingClientRect();
            if (rect.bottom < 0 || rect.top > innerHeight || rect.right < 0 || rect.left > innerWidth) return;

            const px = pointer.x - rect.left;
            const py = pointer.y - rect.top;
            let moved = false;

            for (const d of dots) {
                let tx = d.hx;
                let ty = d.hy;
                const dx = d.hx - px;
                const dy = d.hy - py;
                const dist = Math.hypot(dx, dy);
                if (dist < influence && dist > 0.001) {
                    const f = 1 - dist / influence;
                    tx += (dx / dist) * f * push;
                    ty += (dy / dist) * f * push;
                }
                d.vx = (d.vx + (tx - d.x) * 0.14) * 0.74;
                d.vy = (d.vy + (ty - d.y) * 0.14) * 0.74;
                d.x += d.vx;
                d.y += d.vy;
                if (Math.abs(d.vx) > 0.01 || Math.abs(d.vy) > 0.01) moved = true;
            }
            if (moved) draw();
        }

        resize();
        window.addEventListener("resize", resize);
        return { update };
    }

    const grids = $$(".dot-grid").map((canvas) => createDotGrid(canvas));

    // ------------------------------------------------------------------
    // Philosophy 02: draw the line joining the two words
    // ------------------------------------------------------------------
    function drawConnect() {
        const title = $("#connectTitle");
        const a = $("#nodeA");
        const b = $("#nodeB");
        const path = $("#connectPath");
        if (!title || !a || !b || !path) return;

        const t = title.getBoundingClientRect();
        const ra = a.getBoundingClientRect();
        const rb = b.getBoundingClientRect();
        const ax = ra.left + ra.width / 2 - t.left;
        const ay = ra.top + ra.height / 2 - t.top;
        const bx = rb.left + rb.width / 2 - t.left;
        const by = rb.top + rb.height / 2 - t.top;
        const mid = (by - ay) / 2;

        path.setAttribute("d", `M${ax} ${ay} C${ax} ${ay + mid} ${bx} ${by - mid} ${bx} ${by}`);
        path.style.setProperty("--len", String(Math.ceil(path.getTotalLength()) + 2));
    }

    window.addEventListener("resize", drawConnect);
    if (document.fonts && document.fonts.ready) document.fonts.ready.then(drawConnect);

    // ------------------------------------------------------------------
    // Frame loop: the camera spring, plus the pointer-driven bits
    // ------------------------------------------------------------------
    let lastFrame = 0;
    function frame(t) {
        const dt = Math.min((t - (lastFrame || t)) / 1000, 0.05);
        lastFrame = t;
        stepCamera(dt);
        updateMenuScale(dt);
        updateLetters(dt);
        updateCursor(dt);
        grids.forEach((g) => g.update());
        requestAnimationFrame(frame);
    }

    // ------------------------------------------------------------------
    // Go
    // ------------------------------------------------------------------
    menuBtn.disabled = true;
    wordmark.disabled = true;

    layout();
    paint();
    applyScope();
    updateUI();
    drawConnect();
    requestAnimationFrame(frame);

    runLoader().then(() => {
        locked = false;
        menuBtn.disabled = false;
        wordmark.disabled = false;
    });
})();




