import { app } from "../../scripts/app.js";
import { api } from "../../scripts/api.js";

// ── Visual constants ──────────────────────────────────────────────────
const STAR_FILLED   = "★";
const STAR_EMPTY    = "☆";
const STAR_COUNT    = 5;
const GOLD          = "#FFD700";
const GREY          = "#555";
const CARD_BG       = "#16213e";
const CARD_BORDER   = "#0f3460";
const TEXT_COLOR    = "#e0e0e0";
const LABEL_COLOR   = "#94a3b8";
const CONCEPT_CLR   = "#7dd3fc";
const NOTES_BG      = "#1e293b";
const NOTES_BORDER  = "#334155";
const BTN_SAVE_BG   = "#2563eb";
const BTN_SAVE_HV   = "#3b82f6";
const BTN_WAIT_BG   = "#d97706";
const BTN_WAIT_HV   = "#f59e0b";
const BTN_DONE_BG   = "#16a34a";
const AVOID_CLR     = "#f87171";
const REPLICATE_CLR = "#4ade80";
const NODE_MIN_W    = 400;
const THUMB_MAX_H   = 150;
const THUMB_GAP     = 8;
const NOTES_H       = 62;
const PROMPT_FONT   = "12px 'Courier New', Consolas, monospace";
const PROMPT_LH     = 17;

const RATING_LABELS = {
  0: "", 1: "Poor — AVOID", 2: "Weak — AVOID",
  3: "Neutral", 4: "Good — REPLICATE", 5: "Excellent — REPLICATE",
};

