import { app } from "../../scripts/app.js";
import { api } from "../../scripts/api.js";

/**
 * ⭐ Session Feedback Editor — Frontend Extension
 *
 * Features:
 *   - Star ratings (1-5) per prompt
 *   - Inline multiline textarea for notes (no modal)
 *   - Collapsible prompt header with full prompt text
 *   - Thumbnail previews — full aspect ratio, no square cropping
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
const NODE_MIN_W   = 420;

// Thumbnail constants — full aspect ratio, no fixed square
const THUMB_MAX_H  = 160;  // max height per thumbnail row
const THUMB_GAP    = 8;    // gap between thumbnails

const RATING_LABELS = {
  0: "",
  1: "Poor — AVOID",
  2: "Weak — AVOID",
  3: "Neutral",
  4: "Good — REPLICATE",
  5: "Excellent — REPLICATE",
};

// ── Helper: draw full-aspect-ratio image ──────────────────────────────
function drawFullImage(ctx, img, x, y, maxW, maxH, radius) {
  if (!img.complete || img.naturalWidth === 0) {
    // Loading placeholder
    ctx.save();
    ctx.fillStyle = "#0d1117";
    ctx.beginPath();
    ctx.roundRect(x, y, maxW, 40, radius);
    ctx.fill();
    // Spinner dots
    const dotCount = 3;
    const phase = (Date.now() / 400) % dotCount;
    for (let d = 0; d < dotCount; d++) {
      ctx.fillStyle = d === Math.floor(phase) ? "#475569" : "#1e293b";
      ctx.beginPath();
      ctx.arc(x + maxW / 2 - 10 + d * 10, y + 20, 2.5, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.restore();
    return 40;
  }

  const iW = img.naturalWidth;
  const iH = img.naturalHeight;
  const scale = Math.min(maxW / iW, maxH / iH);
  const dW = Math.round(iW * scale);
  const dH = Math.round(iH * scale);

  ctx.save();
  ctx.beginPath();
  ctx.roundRect(x, y, dW, dH, radius);
  ctx.clip();
  ctx.drawImage(img, x, y, dW, dH);
  ctx.restore();

  // Border
  ctx.strokeStyle = "#334155";
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.roundRect(x, y, dW, dH, radius);
  ctx.stroke();

  return dH;
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
          sessionId:    "default",
          runCount:     0,
          selectedRun:  0,
          prompts:      [],       // [{number, concept, fullText}]
          ratings:      {},       // {promptNum: 0-5}
          notes:        {},       // {promptNum: string}
          waiting:      false,
          saveFlash:    0,
          hitAreas:     null,
          hoverBtn:     false,
          thumbnails:   {},       // {promptNum: [Image(), ...]}
          thumbsLoading: 0,
          collapsed:    {},       // {promptNum: bool} — false = expanded
          activeTextarea: null,   // currently open textarea overlay
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

            const cardW = node.size[0] - 28;
            const availW = cardW - 20;

            let totalH = 48; // run nav row
            for (let i = 0; i < n; i++) {
              const pNum = String(node._fb.prompts[i].number);
              const collapsed = node._fb.collapsed[pNum] !== false; // default collapsed
              const thumbs = (node._fb.thumbnails && node._fb.thumbnails[pNum]) || [];

              // Header row height
              let cardH = 34; // header

              if (!collapsed) {
                // Full prompt text block
                const fullText = node._fb.prompts[i].fullText || "";
                if (fullText) {
                  const lineH = 14;
                  const charsPerLine = Math.max(10, Math.floor(availW / 6.5));
                  const lines = Math.ceil(fullText.length / charsPerLine);
                  cardH += 8 + lines * lineH + 8;
                }
              }

              // Thumbnails (full aspect ratio — estimate height as THUMB_MAX_H each row)
              if (thumbs.length > 0 && !collapsed) {
                // Each thumb side by side, row wraps when out of space
                // We calculate actual thumb heights when drawing — estimate here
                const thumbEstH = THUMB_MAX_H + THUMB_GAP;
                const thumbsPerRow = Math.max(1, Math.floor(availW / (availW / thumbs.length + THUMB_GAP)));
                const rows = Math.ceil(thumbs.length / thumbsPerRow);
                cardH += rows * thumbEstH + 8;
              }

              // Stars + rating label
              cardH += 30;
              // Notes textarea
              cardH += 72; // 3-line textarea
              // gap
              totalH += cardH + 10;
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

        // Cleanup textarea on node removal
        const origOnRemoved = nodeType.prototype.onRemoved;
        this.onRemoved = function () {
          this._fb_removeTextarea();
          if (origOnRemoved) origOnRemoved.apply(this, arguments);
        };
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
                    requestAnimationFrame(() => {
                      this.setSize(this.computeSize());
                      app.graph.setDirtyCanvas(true, true);
                    });
                  }
                };
                img.onerror = () => { this._fb.thumbsLoading--; };
                img.src = url;
                return img;
              });
            }

            this.setSize(this.computeSize());
            this.setDirtyCanvas(true);
            app.graph.setDirtyCanvas(true, true);
          })
          .catch(err => console.error("[Feedback] Thumbnail load error:", err));
      };

      // ── Textarea overlay helpers ──
      nodeType.prototype._fb_removeTextarea = function () {
        if (this._fb.activeTextarea) {
          this._fb.activeTextarea.remove();
          this._fb.activeTextarea = null;
        }
      };

      nodeType.prototype._fb_openTextarea = function (promptNum, canvasRect, areaRect) {
        // Remove any existing textarea
        this._fb_removeTextarea();

        const canvas = app.canvas.canvas;
        const canvasBounds = canvas.getBoundingClientRect();
        const scale = app.canvas.ds.scale;

        // Convert canvas-space coords to screen coords
        const toScreen = (cx, cy) => {
          const sx = canvasBounds.left + (cx - app.canvas.ds.offset[0]) * scale;
          const sy = canvasBounds.top  + (cy - app.canvas.ds.offset[1]) * scale;
          return [sx, sy];
        };

        const [sx, sy] = toScreen(areaRect.x, areaRect.y);
        const sw = areaRect.w * scale;
        const sh = areaRect.h * scale;

        const ta = document.createElement("textarea");
        ta.value = this._fb.notes[promptNum] || "";
        ta.placeholder = "Add notes…";
        ta.style.cssText = `
          position: fixed;
          left: ${sx}px;
          top: ${sy}px;
          width: ${sw}px;
          height: ${sh}px;
          background: #1e293b;
          color: #e0e0e0;
          border: 1px solid #334155;
          border-radius: 5px;
          padding: 6px 8px;
          font: 11px Inter, Arial, sans-serif;
          resize: none;
          z-index: 9999;
          outline: 2px solid #2563eb;
          box-sizing: border-box;
          line-height: 1.5;
        `;

        const node = this;
        ta.addEventListener("input", () => {
          node._fb.notes[promptNum] = ta.value;
          node.setDirtyCanvas(true);
        });

        ta.addEventListener("blur", () => {
          node._fb.notes[promptNum] = ta.value;
          node._fb_removeTextarea();
          node.setDirtyCanvas(true);
        });

        ta.addEventListener("keydown", (e) => {
          // Ctrl+Enter or Escape to close
          if (e.key === "Escape" || (e.key === "Enter" && e.ctrlKey)) {
            ta.blur();
          }
          e.stopPropagation();
        });

        document.body.appendChild(ta);
        this._fb.activeTextarea = ta;

        // Position and focus
        requestAnimationFrame(() => {
          ta.focus();
          ta.setSelectionRange(ta.value.length, ta.value.length);
        });
      };

      // ── Save feedback via REST API ──
      nodeType.prototype._fb_saveFeedback = function () {
        if (this._fb.selectedRun === 0) return;

        // Commit textarea if open
        if (this._fb.activeTextarea) {
          this._fb.activeTextarea.blur();
        }

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
        fb.hitAreas = {
          leftArrow: null,
          rightArrow: null,
          stars: [],
          headers: [],    // toggle hit areas
          notes: [],
          saveBtn: null
        };

        ctx.fillStyle = LABEL_COLOR;
        ctx.font = "bold 12px Inter, Arial, sans-serif";
        ctx.textBaseline = "middle";
        ctx.fillText("Run:", pad, curY + 14);

        const aY = curY + 4;
        const aH = 22;
        const leftX  = pad + 35;
        const labelX = leftX + 26;
        const rightX = labelX + 80;

        ctx.fillStyle = fb.selectedRun > 1 ? TEXT_COLOR : "#333";
        ctx.font = "bold 16px Inter, Arial, sans-serif";
        ctx.fillText("◀", leftX + 2, curY + 14);
        fb.hitAreas.leftArrow = { x: leftX, y: aY, w: 24, h: aH };

        ctx.fillStyle = "#fff";
        ctx.font = "bold 13px Inter, Arial, sans-serif";
        ctx.fillText(`Run ${fb.selectedRun} / ${fb.runCount}`, labelX + 2, curY + 14);

        ctx.fillStyle = fb.selectedRun < fb.runCount ? TEXT_COLOR : "#333";
        ctx.font = "bold 16px Inter, Arial, sans-serif";
        ctx.fillText("▶", rightX + 2, curY + 14);
        fb.hitAreas.rightArrow = { x: rightX, y: aY, w: 24, h: aH };

        curY += 38;

        // ── Prompt cards ──
        for (let i = 0; i < fb.prompts.length; i++) {
          const prompt  = fb.prompts[i];
          const pNum    = String(prompt.number);
          const rating  = fb.ratings[pNum] || 0;
          const notes   = fb.notes[pNum]   || "";
          const thumbs  = (fb.thumbnails && fb.thumbnails[pNum]) || [];
          const collapsed = fb.collapsed[pNum] !== false; // default collapsed

          const cX = pad - 4;
          const cW = inW + 8;
          const availW = cW - 20;

          // ── Measure card height ──
          let cardH = 34; // header row

          // Full text block
          let fullTextLines = [];
          if (!collapsed && prompt.fullText) {
            const maxCharsPerLine = Math.max(10, Math.floor(availW / 6.5));
            // Word-wrap
            const words = prompt.fullText.split(" ");
            let line = "";
            for (const word of words) {
              const test = line ? line + " " + word : word;
              if (test.length > maxCharsPerLine && line) {
                fullTextLines.push(line);
                line = word;
              } else {
                line = test;
              }
            }
            if (line) fullTextLines.push(line);
            if (fullTextLines.length > 0) {
              cardH += 10 + fullTextLines.length * 14 + 8;
            }
          }

          // Thumbnail area
          let thumbRowsData = []; // array of {imgs, heights}
          if (thumbs.length > 0 && !collapsed) {
            // Lay out thumbs side by side, scale to THUMB_MAX_H
            let rowImgs = [];
            let rowW = 0;
            for (const img of thumbs) {
              if (!img.complete || img.naturalWidth === 0) {
                rowImgs.push(img);
                rowW += 60 + THUMB_GAP;
                if (rowW > availW) {
                  thumbRowsData.push(rowImgs);
                  rowImgs = [];
                  rowW = 0;
                }
                continue;
              }
              const scale = THUMB_MAX_H / img.naturalHeight;
              const tw = Math.round(img.naturalWidth * scale);
              if (rowImgs.length > 0 && rowW + tw + THUMB_GAP > availW) {
                thumbRowsData.push(rowImgs);
                rowImgs = [img];
                rowW = tw + THUMB_GAP;
              } else {
                rowImgs.push(img);
                rowW += tw + THUMB_GAP;
              }
            }
            if (rowImgs.length > 0) thumbRowsData.push(rowImgs);
            cardH += thumbRowsData.length * (THUMB_MAX_H + THUMB_GAP) + 8;
          }

          // Stars + rating label
          cardH += 30;
          // Notes textarea
          const NOTES_H = 62;
          cardH += NOTES_H + 8;

          // ── Card background ──
          ctx.fillStyle = CARD_BG;
          ctx.strokeStyle = CARD_BORDER;
          ctx.lineWidth = 1;
          ctx.beginPath();
          ctx.roundRect(cX, curY, cW, cardH, 6);
          ctx.fill();
          ctx.stroke();

          // ── Header row (toggle button) ──
          const chevron = collapsed ? "▶" : "▼";
          const concept = prompt.concept || `Prompt ${pNum}`;
          let headerLabel = `${chevron} 📋 Prompt ${pNum}: ${concept}`;
          const hMaxW = cW - 22;
          ctx.font = "bold 11px Inter, Arial, sans-serif";
          ctx.fillStyle = CONCEPT_CLR;
          // Truncate if too long
          while (ctx.measureText(headerLabel).width > hMaxW && headerLabel.length > 20) {
            headerLabel = headerLabel.slice(0, -4) + "…";
          }
          ctx.textBaseline = "middle";
          ctx.fillText(headerLabel, cX + 10, curY + 17);

          // Hit area for the header toggle
          fb.hitAreas.headers[i] = { x: cX, y: curY, w: cW, h: 34, promptNum: pNum };

          // Separator line under header
          ctx.strokeStyle = "#1e3a5f";
          ctx.lineWidth = 0.5;
          ctx.beginPath();
          ctx.moveTo(cX + 8, curY + 34);
          ctx.lineTo(cX + cW - 8, curY + 34);
          ctx.stroke();

          let innerY = curY + 38;

          if (!collapsed) {
            // ── Full prompt text ──
            if (fullTextLines.length > 0) {
              ctx.font = "10px 'Courier New', monospace";
              ctx.fillStyle = "#94a3b8";
              ctx.textBaseline = "top";
              for (let li = 0; li < fullTextLines.length; li++) {
                ctx.fillText(fullTextLines[li], cX + 10, innerY + li * 14);
              }
              innerY += fullTextLines.length * 14 + 10;
              ctx.textBaseline = "middle";
            }

            // ── Thumbnails (full aspect ratio) ──
            if (thumbRowsData.length > 0) {
              let tY = innerY;
              for (const rowImgs of thumbRowsData) {
                let tX = cX + 10;
                for (const img of rowImgs) {
                  if (!img.complete || img.naturalWidth === 0) {
                    // Placeholder while loading
                    ctx.fillStyle = "#0d1117";
                    ctx.beginPath();
                    ctx.roundRect(tX, tY, 60, THUMB_MAX_H, 5);
                    ctx.fill();
                    const dotCount = 3;
                    const phase = (Date.now() / 400) % dotCount;
                    for (let d = 0; d < dotCount; d++) {
                      ctx.fillStyle = d === Math.floor(phase) ? "#475569" : "#1e293b";
                      ctx.beginPath();
                      ctx.arc(tX + 30 - 10 + d * 10, tY + THUMB_MAX_H / 2, 2.5, 0, Math.PI * 2);
                      ctx.fill();
                    }
                    tX += 60 + THUMB_GAP;
                    continue;
                  }
                  const sc = THUMB_MAX_H / img.naturalHeight;
                  const tw = Math.round(img.naturalWidth * sc);
                  const th = THUMB_MAX_H;
                  ctx.save();
                  ctx.beginPath();
                  ctx.roundRect(tX, tY, tw, th, 5);
                  ctx.clip();
                  ctx.drawImage(img, tX, tY, tw, th);
                  ctx.restore();
                  ctx.strokeStyle = "#334155";
                  ctx.lineWidth = 1;
                  ctx.beginPath();
                  ctx.roundRect(tX, tY, tw, th, 5);
                  ctx.stroke();
                  tX += tw + THUMB_GAP;
                }
                tY += THUMB_MAX_H + THUMB_GAP;
              }

              innerY = tY + 4;

              if (fb.thumbsLoading > 0) {
                requestAnimationFrame(() => this.setDirtyCanvas(true));
              }
            }
          } else {
            // Collapsed — jump to after header
            innerY = curY + 38;
          }

          // ── Stars ──
          const sY = innerY;
          const sSize = 18;
          const sSpc = 23;
          const sX = cX + 10;

          fb.hitAreas.stars[i] = [];
          for (let s = 0; s < STAR_COUNT; s++) {
            const filled = s < rating;
            ctx.fillStyle = filled ? GOLD : GREY;
            ctx.font = `${sSize}px Inter, Arial, sans-serif`;
            ctx.textBaseline = "middle";
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
            ctx.textBaseline = "middle";
            ctx.fillText(RATING_LABELS[rating], sX + STAR_COUNT * sSpc + 6, sY + 12);
          }

          // ── Notes textarea placeholder (drawn on canvas) ──
          const nY = sY + 26;
          const nW = cW - 20;

          ctx.fillStyle = NOTES_BG;
          ctx.strokeStyle = NOTES_BORDER;
          ctx.lineWidth = 0.5;
          ctx.beginPath();
          ctx.roundRect(cX + 10, nY, nW, NOTES_H, 5);
          ctx.fill();
          ctx.stroke();

          // Check if the textarea overlay is open for this prompt
          const taOpen = this._fb.activeTextarea &&
                         this._fb._activeTaPrompt === pNum;

          if (!taOpen) {
            // Show content or placeholder
            ctx.font = "11px Inter, Arial, sans-serif";
            ctx.textBaseline = "top";
            if (notes) {
              ctx.fillStyle = TEXT_COLOR;
              // Render up to 4 lines
              const noteLines = notes.split("\n");
              for (let nl = 0; nl < Math.min(noteLines.length, 4); nl++) {
                let nline = noteLines[nl];
                const maxNW = nW - 16;
                while (ctx.measureText(nline).width > maxNW && nline.length > 5) {
                  nline = nline.slice(0, -4) + "…";
                }
                ctx.fillText(nline, cX + 16, nY + 8 + nl * 14);
              }
            } else {
              ctx.fillStyle = "#475569";
              ctx.fillText("Add notes…", cX + 14, nY + 8);
            }
            ctx.textBaseline = "middle";
          }

          // Hit area for the notes textarea
          fb.hitAreas.notes[i] = {
            x: cX + 10, y: nY, w: nW, h: NOTES_H,
            promptNum: pNum,
            // Store screen rect for textarea positioning
            canvasX: cX + 10, canvasY: nY,
          };

          curY += cardH + 10;
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
          btnText = "✅  Saved";
        } else if (fb.waiting) {
          btnBg   = fb.hoverBtn ? BTN_WAIT_HV : BTN_WAIT_BG;
          btnText = "💾  Save & Continue  ▶";
        } else {
          btnBg   = fb.hoverBtn ? BTN_SAVE_HV : BTN_SAVE_BG;
          btnText = "💾  Save Feedback";
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
          this._fb_removeTextarea();
          this._fb_loadRun(fb.selectedRun - 1);
          return true;
        }
        if (hit(fb.hitAreas.rightArrow) && fb.selectedRun < fb.runCount) {
          this._fb_removeTextarea();
          this._fb_loadRun(fb.selectedRun + 1);
          return true;
        }

        // ── Header toggle clicks ──
        for (const h of fb.hitAreas.headers) {
          if (!h || !hit(h)) continue;
          const pNum = h.promptNum;
          const current = fb.collapsed[pNum] !== false; // default true = collapsed
          fb.collapsed[pNum] = !current;
          this._fb_removeTextarea();
          requestAnimationFrame(() => {
            this.setSize(this.computeSize());
            app.graph.setDirtyCanvas(true, true);
          });
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

        // ── Notes clicks — open inline textarea ──
        for (const n of fb.hitAreas.notes) {
          if (!n || !hit(n)) continue;
          this._fb._activeTaPrompt = n.promptNum;
          this._fb_openTextarea(n.promptNum, null, {
            x: n.x, y: n.y,
            w: n.w, h: n.h,
          });
          this.setDirtyCanvas(true);
          return true;
        }

        // ── Save button click ──
        if (hit(fb.hitAreas.saveBtn)) {
          this._fb_saveFeedback();
          return true;
        }

        // Clicked elsewhere — close textarea
        this._fb_removeTextarea();
        return false;
      };
    }

    // ── Session Memory Reader — reset confirmation popup ──────────────
    if (nodeData.name === "SessionMemoryReader") {
      const origOnWidgetChanged = nodeType.prototype.onWidgetChanged;

      nodeType.prototype.onWidgetChanged = function (widget) {
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
