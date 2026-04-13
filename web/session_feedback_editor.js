import { app } from "../../scripts/app.js";
import { api } from "../../scripts/api.js";

/**
 * ⭐ Session Feedback Editor — Frontend Extension
 *
 * Features:
 *   - Star ratings (1-5) per prompt
 *   - Director notes per prompt
 *   - Thumbnail previews per prompt (multiple passes supported)
 *   - Reset confirmation popup on Reader node
 *
 * Data flow:
 *   1. On node creation → GET /session_feedback/load (initial state)
 *   2. On execution → websocket "session_feedback_update" (latest run)
 *   3. On Save click → POST /session_feedback/save + optional /resume
 *   4. On run change → GET /session_feedback/thumbnails (load images)
 */

// ── Visual constants ──────────────────────────────────────────────────
const STAR_FILLED  = "★";
const STAR_EMPTY   = "☆";
const STAR_COUNT   = 5;
const GOLD         = "#FFD700";
const GREY         = "#555";
const CARD_BG      = "#16213e";
const CARD_BORDER  = "#0f3460";
const TEXT_COLOR   = "#e0e0e0";
const LABEL_COLOR  = "#94a3b8";
const CONCEPT_CLR  = "#7dd3fc";
const NOTES_BG     = "#1e293b";
const NOTES_BORDER = "#334155";
const BTN_SAVE_BG  = "#2563eb";
const BTN_SAVE_HV  = "#3b82f6";
const BTN_WAIT_BG  = "#d97706";
const BTN_WAIT_HV  = "#f59e0b";
const BTN_DONE_BG  = "#16a34a";
const AVOID_CLR    = "#f87171";
const REPLICATE_CLR = "#4ade80";
const NODE_MIN_W   = 380;

// Thumbnail constants
const THUMB_SIZE   = 70;   // square thumbnail dimension
const THUMB_GAP    = 5;    // gap between thumbnails
const THUMB_RADIUS = 5;    // border radius

const RATING_LABELS = {
  0: "",
  1: "Poor — AVOID",
  2: "Weak — AVOID",
  3: "Neutral",
  4: "Good — REPLICATE",
  5: "Excellent — REPLICATE",
};