app.registerExtension({
  name: "session.FeedbackEditor",

  async setup() {
    api.addEventListener("session_feedback_update", (event) => {
      const data = event.detail;
      for (const node of app.graph._nodes) {
        if (String(node.id) === String(data.node_id) && node._fb_onUpdate) {
          node._fb_onUpdate(data);
          break;
        }
      }
    });
  },

  async beforeRegisterNodeDef(nodeType, nodeData) {
    // ── Session Feedback Editor ───────────────────────────────────────
    if (nodeData.name === "SessionFeedbackEditor") {
      const onNodeCreated = nodeType.prototype.onNodeCreated;

      nodeType.prototype.onNodeCreated = function () {
        if (onNodeCreated) onNodeCreated.apply(this, arguments);

        this._fb = {
          sessionId: "default", runCount: 0, selectedRun: 0,
          prompts: [], ratings: {}, notes: {},
          waiting: false, saveFlash: 0,
          hitAreas: null, hoverBtn: false,
          thumbnails: {}, thumbsLoading: 0,
          collapsed: {},
          // text editing state
          _editingPrompt: null, _editingTA: null,
          _cursorVisible: true, _cursorBlink: null,
        };

        if (this.size[0] < NODE_MIN_W) this.size[0] = NODE_MIN_W;

        const node = this;
        this.addCustomWidget({
          name: "feedback_panel",
          type: "custom",
          value: "",
          computeSize: () => {
            const n = node._fb.prompts.length;
            const W = node.size[0]; // preserve user width
            if (n === 0) return [W, 80];
            const cardW = W - 20;
            const availW = cardW - 20;
            let totalH = 48;
            for (let i = 0; i < n; i++) {
              const pNum = String(node._fb.prompts[i].number);
              const collapsed = node._fb.collapsed[pNum] !== false;
              const thumbs = (node._fb.thumbnails[pNum]) || [];
              let cardH = 34; // header
              // Full prompt text (only when expanded)
              if (!collapsed) {
                const ft = node._fb.prompts[i].fullText || "";
                if (ft) {
                  const cpl = Math.max(10, Math.floor(availW / 7));
                  cardH += 10 + Math.ceil(ft.length / cpl) * PROMPT_LH + 8;
                }
              }
              // Thumbnails: always visible
              if (thumbs.length > 0) {
                // Estimate rows: pack thumbs side by side at THUMB_MAX_H
                let rowW = 0, rows = 1;
                for (const img of thumbs) {
                  const tw = img.complete && img.naturalHeight > 0
                    ? Math.round(img.naturalWidth * (THUMB_MAX_H / img.naturalHeight))
                    : 120;
                  if (rowW + tw + THUMB_GAP > availW && rowW > 0) { rows++; rowW = tw + THUMB_GAP; }
                  else rowW += tw + THUMB_GAP;
                }
                cardH += rows * (THUMB_MAX_H + THUMB_GAP) + 8;
              }
              cardH += 30 + NOTES_H + 10; // stars + notes + gap
              totalH += cardH + 10;
            }
            totalH += 56;
            return [W, totalH];
          },
          draw: (ctx, _n, width, posY) => node._fb_drawPanel(ctx, width, posY),
          mouse: (event, pos) => node._fb_handleMouse(event, pos),
          serialize: false,
        });

        setTimeout(() => this._fb_loadRun(), 400);

        this.onRemoved = () => this._fb_stopEditing();
      };

      const onWidgetChanged = nodeType.prototype.onWidgetChanged;
      nodeType.prototype.onWidgetChanged = function (widget) {
        if (onWidgetChanged) onWidgetChanged.apply(this, arguments);
        if (widget.name === "session_id") {
          this._fb.sessionId = widget.value;
          this._fb_loadRun();
        }
      };

      nodeType.prototype._fb_onUpdate = function (data) {
        this._fb.sessionId = data.session_id;
        this._fb.runCount = data.run_count;
        this._fb.selectedRun = data.selected_run;
        this._fb.prompts = data.prompts || [];
        this._fb.waiting = data.mode === "blocking";
        this._fb.ratings = {};
        this._fb.notes = {};
        for (const [k, v] of Object.entries(data.feedback || {})) {
          this._fb.ratings[k] = v.rating || 0;
          this._fb.notes[k] = v.notes || "";
        }
        this._fb_loadThumbnails();
        this.setDirtyCanvas(true);
        app.graph.setDirtyCanvas(true, true);
      };

      nodeType.prototype._fb_loadRun = function (runNumber) {
        const w = this.widgets?.find(w => w.name === "session_id");
        const sid = w?.value || "default";
        this._fb.sessionId = sid;
        const rp = runNumber ? `&run_number=${runNumber}` : "";
        fetch(`/session_feedback/load?session_id=${encodeURIComponent(sid)}${rp}`)
          .then(r => r.json())
          .then(data => {
            this._fb.runCount = data.run_count || 0;
            this._fb.selectedRun = data.selected_run || 0;
            this._fb.prompts = data.prompts || [];
            this._fb.ratings = {};
            this._fb.notes = {};
            for (const [k, v] of Object.entries(data.feedback || {})) {
              this._fb.ratings[k] = v.rating || 0;
              this._fb.notes[k] = v.notes || "";
            }
            this._fb_loadThumbnails();
            this.setDirtyCanvas(true);
            app.graph.setDirtyCanvas(true, true);
          })
          .catch(err => console.error("[Feedback] Load error:", err));
      };

      nodeType.prototype._fb_loadThumbnails = function () {
        const sid = this._fb.sessionId;
        const run = this._fb.selectedRun;
        if (!run) { this._fb.thumbnails = {}; return; }
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
                  if (this._fb.thumbsLoading <= 0) {
                    requestAnimationFrame(() => {
                      this.setSize([this.size[0], this.computeSize()[1]]);
                      app.graph.setDirtyCanvas(true, true);
                    });
                  } else { this.setDirtyCanvas(true); }
                };
                img.onerror = () => { this._fb.thumbsLoading--; };
                img.src = url;
                return img;
              });
            }
            this.setSize([this.size[0], this.computeSize()[1]]);
            this.setDirtyCanvas(true);
          })
          .catch(err => console.error("[Feedback] Thumbnail load error:", err));
      };

      // ── Off-screen capture textarea (no coordinate math needed) ────
      // The textarea is invisible (-9999px) and only captures keyboard.
      // Text is rendered on the canvas, always correctly positioned.
      nodeType.prototype._fb_stopEditing = function () {
        const fb = this._fb;
        if (fb._editingTA) {
          fb.notes[fb._editingPrompt] = fb._editingTA.value;
          fb._editingTA.remove();
          fb._editingTA = null;
        }
        if (fb._cursorBlink) { clearInterval(fb._cursorBlink); fb._cursorBlink = null; }
        fb._editingPrompt = null;
        fb._cursorVisible = true;
        this.setDirtyCanvas(true);
      };

      nodeType.prototype._fb_startEditing = function (promptNum) {
        this._fb_stopEditing();
        const fb = this._fb;

        // Invisible off-screen textarea — just for keyboard input capture
        const ta = document.createElement("textarea");
        ta.style.cssText = "position:fixed;left:-9999px;top:-9999px;width:1px;height:1px;opacity:0;";
        ta.value = fb.notes[promptNum] || "";
        ta.setSelectionRange(ta.value.length, ta.value.length);

        const node = this;
        ta.addEventListener("input", () => {
          fb.notes[promptNum] = ta.value;
          node.setDirtyCanvas(true);
        });
        ta.addEventListener("keydown", (e) => {
          if (e.key === "Escape") { node._fb_stopEditing(); return; }
          e.stopPropagation();
          // force a redraw so cursor blink resets visually after each key
          fb._cursorVisible = true;
          node.setDirtyCanvas(true);
        });
        ta.addEventListener("blur", () => {
          // If canvas stole focus, refocus immediately
          setTimeout(() => {
            if (fb._editingTA === ta && document.activeElement !== ta) {
              ta.focus();
            }
          }, 30);
        });

        document.body.appendChild(ta);
        fb._editingTA = ta;
        fb._editingPrompt = promptNum;

        // Blinking cursor
        fb._cursorVisible = true;
        fb._cursorBlink = setInterval(() => {
          fb._cursorVisible = !fb._cursorVisible;
          node.setDirtyCanvas(true);
        }, 530);

        ta.focus();
        this.setDirtyCanvas(true);
      };

      // ── Save ────────────────────────────────────────────────────────
      nodeType.prototype._fb_saveFeedback = function () {
        if (this._fb.selectedRun === 0) return;
        this._fb_stopEditing();
        const prompts = {};
        for (const p of this._fb.prompts) {
          const k = String(p.number);
          prompts[k] = { rating: this._fb.ratings[k] || 0, notes: this._fb.notes[k] || "" };
        }
        fetch("/session_feedback/save", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ session_id: this._fb.sessionId, run_number: this._fb.selectedRun, prompts }),
        })
          .then(() => {
            this._fb.saveFlash = Date.now();
            this.setDirtyCanvas(true);
            if (this._fb.waiting) {
              fetch("/session_feedback/resume", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ node_id: String(this.id) }),
              }).then(() => { this._fb.waiting = false; this.setDirtyCanvas(true); });
            }
          });
      };

      // ── Draw panel ──────────────────────────────────────────────────
      nodeType.prototype._fb_drawPanel = function (ctx, width, posY) {
        const pad = 14;
        const inW = width - pad * 2;
        let curY = posY + 6;
        const fb = this._fb;

        ctx.save();

        if (fb.runCount === 0) {
          ctx.fillStyle = GREY;
          ctx.font = "italic 12px Inter, Arial, sans-serif";
          ctx.textBaseline = "middle";
          ctx.fillText("No runs in this session.", pad, curY + 30);
          ctx.restore();
          return;
        }

        // Blocking bar
        if (fb.waiting) {
          const barH = 26;
          ctx.fillStyle = "#451a03";
          ctx.beginPath(); ctx.roundRect(pad - 4, curY, inW + 8, barH, 5); ctx.fill();
          ctx.globalAlpha = 0.6 + 0.4 * Math.sin(Date.now() / 300);
          ctx.fillStyle = BTN_WAIT_BG;
          ctx.font = "bold 11px Inter, Arial, sans-serif";
          ctx.textBaseline = "middle";
          ctx.fillText("⏸  Workflow paused — add feedback and click Save", pad + 6, curY + 13);
          ctx.globalAlpha = 1;
          curY += barH + 4;
          requestAnimationFrame(() => this.setDirtyCanvas(true));
        }

        // Run navigator
        fb.hitAreas = { leftArrow: null, rightArrow: null, stars: [], headers: [], notes: [], saveBtn: null };

        ctx.fillStyle = LABEL_COLOR;
        ctx.font = "bold 12px Inter, Arial, sans-serif";
        ctx.textBaseline = "middle";
        ctx.fillText("Run:", pad, curY + 14);

        const leftX = pad + 35, labelX = leftX + 26, rightX = labelX + 80;
        ctx.fillStyle = fb.selectedRun > 1 ? TEXT_COLOR : "#333";
        ctx.font = "bold 16px Inter, Arial, sans-serif";
        ctx.fillText("◀", leftX + 2, curY + 14);
        fb.hitAreas.leftArrow = { x: leftX, y: curY + 4, w: 24, h: 22 };

        ctx.fillStyle = "#fff";
        ctx.font = "bold 13px Inter, Arial, sans-serif";
        ctx.fillText(`Run ${fb.selectedRun} / ${fb.runCount}`, labelX + 2, curY + 14);

        ctx.fillStyle = fb.selectedRun < fb.runCount ? TEXT_COLOR : "#333";
        ctx.font = "bold 16px Inter, Arial, sans-serif";
        ctx.fillText("▶", rightX + 2, curY + 14);
        fb.hitAreas.rightArrow = { x: rightX, y: curY + 4, w: 24, h: 22 };
        curY += 38;

        // Prompt cards
        for (let i = 0; i < fb.prompts.length; i++) {
          const prompt = fb.prompts[i];
          const pNum = String(prompt.number);
          const rating = fb.ratings[pNum] || 0;
          const notes = fb.notes[pNum] || "";
          const thumbs = fb.thumbnails[pNum] || [];
          const collapsed = fb.collapsed[pNum] !== false;

          const cX = pad - 4;
          const cW = inW + 8;
          const availW = cW - 20;

          // Measure prompt text lines (only when expanded)
          let promptLines = [];
          if (!collapsed && prompt.fullText) {
            const words = prompt.fullText.split(/(\s+)/);
            ctx.font = PROMPT_FONT;
            let line = "";
            for (const tok of words) {
              const test = line + tok;
              if (ctx.measureText(test).width > availW - 4 && line.trim()) {
                promptLines.push(line.trimEnd());
                line = tok.trimStart();
              } else { line = test; }
            }
            if (line.trim()) promptLines.push(line.trimEnd());
          }

          // Layout thumb rows (always visible)
          const thumbRows = [];
          if (thumbs.length > 0) {
            let row = [], rowW = 0;
            for (const img of thumbs) {
              const tw = img.complete && img.naturalHeight > 0
                ? Math.round(img.naturalWidth * (THUMB_MAX_H / img.naturalHeight))
                : 120;
              if (row.length > 0 && rowW + tw + THUMB_GAP > availW) {
                thumbRows.push(row);
                row = [img]; rowW = tw + THUMB_GAP;
              } else { row.push(img); rowW += tw + THUMB_GAP; }
            }
            if (row.length) thumbRows.push(row);
          }

          // Compute card height
          let cardH = 34; // header
          if (promptLines.length > 0) cardH += 10 + promptLines.length * PROMPT_LH + 8;
          if (thumbRows.length > 0) cardH += thumbRows.length * (THUMB_MAX_H + THUMB_GAP) + 8;
          cardH += 30 + NOTES_H + 10;

          // Card bg
          ctx.fillStyle = CARD_BG;
          ctx.strokeStyle = CARD_BORDER;
          ctx.lineWidth = 1;
          ctx.beginPath(); ctx.roundRect(cX, curY, cW, cardH, 6); ctx.fill(); ctx.stroke();

          // Header (toggle)
          const chevron = collapsed ? "▶" : "▼";
          ctx.font = "bold 11px Inter, Arial, sans-serif";
          ctx.fillStyle = CONCEPT_CLR;
          ctx.textBaseline = "middle";
          let headerLabel = `${chevron} 📋 Prompt ${pNum}: ${prompt.concept || ""}`;
          while (ctx.measureText(headerLabel).width > cW - 22 && headerLabel.length > 20)
            headerLabel = headerLabel.slice(0, -4) + "…";
          ctx.fillText(headerLabel, cX + 10, curY + 17);
          fb.hitAreas.headers[i] = { x: cX, y: curY, w: cW, h: 34, promptNum: pNum };

          // Separator
          ctx.strokeStyle = "#1e3a5f"; ctx.lineWidth = 0.5;
          ctx.beginPath(); ctx.moveTo(cX + 8, curY + 34); ctx.lineTo(cX + cW - 8, curY + 34); ctx.stroke();

          let innerY = curY + 38;

          // Full prompt text (only when expanded)
          if (promptLines.length > 0) {
            ctx.font = PROMPT_FONT;
            ctx.fillStyle = "#94a3b8";
            ctx.textBaseline = "top";
            for (let li = 0; li < promptLines.length; li++)
              ctx.fillText(promptLines[li], cX + 10, innerY + li * PROMPT_LH);
            innerY += promptLines.length * PROMPT_LH + 10;
            ctx.textBaseline = "middle";
          }

          // Thumbnails — ALWAYS VISIBLE
          if (thumbRows.length > 0) {
            let tY = innerY;
            for (const row of thumbRows) {
              let tX = cX + 10;
              for (const img of row) {
                if (!img.complete || img.naturalWidth === 0) {
                  // Placeholder
                  ctx.fillStyle = "#0d1117";
                  ctx.beginPath(); ctx.roundRect(tX, tY, 120, THUMB_MAX_H, 5); ctx.fill();
                  const phase = (Date.now() / 400) % 3;
                  for (let d = 0; d < 3; d++) {
                    ctx.fillStyle = d === Math.floor(phase) ? "#475569" : "#1e293b";
                    ctx.beginPath(); ctx.arc(tX + 60 - 10 + d * 10, tY + THUMB_MAX_H / 2, 2.5, 0, Math.PI * 2); ctx.fill();
                  }
                  tX += 120 + THUMB_GAP;
                  continue;
                }
                const tw = Math.round(img.naturalWidth * (THUMB_MAX_H / img.naturalHeight));
                ctx.save();
                ctx.beginPath(); ctx.roundRect(tX, tY, tw, THUMB_MAX_H, 5); ctx.clip();
                ctx.drawImage(img, tX, tY, tw, THUMB_MAX_H);
                ctx.restore();
                ctx.strokeStyle = "#334155"; ctx.lineWidth = 1;
                ctx.beginPath(); ctx.roundRect(tX, tY, tw, THUMB_MAX_H, 5); ctx.stroke();
                tX += tw + THUMB_GAP;
              }
              tY += THUMB_MAX_H + THUMB_GAP;
            }
            innerY = tY + 4;
            if (fb.thumbsLoading > 0) requestAnimationFrame(() => this.setDirtyCanvas(true));
          }

          // Stars
          const sX = cX + 10, sY = innerY;
          const sSpc = 23, sSize = 18;
          fb.hitAreas.stars[i] = [];
          for (let s = 0; s < STAR_COUNT; s++) {
            ctx.fillStyle = s < rating ? GOLD : GREY;
            ctx.font = `${sSize}px Inter, Arial, sans-serif`;
            ctx.textBaseline = "middle";
            ctx.fillText(s < rating ? STAR_FILLED : STAR_EMPTY, sX + s * sSpc, sY + 14);
            fb.hitAreas.stars[i][s] = { x: sX + s * sSpc - 2, y: sY, w: sSpc, h: 22, promptNum: pNum, starIdx: s };
          }
          if (rating > 0) {
            ctx.fillStyle = rating <= 2 ? AVOID_CLR : rating >= 4 ? REPLICATE_CLR : LABEL_COLOR;
            ctx.font = "10px Inter, Arial, sans-serif";
            ctx.fillText(RATING_LABELS[rating], sX + STAR_COUNT * sSpc + 6, sY + 12);
          }

          // Notes — canvas-rendered text + blinking cursor when active
          const isEditing = fb._editingPrompt === pNum;
          const nY = sY + 26, nW = cW - 20;
          ctx.fillStyle = NOTES_BG;
          ctx.strokeStyle = isEditing ? "#2563eb" : NOTES_BORDER;
          ctx.lineWidth = isEditing ? 1.5 : 0.5;
          ctx.beginPath(); ctx.roundRect(cX + 10, nY, nW, NOTES_H, 5); ctx.fill(); ctx.stroke();

          ctx.font = "11px Inter, Arial, sans-serif";
          ctx.textBaseline = "top";
          const liveNotes = isEditing && fb._editingTA ? fb._editingTA.value : notes;
          if (liveNotes) {
            ctx.fillStyle = TEXT_COLOR;
            const nLines = liveNotes.split("\n");
            for (let nl = 0; nl < Math.min(nLines.length, 4); nl++) {
              let ln = nLines[nl];
              while (ctx.measureText(ln).width > nW - 16 && ln.length > 5) ln = ln.slice(0, -4) + "\u2026";
              ctx.fillText(ln, cX + 16, nY + 8 + nl * 14);
            }
            if (isEditing && fb._cursorVisible) {
              const lastLine = nLines[Math.min(nLines.length - 1, 3)] || "";
              let ln = lastLine;
              while (ctx.measureText(ln).width > nW - 20) ln = ln.slice(0, -1);
              ctx.fillStyle = "#7dd3fc";
              ctx.fillRect(cX + 16 + ctx.measureText(ln).width + 1, nY + 8 + Math.min(nLines.length - 1, 3) * 14, 1.5, 12);
            }
          } else if (isEditing) {
            if (fb._cursorVisible) { ctx.fillStyle = "#7dd3fc"; ctx.fillRect(cX + 16, nY + 8, 1.5, 12); }
          } else {
            ctx.fillStyle = "#475569";
            ctx.fillText("Add notes\u2026", cX + 14, nY + 8);
          }
          ctx.textBaseline = "middle";

          fb.hitAreas.notes[i] = { x: cX + 10, y: nY, w: nW, h: NOTES_H, promptNum: pNum };
          curY += cardH + 10;
        }

        // Save button
        const btnW = inW + 8, btnH = 34, btnX = pad - 4, btnY = curY + 2;
        const flash = (Date.now() - fb.saveFlash) < 1500;
        const btnBg = flash ? BTN_DONE_BG : (fb.waiting ? (fb.hoverBtn ? BTN_WAIT_HV : BTN_WAIT_BG) : (fb.hoverBtn ? BTN_SAVE_HV : BTN_SAVE_BG));
        const btnText = flash ? "✅  Saved" : (fb.waiting ? "💾  Save & Continue  ▶" : "💾  Save Feedback");

        ctx.shadowColor = "rgba(0,0,0,0.3)"; ctx.shadowBlur = 6; ctx.shadowOffsetY = 2;
        ctx.fillStyle = btnBg;
        ctx.beginPath(); ctx.roundRect(btnX, btnY, btnW, btnH, 8); ctx.fill();
        ctx.shadowColor = "transparent"; ctx.shadowBlur = 0; ctx.shadowOffsetY = 0;

        ctx.fillStyle = "#fff";
        ctx.font = "bold 13px Inter, Arial, sans-serif";
        ctx.textBaseline = "middle";
        const tw = ctx.measureText(btnText).width;
        ctx.fillText(btnText, btnX + (btnW - tw) / 2, btnY + btnH / 2);
        fb.hitAreas.saveBtn = { x: btnX, y: btnY, w: btnW, h: btnH };

        if (flash) requestAnimationFrame(() => this.setDirtyCanvas(true));
        ctx.restore();
      };

      // ── Mouse handler ───────────────────────────────────────────────
      nodeType.prototype._fb_handleMouse = function (event, pos) {
        const fb = this._fb;
        if (!fb.hitAreas) return false;
        const [mx, my] = pos;
        const hit = (r) => r && mx >= r.x && mx <= r.x + r.w && my >= r.y && my <= r.y + r.h;

        if (event.type === "pointermove" || event.type === "mousemove") {
          const was = fb.hoverBtn;
          fb.hoverBtn = hit(fb.hitAreas.saveBtn);
          if (was !== fb.hoverBtn) this.setDirtyCanvas(true);
          return false;
        }

        const isClick = event.type === "pointerdown" ||
                        event.type === (LiteGraph.pointerevents_method + "down");
        if (!isClick) return false;

        if (hit(fb.hitAreas.leftArrow) && fb.selectedRun > 1) {
          this._fb_stopEditing(); this._fb_loadRun(fb.selectedRun - 1); return true;
        }
        if (hit(fb.hitAreas.rightArrow) && fb.selectedRun < fb.runCount) {
          this._fb_stopEditing(); this._fb_loadRun(fb.selectedRun + 1); return true;
        }

        // Header toggle
        for (const h of (fb.hitAreas.headers || [])) {
          if (!h || !hit(h)) continue;
          fb.collapsed[h.promptNum] = !(fb.collapsed[h.promptNum] !== false);
          this._fb_stopEditing();
          requestAnimationFrame(() => {
            this.setSize([this.size[0], this.computeSize()[1]]);
            app.graph.setDirtyCanvas(true, true);
          });
          return true;
        }

        // Stars
        for (const stars of (fb.hitAreas.stars || [])) {
          if (!stars) continue;
          for (const s of stars) {
            if (!s || !hit(s)) continue;
            const nr = s.starIdx + 1;
            fb.ratings[s.promptNum] = fb.ratings[s.promptNum] === nr ? 0 : nr;
            this.setDirtyCanvas(true);
            return true;
          }
        }

        // Notes → open textarea overlay
        for (const n of (fb.hitAreas.notes || [])) {
          if (!n || !hit(n)) continue;
          this._fb_startEditing(n.promptNum);
          this.setDirtyCanvas(true);
          return true;
        }

        // Save
        if (hit(fb.hitAreas.saveBtn)) { this._fb_saveFeedback(); return true; }

        // Click elsewhere closes textarea
        this._fb_stopEditing();
        return false;
      };
    }

    // ── Session Memory Reader — reset confirmation ────────────────────
    if (nodeData.name === "SessionMemoryReader") {
      const orig = nodeType.prototype.onWidgetChanged;
      nodeType.prototype.onWidgetChanged = function (widget) {
        if (widget?.name === "reset_session" && widget.value === true) {
          const ok = window.confirm(
            "⚠️ Reset session?\n\nALL data will be permanently deleted:\n" +
            "• Run history\n• Feedback & ratings\n• All thumbnail images\n\nThis action cannot be undone."
          );
          if (!ok) { widget.value = false; this.setDirtyCanvas(true); return; }
        }
        if (orig) orig.apply(this, arguments);
      };
    }
  },
});
