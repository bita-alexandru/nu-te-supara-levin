import React, { useEffect, useMemo, useRef, useState } from "react";
import { geminiChat } from "./geminiLLM.js";
import { loadConfig, extractStudentRefs, parseBoard, initialStats, clampStats, computeEventOutcome, saveState, loadState } from "./engine.js";

function Popup({ title, story, lines = [], options = [], onChoose, onClose, actionLabel = "OK" }) {
  return (
    <div className="popup" role="dialog" aria-modal>
      <div className="card">
        <h3 style={{marginTop:0}}>{title}</h3>
        <div>
          {story && (
            <div style={{marginBottom:8, whiteSpace:'pre-wrap'}}>{story}</div>
          )}
          {lines.map((line, i) => (
            <div key={i} className="row"><div>{line.left}</div><div className={`delta ${line.deltaClass||''}`} style={{...(line.rightStyle||{}), fontWeight: line.bold ? 700 : undefined}}>{line.right}</div></div>
          ))}
          {Array.isArray(options) && options.length>0 && (
            <div style={{display:'flex', gap:8, flexWrap:'wrap', marginTop:8}}>
              {options.map((opt, i) => (
                <button key={i} className="icon-btn" style={{ textAlign:'left' }} onClick={() => onChoose && onChoose(i)}>{opt.label || `Opțiunea ${i+1}`}</button>
              ))}
            </div>
          )}
        </div>
        <div className="footer">
          <button onClick={onClose}>{actionLabel}</button>
        </div>
      </div>
    </div>
  );
}