// ── Helper: draw center-cropped image ─────────────────────────────────
function drawCoverImage(ctx, img, x, y, w, h, radius) {
  ctx.save();
  ctx.beginPath();
  ctx.roundRect(x, y, w, h, radius);
  ctx.clip();

  if (img.complete && img.naturalWidth > 0) {
    const imgW = img.naturalWidth;
    const imgH = img.naturalHeight;
    const imgRatio = imgW / imgH;
    const boxRatio = w / h;
    let sx, sy, sw, sh;
    if (imgRatio > boxRatio) {
      sh = imgH;
      sw = imgH * boxRatio;
      sx = (imgW - sw) / 2;
      sy = 0;
    } else {
      sw = imgW;
      sh = imgW / boxRatio;
      sx = 0;
      sy = (imgH - sh) / 2;
    }
    ctx.drawImage(img, sx, sy, sw, sh, x, y, w, h);
  } else {
    // Loading placeholder
    ctx.fillStyle = "#0d1117";
    ctx.fillRect(x, y, w, h);
    // Spinner dots
    const dotCount = 3;
    const phase = (Date.now() / 400) % dotCount;
    for (let d = 0; d < dotCount; d++) {
      ctx.fillStyle = d === Math.floor(phase) ? "#475569" : "#1e293b";
      ctx.beginPath();
      ctx.arc(x + w/2 - 10 + d * 10, y + h/2, 2.5, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  ctx.restore();

  // Border
  ctx.strokeStyle = "#334155";
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.roundRect(x, y, w, h, radius);
  ctx.stroke();
}

// ── Extension ─────────────────────────────────────────────────────────
app.registerExtension({
  name: "session.FeedbackEditor",

  async setup() {
    // Listen for websocket messages from the backend (during execution)
    api.addEventListener("session_feedback_update", (event) => {
      const data = event.detail;
      const nodeId = data.node_id;
      const nodes = app.graph._nodes;
      for (const node of nodes) {
        if (String(node.id) === String(nodeId) && node._fb_onUpdate) {
          node._fb_onUpdate(data);
          break;
        }
      }
    });
  },

  async beforeRegisterNodeDef(nodeType, nodeData, _app) {
    // ── Session Feedback Editor ─────────────────────────────────────
    if (nodeData.name === "SessionFeedbackEditor") {
      const onNodeCreated = nodeType.prototype.onNodeCreated;

      nodeType.prototype.onNodeCreated = function () {
        if (onNodeCreated) onNodeCreated.apply(this, arguments);

        // ── Internal state ──
        this._fb = {
          sessionId:   "default",
          runCount:    0,
          selectedRun: 0,
          prompts:     [],       // [{number, concept}]
          ratings:     {},       // {promptNum: 0-5}
          notes:       {},       // {promptNum: string}
          waiting:     false,
          saveFlash:   0,
          hitAreas:    null,
          hoverBtn:    false,
          thumbnails:  {},       // {promptNum: [Image(), ...]}
          thumbsLoading: 0,
        };

        // Force minimum width
        if (this.size[0] < NODE_MIN_W) this.size[0] = NODE_MIN_W;

        // ── Custom feedback panel widget ──
        const node = this;
        this.addCustomWidget({
          name: "feedback_panel",
          type: "custom",
          value: "",
          computeSize: () => {
            const n = node._fb.prompts.length;
            if (n === 0) return [NODE_MIN_W, 80];

            let totalH = 48; // run nav row
            for (let i = 0; i < n; i++) {
              const pNum = String(node._fb.prompts[i].number);
              const thumbs = (node._fb.thumbnails && node._fb.thumbnails[pNum]) || [];
              const cardW = NODE_MIN_W - 28;
              const availW = cardW - 20;
              const perRow = Math.max(1, Math.floor(availW / (THUMB_SIZE + THUMB_GAP)));
              const thumbRows = thumbs.length > 0 ? Math.ceil(thumbs.length / perRow) : 0;
              const thumbH = thumbRows > 0 ? thumbRows * (THUMB_SIZE + THUMB_GAP) + 6 : 0;
              totalH += 90 + thumbH + 8; // card base + thumbs + gap
            }
            totalH += 56; // save button + padding
            return [NODE_MIN_W, totalH];
          },
          draw: (ctx, _node, width, posY, height) => {
            node._fb_drawPanel(ctx, width, posY, height);
          },
          mouse: (event, pos, _node) => {
            return node._fb_handleMouse(event, pos);
          },
          serialize: false,
        });

        // Initial load after widgets settle
        setTimeout(() => this._fb_loadRun(), 400);
      };

      // ── React to session_id widget changes ──
      const onWidgetChanged = nodeType.prototype.onWidgetChanged;
      nodeType.prototype.onWidgetChanged = function (widget) {
        if (onWidgetChanged) onWidgetChanged.apply(this, arguments);
        if (widget.name === "session_id") {
          this._fb.sessionId = widget.value;
          this._fb_loadRun();
        }
      };

      // ── Websocket update handler ──
      nodeType.prototype._fb_onUpdate = function (data) {
        this._fb.sessionId   = data.session_id;
        this._fb.runCount    = data.run_count;
        this._fb.selectedRun = data.selected_run;
        this._fb.prompts     = data.prompts || [];
        this._fb.waiting     = data.mode === "blocking";

        this._fb.ratings = {};
        this._fb.notes   = {};
        const fb = data.feedback || {};
        for (const [k, v] of Object.entries(fb)) {
          this._fb.ratings[k] = v.rating || 0;
          this._fb.notes[k]   = v.notes  || "";
        }

        // Load thumbnails for the new run
        this._fb_loadThumbnails();

        this.setDirtyCanvas(true);
        app.graph.setDirtyCanvas(true, true);
      };

      // ── Load run data from REST API ──
      nodeType.prototype._fb_loadRun = function (runNumber) {
        const w = this.widgets?.find(w => w.name === "session_id");
        const sid = w?.value || "default";
        this._fb.sessionId = sid;

        const rp = runNumber ? `&run_number=${runNumber}` : "";
        fetch(`/session_feedback/load?session_id=${encodeURIComponent(sid)}${rp}`)
          .then(r => r.json())
          .then(data => {
            this._fb.runCount    = data.run_count || 0;
            this._fb.selectedRun = data.selected_run || 0;
            this._fb.prompts     = data.prompts || [];

            this._fb.ratings = {};
            this._fb.notes   = {};
            const fb = data.feedback || {};
            for (const [k, v] of Object.entries(fb)) {
              this._fb.ratings[k] = v.rating || 0;
              this._fb.notes[k]   = v.notes  || "";
            }

            // Load thumbnails for this run
            this._fb_loadThumbnails();

            this.setDirtyCanvas(true);
            app.graph.setDirtyCanvas(true, true);
          })
          .catch(err => console.error("[Feedback] Load error:", err));
      };

      // ── Load thumbnail images ──
      nodeType.prototype._fb_loadThumbnails = function () {
        const sid = this._fb.sessionId;
        const run = this._fb.selectedRun;
        if (!run || run === 0) {
          this._fb.thumbnails = {};
          return;
        }

        fetch(`/session_feedback/thumbnails?session_id=${encodeURIComponent(sid)}&run_number=${run}`)
          .then(r => r.json())
          .then(data => {
            // data = { "1": ["/session_feedback/thumb?path=..."], ... }
            this._fb.thumbnails = {};
            this._fb.thumbsLoading = 0;

            for (const [pNum, urls] of Object.entries(data)) {
              this._fb.thumbnails[pNum] = urls.map(url => {
                const img = new Image();
                this._fb.thumbsLoading++;
                img.onload = () => {
                  this._fb.thumbsLoading--;
                  this.setDirtyCanvas(true);
                  if (this._fb.thumbsLoading <= 0) {
                    // All loaded — recalculate node size
                    requestAnimationFrame(() => {
                      this.setSize(this.computeSize());
                      app.graph.setDirtyCanvas(true, true);
                    });
                  }
                };
                img.onerror = () => {
                  this._fb.thumbsLoading--;
                };
                img.src = url;
                return img;
              });
            }

            // Recalculate size for known thumb count
            this.setSize(this.computeSize());
            this.setDirtyCanvas(true);
            app.graph.setDirtyCanvas(true, true);
          })
          .catch(err => console.error("[Feedback] Thumbnail load error:", err));
      };

      // ── Save feedback via REST API ──
      nodeType.prototype._fb_saveFeedback = function () {
        if (this._fb.selectedRun === 0) return;

        const prompts = {};
        for (const p of this._fb.prompts) {
          const k = String(p.number);
          prompts[k] = {
            rating: this._fb.ratings[k] || 0,
            notes:  this._fb.notes[k]   || "",
          };
        }

        fetch("/session_feedback/save", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            session_id: this._fb.sessionId,
            run_number: this._fb.selectedRun,
            prompts,
          }),
        })
          .then(() => {
            this._fb.saveFlash = Date.now();
            this.setDirtyCanvas(true);

            if (this._fb.waiting) {
              fetch("/session_feedback/resume", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ node_id: String(this.id) }),
              })
                .then(() => {
                  this._fb.waiting = false;
                  this.setDirtyCanvas(true);
                })
                .catch(err => console.error("[Feedback] Resume error:", err));
            }
          })
          .catch(err => console.error("[Feedback] Save error:", err));
      };

      // ── Draw the entire feedback panel ──
      nodeType.prototype._fb_drawPanel = function (ctx, width, posY, height) {
        const pad  = 14;
        const inW  = width - pad * 2;
        let curY   = posY + 6;
        const fb   = this._fb;

        ctx.save();

        // ── Empty state ──
        if (fb.runCount === 0) {
          ctx.fillStyle = GREY;
          ctx.font = "italic 12px Inter, Arial, sans-serif";
          ctx.textBaseline = "middle";
          ctx.fillText("No runs in this session.", pad, curY + 30);
          ctx.restore();
          return;
        }

        // ── Blocking status bar ──
        if (fb.waiting) {
          const barH = 26;
          ctx.fillStyle = "#451a03";
          ctx.beginPath();
          ctx.roundRect(pad - 4, curY, inW + 8, barH, 5);
          ctx.fill();
          const pulse = 0.6 + 0.4 * Math.sin(Date.now() / 300);
          ctx.globalAlpha = pulse;
          ctx.fillStyle = BTN_WAIT_BG;
          ctx.font = "bold 11px Inter, Arial, sans-serif";
          ctx.textBaseline = "middle";
          ctx.fillText("⏸  Workflow paused — add feedback and click Save", pad + 6, curY + 13);
          ctx.globalAlpha = 1.0;
          curY += barH + 4;
          requestAnimationFrame(() => this.setDirtyCanvas(true));
        }

        // ── Run selector row ──
        fb.hitAreas = { leftArrow: null, rightArrow: null, stars: [], notes: [], saveBtn: null };

        ctx.fillStyle = LABEL_COLOR;
        ctx.font = "bold 12px Inter, Arial, sans-serif";
        ctx.textBaseline = "middle";
        ctx.fillText("Run:", pad, curY + 14);

        const aY = curY + 4;
        const aH = 22;
        const leftX  = pad + 35;
        const labelX = leftX + 26;
        const rightX = labelX + 80;

        // Left arrow
        ctx.fillStyle = fb.selectedRun > 1 ? TEXT_COLOR : "#333";
        ctx.font = "bold 16px Inter, Arial, sans-serif";
        ctx.fillText("◀", leftX + 2, curY + 14);
        fb.hitAreas.leftArrow = { x: leftX, y: aY, w: 24, h: aH };

        // Run label
        ctx.fillStyle = "#fff";
        ctx.font = "bold 13px Inter, Arial, sans-serif";
        ctx.fillText(`Run ${fb.selectedRun} / ${fb.runCount}`, labelX + 2, curY + 14);

        // Right arrow
        ctx.fillStyle = fb.selectedRun < fb.runCount ? TEXT_COLOR : "#333";
        ctx.font = "bold 16px Inter, Arial, sans-serif";
        ctx.fillText("▶", rightX + 2, curY + 14);
        fb.hitAreas.rightArrow = { x: rightX, y: aY, w: 24, h: aH };

        curY += 38;

        // ── Prompt cards ──
        for (let i = 0; i < fb.prompts.length; i++) {
          const prompt = fb.prompts[i];
          const pNum   = String(prompt.number);
          const rating = fb.ratings[pNum] || 0;
          const notes  = fb.notes[pNum]   || "";
          const thumbs = (fb.thumbnails && fb.thumbnails[pNum]) || [];

          const cX = pad - 4;
          const cW = inW + 8;

          // Compute thumbnail area height
          const availW = cW - 20;
          const perRow = Math.max(1, Math.floor(availW / (THUMB_SIZE + THUMB_GAP)));
          const thumbRows = thumbs.length > 0 ? Math.ceil(thumbs.length / perRow) : 0;
          const thumbAreaH = thumbRows > 0 ? thumbRows * (THUMB_SIZE + THUMB_GAP) + 6 : 0;

          const cH = 90 + thumbAreaH;

          // Card bg
          ctx.fillStyle = CARD_BG;
          ctx.strokeStyle = CARD_BORDER;
          ctx.lineWidth = 1;
          ctx.beginPath();
          ctx.roundRect(cX, curY, cW, cH, 6);
          ctx.fill();
          ctx.stroke();

          // Prompt label
          ctx.fillStyle = CONCEPT_CLR;
          ctx.font = "bold 11px Inter, Arial, sans-serif";
          let label = `\ud83d\udccb Prompt ${pNum}: ${prompt.concept}`;
          const maxW = cW - 16;
          while (ctx.measureText(label).width > maxW && label.length > 20) {
            label = label.slice(0, -4) + "\u2026";
          }
          ctx.fillText(label, cX + 10, curY + 16);

          // ── Thumbnails ──
          if (thumbs.length > 0) {
            const tStartY = curY + 26;
            let tX = cX + 10;
            let tY = tStartY;
            let col = 0;

            for (let t = 0; t < thumbs.length; t++) {
              drawCoverImage(ctx, thumbs[t], tX, tY, THUMB_SIZE, THUMB_SIZE, THUMB_RADIUS);
              col++;
              if (col >= perRow) {
                col = 0;
                tX = cX + 10;
                tY += THUMB_SIZE + THUMB_GAP;
              } else {
                tX += THUMB_SIZE + THUMB_GAP;
              }
            }

            // Request redraws while images are loading (for spinners)
            if (fb.thumbsLoading > 0) {
              requestAnimationFrame(() => this.setDirtyCanvas(true));
            }
          }

          // Stars (offset by thumbnail area)
          const sY = curY + 28 + thumbAreaH;
          const sSize = 18;
          const sSpc = 23;
          const sX = cX + 10;

          fb.hitAreas.stars[i] = [];
          for (let s = 0; s < STAR_COUNT; s++) {
            const filled = s < rating;
            ctx.fillStyle = filled ? GOLD : GREY;
            ctx.font = `${sSize}px Inter, Arial, sans-serif`;
            ctx.fillText(filled ? STAR_FILLED : STAR_EMPTY, sX + s * sSpc, sY + 14);
            fb.hitAreas.stars[i][s] = {
              x: sX + s * sSpc - 2, y: sY, w: sSpc, h: 22,
              promptNum: pNum, starIdx: s,
            };
          }

          // Rating label
          if (rating > 0) {
            ctx.fillStyle = rating <= 2 ? AVOID_CLR : rating >= 4 ? REPLICATE_CLR : LABEL_COLOR;
            ctx.font = "10px Inter, Arial, sans-serif";
            ctx.fillText(RATING_LABELS[rating], sX + STAR_COUNT * sSpc + 6, sY + 12);
          }

          // Notes area
          const nY = sY + 26;
          const nH = 24;
          const nW = cW - 20;

          ctx.fillStyle = NOTES_BG;
          ctx.strokeStyle = NOTES_BORDER;
          ctx.lineWidth = 0.5;
          ctx.beginPath();
          ctx.roundRect(cX + 10, nY, nW, nH, 4);
          ctx.fill();
          ctx.stroke();

          ctx.font = "11px Inter, Arial, sans-serif";
          if (notes) {
            ctx.fillStyle = TEXT_COLOR;
            let display = notes;
            while (ctx.measureText(display).width > nW - 16 && display.length > 5) {
              display = display.slice(0, -4) + "\u2026";
            }
            ctx.fillText(display, cX + 16, nY + 15);
          } else {
            ctx.fillStyle = "#475569";
            ctx.fillText("Click to add notes\u2026", cX + 16, nY + 15);
          }

          fb.hitAreas.notes[i] = { x: cX + 10, y: nY, w: nW, h: nH, promptNum: pNum };
          curY += cH + 8;
        }

        // ── Save button ──
        const btnW = inW + 8;
        const btnH = 34;
        const btnX = pad - 4;
        const btnY = curY + 2;

        const flashActive = (Date.now() - fb.saveFlash) < 1500;
        let btnBg, btnText;

        if (flashActive) {
          btnBg   = BTN_DONE_BG;
          btnText = "\u2705  Saved";
        } else if (fb.waiting) {
          btnBg   = fb.hoverBtn ? BTN_WAIT_HV : BTN_WAIT_BG;
          btnText = "\ud83d\udcbe  Save & Continue  \u25b6";
        } else {
          btnBg   = fb.hoverBtn ? BTN_SAVE_HV : BTN_SAVE_BG;
          btnText = "\ud83d\udcbe  Save Feedback";
        }

        ctx.shadowColor  = "rgba(0,0,0,0.3)";
        ctx.shadowBlur   = 6;
        ctx.shadowOffsetY = 2;

        ctx.fillStyle = btnBg;
        ctx.beginPath();
        ctx.roundRect(btnX, btnY, btnW, btnH, 8);
        ctx.fill();

        ctx.shadowColor = "transparent";
        ctx.shadowBlur  = 0;
        ctx.shadowOffsetY = 0;

        ctx.fillStyle = "#fff";
        ctx.font = "bold 13px Inter, Arial, sans-serif";
        ctx.textBaseline = "middle";
        const tw = ctx.measureText(btnText).width;
        ctx.fillText(btnText, btnX + (btnW - tw) / 2, btnY + btnH / 2);

        fb.hitAreas.saveBtn = { x: btnX, y: btnY, w: btnW, h: btnH };

        if (flashActive) {
          requestAnimationFrame(() => this.setDirtyCanvas(true));
        }

        ctx.restore();
      };

      // ── Handle mouse events ──
      nodeType.prototype._fb_handleMouse = function (event, pos) {
        const fb = this._fb;
        if (!fb.hitAreas) return false;

        const [mx, my] = pos;
        const hit = (r) => r && mx >= r.x && mx <= r.x + r.w && my >= r.y && my <= r.y + r.h;

        // Hover tracking for save button
        if (event.type === "pointermove" || event.type === "mousemove") {
          const wasHover = fb.hoverBtn;
          fb.hoverBtn = hit(fb.hitAreas.saveBtn);
          if (wasHover !== fb.hoverBtn) this.setDirtyCanvas(true);
          return false;
        }

        // Only process clicks
        const isClick = event.type === "pointerdown" ||
                        event.type === (LiteGraph.pointerevents_method + "down");
        if (!isClick) return false;

        // ── Arrow clicks ──
        if (hit(fb.hitAreas.leftArrow) && fb.selectedRun > 1) {
          this._fb_loadRun(fb.selectedRun - 1);
          return true;
        }
        if (hit(fb.hitAreas.rightArrow) && fb.selectedRun < fb.runCount) {
          this._fb_loadRun(fb.selectedRun + 1);
          return true;
        }

        // ── Star clicks ──
        for (const promptStars of fb.hitAreas.stars) {
          if (!promptStars) continue;
          for (const s of promptStars) {
            if (!s || !hit(s)) continue;
            const newR = s.starIdx + 1;
            fb.ratings[s.promptNum] = fb.ratings[s.promptNum] === newR ? 0 : newR;
            this.setDirtyCanvas(true);
            return true;
          }
        }

        // ── Notes clicks ──
        for (const n of fb.hitAreas.notes) {
          if (!n || !hit(n)) continue;
          const pNum    = n.promptNum;
          const current = fb.notes[pNum] || "";
          const info    = fb.prompts.find(p => String(p.number) === pNum);
          const concept = info?.concept || `Prompt ${pNum}`;

          const result = prompt(
            `\ud83d\udcdd Notes for Prompt ${pNum}: ${concept}`,
            current
          );
          if (result !== null) {
            fb.notes[pNum] = result;
            this.setDirtyCanvas(true);
          }
          return true;
        }

        // ── Save button click ──
        if (hit(fb.hitAreas.saveBtn)) {
          this._fb_saveFeedback();
          return true;
        }

        return false;
      };
    }

    // ── Session Memory Reader — reset confirmation popup ──────────────
    if (nodeData.name === "SessionMemoryReader") {
      const origOnWidgetChanged = nodeType.prototype.onWidgetChanged;

      nodeType.prototype.onWidgetChanged = function (widget) {
        // Intercept reset_session toggle
        if (widget?.name === "reset_session" && widget.value === true) {
          const confirmed = window.confirm(
            "⚠️ Reset session?\n\n" +
            "ALL data will be permanently deleted:\n" +
            "• Run history\n" +
            "• Feedback & ratings\n" +
            "• All thumbnail images\n\n" +
            "This action cannot be undone."
          );
          if (!confirmed) {
            widget.value = false;
            this.setDirtyCanvas(true);
            return;
          }
        }

        if (origOnWidgetChanged) origOnWidgetChanged.apply(this, arguments);
      };
    }
  },
});