export default function App() {
  const [cfg, setCfg] = useState(null);
  const [refs, setRefs] = useState(null);
  const [board, setBoard] = useState(null); // {grid, path, width, height}
  const [level, setLevel] = useState(1);
  const [stats, setStats] = useState(null);
  const [credits, setCredits] = useState(0);
  const [pos, setPos] = useState(0); // index in board.path
  const [rolling, setRolling] = useState(false);
  const [popup, setPopup] = useState(null);
  const [logs, setLogs] = useState([]);
  const [hopping, setHopping] = useState(false);
  const [timerStart, setTimerStart] = useState(null);
  const [elapsed, setElapsed] = useState(0);
  const timerRef = useRef(null);
  const [lastRoll, setLastRoll] = useState(null);
  // floating log is always open now
  const [zoom, setZoom] = useState(1);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const [dragging, setDragging] = useState(false);
  const dragStartRef = useRef({ x: 0, y: 0 });
  const panStartRef = useRef({ x: 0, y: 0 });
  
  // Floating panels (positions and drag)
  const rollRef = useRef(null);
  const logRef = useRef(null);
  const [rollPos, setRollPos] = useState({ x: 0, y: 0 });
  const [logPos, setLogPos] = useState({ x: 0, y: 0 });
  const dragPanelRef = useRef(null); // 'roll' | 'log' | null
  const dragPanelStartRef = useRef({ x: 0, y: 0 });

  // Load config and previous state
  useEffect(() => {
    (async () => {
      const persisted = loadState();
      const { game, student, boardsByLevel } = await loadConfig();
      setCfg(game);
      setRefs(extractStudentRefs(student));
      const initialLevel = persisted?.level ?? game.game.levels.initial;
      setLevel(initialLevel);
      const rawBoard = boardsByLevel?.[String(initialLevel)] || game.game.levels[initialLevel].board;
      const currentBoard = parseBoard(rawBoard);
      setBoard(currentBoard);
      const s = persisted?.stats ?? initialStats(game);
      setStats(s);
      setCredits(persisted?.credits ?? game.game.credits.initial);
      // position: if persisted pos exists and matches board, use it, else start at 's'
      let p = 0;
      if (persisted?.pos != null && persisted?.level === initialLevel) {
        p = Math.min(persisted.pos, currentBoard.path.length - 1);
      } else {
        p = currentBoard.path.findIndex(c => c.type === 's');
        if (p < 0) p = 0;
      }
      setPos(p);
    })();
  }, []);

  // Persist state
  useEffect(() => {
    if (!cfg || !board || !stats) return;
    saveState({ level, stats, credits, pos });
  }, [cfg, board, level, stats, credits, pos]);

  // Timer tick
  useEffect(() => {
    if (!timerStart) return;
    if (timerRef.current) clearInterval(timerRef.current);
    timerRef.current = setInterval(() => {
      setElapsed(Math.floor((Date.now() - timerStart) / 1000));
    }, 1000);
    return () => { if (timerRef.current) clearInterval(timerRef.current); };
  }, [timerStart]);

  // Keyboard: Enter to roll or close popup
  useEffect(() => {
    const onKey = (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        if (popup && popup.onClose) {
          popup.onClose();
        } else if (!rolling) {
          onRoll();
        }
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [popup, rolling, onRoll]);

  // Initialize floating panels positions based on viewport
  useEffect(() => {
    const vw = window.innerWidth, vh = window.innerHeight;
    setRollPos({ x: Math.max(8, vw - 16 - 220), y: Math.max(8, Math.floor(vh/2 - 140)) });
    setLogPos({ x: 16, y: Math.max(8, Math.floor(vh/2 - 140)) });
  }, []);

  function clampToViewport(x, y, el) {
    const margin = 8;
    const vw = window.innerWidth, vh = window.innerHeight;
    const rect = el?.getBoundingClientRect?.() || { width: 220, height: 220 };
    const maxX = vw - rect.width - margin;
    const maxY = vh - rect.height - margin;
    return { x: Math.min(Math.max(margin, x), maxX), y: Math.min(Math.max(margin, y), maxY) };
  }

  function onPanelDragStart(which, e) {
    dragPanelRef.current = which;
    dragPanelStartRef.current = { x: e.clientX, y: e.clientY };
    const pos = which === 'roll' ? rollPos : logPos;
    dragStartRef.current = { x: pos.x, y: pos.y };
    document.addEventListener('mousemove', onPanelDragMove);
    document.addEventListener('mouseup', onPanelDragEnd);
  }
  function onPanelDragMove(e) {
    const dx = e.clientX - dragPanelStartRef.current.x;
    const dy = e.clientY - dragPanelStartRef.current.y;
    if (dragPanelRef.current === 'roll') {
      const el = rollRef.current;
      const next = clampToViewport(dragStartRef.current.x + dx, dragStartRef.current.y + dy, el);
      setRollPos(next);
    } else if (dragPanelRef.current === 'log') {
      const el = logRef.current;
      const next = clampToViewport(dragStartRef.current.x + dx, dragStartRef.current.y + dy, el);
      setLogPos(next);
    }
  }
  function onPanelDragEnd() {
    document.removeEventListener('mousemove', onPanelDragMove);
    document.removeEventListener('mouseup', onPanelDragEnd);
    dragPanelRef.current = null;
  }

  const boxMetaById = useMemo(() => {
    if (!cfg) return {};
    const entries = Object.values(cfg.game.boxes || {});
    const byId = {};
    for (const b of entries) byId[b.id] = b;
    return byId;
  }, [cfg]);

  const diceMin = cfg?.game?.dice?.minimum ?? 1;
  const diceMax = cfg?.game?.dice?.maximum ?? 6;

  // Log color by stat key, bold
  const statColor = (key) => ({
    energy: '#fde047',      // yellow
    money: '#22c55e',       // green
    luck: '#60a5fa',        // blue
    intelligence: '#f0abfc',// pink
    credits: '#111827',     // black
  }[key] || '#334155');

  function sanitizeLLMJsonText(text) {
    if (!text) return '';
    let s = String(text).trim();
    // strip leading ```json or ``` and trailing ```
    if (s.startsWith('```')) {
      s = s.replace(/^```json\s*/i, '');
      s = s.replace(/^```\s*/i, '');
      s = s.replace(/```\s*$/i, '');
    }
    return s.trim();
  }
  function parseLLMJson(text) {
    if (!text) return null;
    // try cleaned parse first
    const cleaned = sanitizeLLMJsonText(text);
    const tryParse = (t) => { try { return JSON.parse(t); } catch { return null; } };
    let obj = tryParse(cleaned);
    if (!obj) {
      // fallback: extract first JSON object from arbitrary text
      const i = cleaned.indexOf('{');
      const j = cleaned.lastIndexOf('}');
      if (i !== -1 && j !== -1 && j > i) {
        obj = tryParse(cleaned.slice(i, j + 1));
      }
    }
    return obj;
  }

  async function onRoll() {
    if (!board || !cfg || !stats) return;
    setRolling(true);
    const roll = Math.floor(Math.random() * (diceMax - diceMin + 1)) + diceMin;
    setLastRoll(roll);
    if (!timerStart) setTimerStart(Date.now());

    let curPos = pos;
    let curStats = { ...stats };
    let curCredits = credits;
    let curLevel = level;
    let curBoard = board;

    // step-by-step hop animation
    for (let step = 0; step < roll; step++) {
      setHopping(true);
      await new Promise(r => setTimeout(r, 80));
      curPos = (curPos + 1) % curBoard.path.length;
      setPos(curPos);
      await new Promise(r => setTimeout(r, 160));
      setHopping(false);

      const stepTile = curBoard.path[curPos];
      if (stepTile.type === 's') {
        // reset stats and check level-up
        curStats = initialStats(cfg);
        const req = cfg.game.levels[curLevel].credits_to_advance;
        if (curCredits >= req && curLevel < cfg.game.levels.maximum) {
          curLevel = curLevel + 1;
          const rawBoard2 = (await loadConfig()).boardsByLevel?.[String(curLevel)] || cfg.game.levels[curLevel].board;
          const newBoard = parseBoard(rawBoard2);
          setBoard(newBoard);
          curBoard = newBoard;
          const startIdx = newBoard.path.findIndex(c => c.type === 's');
          curPos = startIdx >= 0 ? startIdx : 0;
          setPos(curPos);
          if (curLevel >= cfg.game.levels.maximum) {
            if (timerRef.current) clearInterval(timerRef.current);
            setTimerStart(null);
            setPopup({
              title: 'Levin a absolvit AC! Ura!',
              lines: [],
              onClose: () => setPopup(null),
            });
          } else {
            setPopup({
              title: `Felicitări! Ai trecut în ${cfg.game.levels[curLevel].label}`,
              lines: [],
              onClose: () => setPopup(null),
            });
          }
          break; // stop remaining steps; new level starts fresh at start
        }
      }
    }

    // landing event
    const tile = curBoard.path[curPos];
    const outcome = computeEventOutcome(tile.type, cfg, refs || {});
    const beforeStats = { ...curStats };
    // We'll only apply outcome deltas if LLM content is not available

    const lines = [];
    const deltas = [
      { key:'intelligence', label: cfg?.game?.stats?.intelligence?.label || 'Int' },
      { key:'energy', label: cfg?.game?.stats?.energy?.label || 'Energie' },
      { key:'luck', label: cfg?.game?.stats?.luck?.label || 'Noroc' },
      { key:'money', label: cfg?.game?.stats?.money?.label || 'Lei' },
      { key:'credits', label: 'Credite' },
    ];
    const logEntry = { time: new Date().toISOString(), title: outcome.message || 'Eveniment', tileType: tile.type, changes: [] };

    const applyAfter = () => {
      setStats(curStats);
      setCredits(curCredits);
      setLevel(curLevel);
      setRolling(false);
      setLogs(prev => [{ ...logEntry }, ...prev].slice(0, 200));
    };

    // Try to enhance popup via LLM (best-effort, fallback to default if fails)
    let story = '';
    let llmOptions = [];
    try {
      const ctx = {
        classes: (refs?.classes||[]).slice(0,20),
        foods: (refs?.foods||[]).slice(0,20),
        hangouts: (refs?.hangouts||[]).slice(0,20),
        study: (refs?.study||[]).slice(0,20),
        transport: (refs?.transport||[]).slice(0,20),
      };
      const sys = `Generează în limba română un titlu scurt și o poveste (maxim 4-5 fraze) pentru un eveniment de tip "${labelForTile(tile.type)}". Folosește contextul din listele furnizate (clase, mâncare/băuturi, ieșiri, studiu, transport) când este relevant.
Opțional, propune 2-3 opțiuni relevante pentru jucător. Pentru fiecare opțiune furnizează efecte ca intervale [min,max] pentru statisticile intelligence, energy, luck, money și credits.
Reguli de realism pentru efecte:
- credits pot fi câștigate DOAR la casetele de tip "facultate"; altfel credits trebuie să fie [0,0]. credits nu sunt niciodată negative.
- intelligence crește la activități de studiu/corecte (curs, laborator, învățat) și poate scădea la chiul/copiat.
- energy crește la relaxare/odihnă și scade la studiu intens, nopți nedormite, stres.
- money crește la evenimente legate de câștig (job, bursă, câștig) și scade la cheltuieli (mâncare, distracție, transport etc.).
Respectă aceste reguli și nu adăuga text în afara JSON-ului.`;
      const prompt = `<Prompt>\n<SystemInstruction>${sys}</SystemInstruction>\n<context>${JSON.stringify(ctx)}</context>\n<tile>${labelForTile(tile.type)}</tile>\n<format>{"title":"string","story":"string","options":[{"label":"string","effects":{"intelligence":[min,max],"energy":[min,max],"luck":[min,max],"money":[min,max],"credits":[min,max]}}]}</format>\n</Prompt>`;
      const content = await geminiChat(prompt);
      const parsed = parseLLMJson(content) || {};
      if (parsed?.title) { logEntry.title = parsed.title; }
      const storyCandidate = parsed.story || parsed.description || parsed.content || parsed.text || '';
      if (storyCandidate) { story = storyCandidate; }
      const rawOptions = Array.isArray(parsed.options) ? parsed.options : (Array.isArray(parsed.choices) ? parsed.choices : []);
      if (rawOptions.length) { llmOptions = rawOptions.slice(0,3); }
    } catch (e) { console.error(e); }

    const llmValid = !!(story) || (Array.isArray(llmOptions) && llmOptions.length>0);

    const onChoose = async (idx) => {
      const opt = llmOptions[idx];
      if (!opt || !opt.effects) { setPopup(null); applyAfter(); return; }
      // sample random deltas from provided ranges and apply
      const rng = (a)=> Array.isArray(a) && a.length===2 ? Math.floor(Math.random()*(a[1]-a[0]+1))+a[0] : 0;
      const extra = {
        intelligence: rng(opt.effects.intelligence),
        energy: rng(opt.effects.energy),
        luck: rng(opt.effects.luck),
        money: rng(opt.effects.money),
        credits: Math.max(0, rng(opt.effects.credits)),
      };
      // enforce: credits only from 'facultate' (box id 'c')
      if (tile.type !== 'c') extra.credits = 0;
      const before = { ...curStats };
      curStats = clampStats(cfg, {
        intelligence: curStats.intelligence + extra.intelligence,
        energy: curStats.energy + extra.energy,
        luck: curStats.luck + extra.luck,
        money: curStats.money + extra.money,
      });
      const reqNow = cfg.game.levels[curLevel].credits_to_advance;
      if (curLevel < cfg.game.levels.maximum) {
        curCredits = Math.min(reqNow, Math.max(0, curCredits + (extra.credits||0)));
      } else {
        curCredits = Math.max(0, Math.min((cfg?.game?.credits?.maximum ?? 999), curCredits + (extra.credits||0)));
      }
      logEntry.selectedOption = opt.label || `Opțiunea ${idx+1}`;
      // augment popup lines and log with the choice effects
      for (const d of deltas) {
        const v = (d.key === 'credits') ? (extra.credits||0) : (curStats[d.key] - before[d.key]);
        if (v !== 0) {
          lines.push({ left: `${d.label} (opțiune)`, right: `${v>0?'+':''}${v}`, rightStyle: { color: statColor(d.key) }, bold: true, deltaClass: v>0? 'plus' : 'minus' });
          logEntry.changes.push({ key: d.key, label: d.label, value: v });
        }
      }
      // immediate level up if requirement reached, place at start
      if (curLevel < cfg.game.levels.maximum && curCredits >= reqNow) {
        const { boardsByLevel } = await loadConfig();
        curLevel = curLevel + 1;
        const rawBoard2 = boardsByLevel?.[String(curLevel)] || cfg.game.levels[curLevel].board;
        const newBoard = parseBoard(rawBoard2);
        setBoard(newBoard);
        curBoard = newBoard;
        const startIdx = newBoard.path.findIndex(c => c.type === 's');
        curPos = startIdx >= 0 ? startIdx : 0;
        setPos(curPos);
        if (curLevel >= cfg.game.levels.maximum) {
          if (timerRef.current) clearInterval(timerRef.current);
          setTimerStart(null);
          setPopup({ title: 'Levin a absolvit AC! Ura!', lines: [], onClose: () => setPopup(null) });
        } else {
          setPopup({ title: `Felicitări! Ai trecut în ${cfg.game.levels[curLevel].label}`, lines: [], onClose: () => setPopup(null) });
        }
        applyAfter();
        return;
      }
      setPopup(null);
      applyAfter();
    };
    if (llmValid) {
      // Do not apply default deltas; wait for user choice
      setPopup({
        title: logEntry.title || outcome.message || "Eveniment",
        story,
        lines,
        options: llmOptions,
        onChoose,
        onClose: () => { setPopup(null); applyAfter(); },
      });
    } else {
      // Apply default outcome deltas and show them
      const delta = outcome.delta || {};
      // enforce: credits only from 'facultate' (box id 'c')
      if (tile.type !== 'c') delta.credits = 0;
      curStats = clampStats(cfg, {
        intelligence: curStats.intelligence + (delta.intelligence||0),
        energy: curStats.energy + (delta.energy||0),
        luck: curStats.luck + (delta.luck||0),
        money: curStats.money + (delta.money||0),
      });
      const reqNow2 = cfg.game.levels[curLevel].credits_to_advance;
      if (curLevel < cfg.game.levels.maximum) {
        curCredits = Math.min(reqNow2, Math.max(0, curCredits + (delta.credits||0)));
      } else {
        curCredits = Math.max(0, Math.min((cfg?.game?.credits?.maximum ?? 999), curCredits + (delta.credits||0)));
      }
      for (const d of deltas) {
        const v = (d.key === 'credits') ? (delta.credits||0) : ((delta[d.key]||0));
        if (v !== 0) {
          lines.push({ left: d.label, right: `${v>0?'+':''}${v}`, deltaClass: v>0? 'plus' : 'minus' });
          logEntry.changes.push({ key: d.key, label: d.label, value: v });
        }
      }
      // immediate level up if requirement reached even without passing start
      if (curLevel < cfg.game.levels.maximum && curCredits >= reqNow2) {
        (async () => {
          const { boardsByLevel } = await loadConfig();
          curLevel = curLevel + 1;
          const rawBoard2 = boardsByLevel?.[String(curLevel)] || cfg.game.levels[curLevel].board;
          const newBoard = parseBoard(rawBoard2);
          setBoard(newBoard);
          curBoard = newBoard;
          const startIdx = newBoard.path.findIndex(c => c.type === 's');
          curPos = startIdx >= 0 ? startIdx : 0;
          setPos(curPos);
          if (curLevel >= cfg.game.levels.maximum) {
            if (timerRef.current) clearInterval(timerRef.current);
            setTimerStart(null);
            setPopup({ title: 'Levin a absolvit AC! Ura!', lines: [], onClose: () => setPopup(null) });
          } else {
            setPopup({ title: `Felicitări! Ai trecut în ${cfg.game.levels[curLevel].label}`, lines: [], onClose: () => setPopup(null) });
          }
          applyAfter();
        })();
      } else {
        setPopup({
          title: logEntry.title || outcome.message || "Eveniment",
          story,
          lines,
          options: [],
          onClose: () => { setPopup(null); applyAfter(); },
        });
      }
    }
  }

  function labelForTile(ch) {
    const meta = boxMetaById[ch];
    return meta?.label || ch.toUpperCase();
  }
  function labelWithEmojiForTile(ch) {
    const meta = boxMetaById[ch];
    if (!meta) return ch.toUpperCase();
    const emo = meta.emoji ? ` ${meta.emoji}` : '';
    return `${meta.label}${emo}`;
  }

  function renderStat(key, emoji) {
    const meta = cfg.game.stats[key];
    const min = meta.minimum ?? 0;
    const max = meta.maximum ?? 100;
    const val = stats[key];
    const pct = Math.max(0, Math.min(100, Math.round(((val - min) / (max - min)) * 100)));
    const hue = Math.round((pct / 100) * 120); // 0=red -> 120=green
    const color = `hsl(${hue} 80% 45%)`;
    const labelOnDark = pct > 50; // assume center label sits mostly over filled area when > 50%
    const labelStyle = labelOnDark
      ? { color: '#ffffff', textShadow: '0 1px 1px #000, 1px 0 1px #000, -1px 0 1px #000, 0 -1px 1px #000' }
      : { color: '#0f172a', textShadow: '0 1px 1px #fff, 1px 0 1px #fff, -1px 0 1px #fff, 0 -1px 1px #fff' };
    return (
      <div className="stat" title={`${meta.label}: ${val}`}>
        <div style={{whiteSpace:'nowrap', minWidth: 120}}>{emoji} {meta.label}</div>
        <div className="bar">
          <span style={{width: pct + '%', background: color}}></span>
          <div className="bar-label" style={labelStyle}>{val}/{max}</div>
        </div>
      </div>
    );
  }

  function centerEmojiForTile(type) {
    const meta = boxMetaById[type];
    return meta?.emoji || '';
  }

  function renderGridRect() {
    if (!board) return null;
    const { grid, width, height } = board;
    const pathIndexByCoord = new Map(board.path.map((p,i)=>[`${p.x},${p.y}`, i]));
    const style = { gridTemplateColumns: `repeat(${width}, 56px)` };

    const cells = [];
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const ch = grid[y][x];
        const idx = pathIndexByCoord.get(`${x},${y}`);
        const isLetter = "scrftnl".includes(ch);
        const isPlayer = idx === pos;
        const classNames = ["cell", isLetter ? ch : "empty"];
        if (isPlayer) classNames.push("player");
        if (ch === 's') classNames.push('start');
        cells.push(
          <div key={`${x},${y}`} className={classNames.join(' ')} title={isLetter ? labelForTile(ch) : ''}>
            {isLetter && (
              <>
                <div style={{position:'absolute', top:4, left:0, right:0, textAlign:'center'}}>
                  <span>{boxMetaById[ch]?.emoji || ''}</span>
                </div>
                <div className="tile-label" style={{position:'absolute', bottom:4, left:0, right:0, textAlign:'center'}}>
                  {labelForTile(ch)}
                </div>
              </>
            )}
            {isPlayer && <div className={`player-emoji ${hopping ? 'hop' : ''}`} title="Levin">🤖</div>}
          </div>
        );
      }
    }
    return (
      <div className="grid" style={style}>
        {cells}
      </div>
    );
  }

  // Continuous hex perimeter positions (kept for potential future use)
  function hexVertices(radius) {
    // vertices starting from leftmost, clockwise
    const angles = [Math.PI, Math.PI * 2/3, Math.PI/3, 0, -Math.PI/3, -Math.PI*2/3];
    return angles.map(th => ({ x: Math.cos(th) * radius, y: Math.sin(th) * radius }));
  }
  function lerp(a, b, t) { return { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t }; }
  function layoutHexPerimeterPositions(count, radius) {
    const verts = hexVertices(radius);
    // Equal distribution across 6 edges for a clean hex
    const weights = [1, 1, 1, 1, 1, 1];
    const wSum = weights.reduce((a,b)=>a+b,0);
    // initial proportional allocation
    let per = weights.map(w => Math.max(0, Math.floor((w / wSum) * count)));
    // fix rounding to match total count
    let allocated = per.reduce((a,b)=>a+b,0);
    const order = [0,1,2,3,4,5]; // simple round-robin
    let idx = 0;
    while (allocated < count) { per[order[idx % 6]]++; allocated++; idx++; }
    while (allocated > count) { const j = order[idx % 6]; if (per[j]>0){ per[j]--; allocated--; } idx++; }
    // now sample along edges in order, preserving item order
    const positions = [];
    for (let e = 0; e < 6; e++) {
      const n = per[e];
      const a = verts[e];
      const b = verts[(e+1)%6];
      for (let k = 0; k < n; k++) {
        const u = n === 1 ? 0 : (k / (n - 1));
        positions.push(lerp(a, b, u));
      }
    }
    return positions;
  }
  // HEX: pure hex perimeter layout (order-free aesthetic)
  function renderGridHex() {
    if (!board) return null;
    const path = board.path;
    const tile = 56;
    const N = path.length;
    const r = Math.max(90, (N * tile * 0.85) / (2 * Math.PI));
    const pts = layoutHexPerimeterPositions(N, r);
    // normalize
    const xs = pts.map(p=>p.x), ys = pts.map(p=>p.y);
    const minX = Math.min(...xs), minY = Math.min(...ys);
    const norm = pts.map(p=>({x: p.x - minX, y: p.y - minY}));
    const maxX = Math.max(...norm.map(p=>p.x)), maxY = Math.max(...norm.map(p=>p.y));
    const w = Math.ceil(maxX + tile), h = Math.ceil(maxY + tile);
    return (
      <div style={{ position:'relative', width: w, height: h }}>
        {norm.map((p, i) => {
          const ch = path[i].type;
          const classNames = ["cell", ch];
          if (ch === 's') classNames.push('start');
          const isPlayer = i === pos;
          if (isPlayer) classNames.push('player');
          return (
            <div key={i} className={classNames.join(' ')} title={labelForTile(ch)} style={{ position:'absolute', left: p.x, top: p.y }}>
              <div style={{position:'absolute', top:4, left:0, right:0, textAlign:'center'}}>
                <span>{boxMetaById[ch]?.emoji || ''}</span>
              </div>
              <div className="tile-label" style={{position:'absolute', bottom:4, left:0, right:0, textAlign:'center'}}>
                {labelForTile(ch)}
              </div>
              {isPlayer && <div className={`player-emoji ${hopping ? 'hop' : ''}`} title="Levin">🤖</div>}
            </div>
          );
        })}
      </div>
    );
  }

  // Board pixel dimensions based on cell size and gaps
  function boardPixelSize() {
    if (!board) return { w: 0, h: 0 };
    const cell = 56, gap = 6;
    const w = board.width * cell + (board.width - 1) * gap;
    const h = board.height * cell + (board.height - 1) * gap;
    return { w, h };
  }

  function centerEmojiSizePx() {
    const { w, h } = boardPixelSize();
    const minSide = Math.min(w, h) * zoom;
    return Math.max(64, Math.floor(minSide * 0.7));
  }

  function onBoardMouseDown(e) {
    setDragging(true);
    dragStartRef.current = { x: e.clientX, y: e.clientY };
    panStartRef.current = { ...pan };
  }
  function onBoardMouseMove(e) {
    if (!dragging) return;
    const dx = e.clientX - dragStartRef.current.x;
    const dy = e.clientY - dragStartRef.current.y;
    setPan({ x: panStartRef.current.x + dx, y: panStartRef.current.y + dy });
  }
  function endDrag() { setDragging(false); }

  if (!cfg || !board || !stats) {
    return <div className="app"><header><div>Se încarcă jocul...</div></header></div>;
  }

  return (
    <div className="app">
      <header>
        <div style={{fontWeight:700}}>{cfg.game.title} <span className="pill">Levin 🤖</span> <span className="pill">{formatTime(elapsed)}</span></div>
        <div className="stats">
          {renderStat('intelligence', '🤓')}
          {renderStat('energy', '🔋')}
          {renderStat('luck', '🍀')}
          {renderStat('money', '💵')}
          <div>
            <span className="pill credits">
              Credite: {credits}{level < cfg.game.levels.maximum ? `/${cfg.game.levels[level].credits_to_advance}` : ''}
            </span>
          </div>
          <div>Nivel: <b>{cfg.game.levels[level].label}</b></div>
        </div>
      </header>

      <div
        className={`board ${dragging ? 'grabbing' : 'grab'}`}
        onMouseDown={onBoardMouseDown}
        onMouseMove={onBoardMouseMove}
        onMouseUp={endDrag}
        onMouseLeave={endDrag}
      >
        <div style={{ transform: `translate(${pan.x}px, ${pan.y}px) scale(${zoom})`, transformOrigin: 'center', transition: dragging ? undefined : 'transform 120ms ease', position: 'relative' }}>
          {renderGridRect()}
          {board?.path?.[pos] && (
            <div className="center-emoji" aria-hidden style={{ fontSize: centerEmojiSizePx() }}>
              {centerEmojiForTile(board.path[pos].type)}
            </div>
          )}
        </div>
      </div>

      {/* Floating left: Log */}
      <div className="floating-left" ref={logRef} style={{ left: logPos.x, top: logPos.y }}>
        <div className="floating-header" onMouseDown={(e)=>onPanelDragStart('log', e)}>
          <span>Jurnal evenimente</span>
        </div>
        <div className="floating-body">
          {logs.length === 0 && <div style={{opacity:0.6}}>Nu există evenimente încă.</div>}
          {logs.map((e, i) => (
            <div key={i} style={{marginBottom:6}}>
              <div style={{fontWeight:600}}>{e.title}</div>
              {e.selectedOption && (
                <div style={{opacity:0.85, marginTop:2}}>Opțiune: <b>{e.selectedOption}</b></div>
              )}
              {e.changes && e.changes.length>0 && (
                <div style={{opacity:0.9}}>
                  {e.changes.map((c, j) => (
                    <div key={j}>
                      <span>{c.label} </span>
                      <span style={{color: statColor(c.key), fontWeight:700}}>{c.value>0?'+':''}{c.value}</span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          ))}
        </div>
      </div>

      {/* Floating right: Roll UI */}
      <div className="floating-right" ref={rollRef} style={{ left: rollPos.x, top: rollPos.y }}>
        <div className="floating-header" onMouseDown={(e)=>onPanelDragStart('roll', e)}>
          <div style={{fontWeight:700}}>Zarul</div>
          <div>{lastRoll != null && <Dice value={lastRoll} />}</div>
        </div>
        <button onClick={onRoll} disabled={rolling} className="icon-btn btn-primary">{rolling? '...' : 'Dă cu zarul (Enter)'}</button>
        <div style={{opacity:0.7}}>Pas curent: {pos}</div>
        <div className="zoom-row">
          <div style={{fontWeight:700}}>Zoom</div>
          <div style={{display:'flex', gap:6}}>
            <button className="icon-btn" onClick={() => setZoom(z => Math.max(0.5, +(z - 0.1).toFixed(2)))}>-</button>
            <div style={{minWidth:48, textAlign:'center'}}>{Math.round(zoom*100)}%</div>
            <button className="icon-btn" onClick={() => setZoom(z => Math.min(2, +(z + 0.1).toFixed(2)))}>+</button>
          </div>
        </div>
        
      </div>

      {popup && (
        <Popup
          title={popup.title}
          story={popup.story}
          lines={popup.lines || []}
          options={popup.options || []}
          onChoose={popup.onChoose}
          onClose={popup.onClose}
        />
      )}
    </div>
  );
}

function formatTime(totalSeconds) {
  const s = Math.max(0, totalSeconds|0);
  const h = Math.floor(s/3600).toString().padStart(2,'0');
  const m = Math.floor((s%3600)/60).toString().padStart(2,'0');
  const ss = (s%60).toString().padStart(2,'0');
  return `${h}:${m}:${ss}`;
}

function Dice({ value }) {
  const maps = {
    1: [4],
    2: [0, 8],
    3: [0, 4, 8],
    4: [0, 2, 6, 8],
    5: [0, 2, 4, 6, 8],
    6: [0, 2, 3, 5, 6, 8],
  };
  const on = maps[value] || [];
  return (
    <div className="dice" aria-label={`Zar: ${value}`}>
      {Array.from({ length: 9 }).map((_, i) => (
        <div key={i} className={`pip ${on.includes(i) ? 'on' : ''}`}></div>
      ))}
    </div>
  );
}
