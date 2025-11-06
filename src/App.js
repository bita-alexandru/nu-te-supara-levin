import React, { useEffect, useMemo, useState } from "https://esm.sh/react@18";
import { loadConfig, extractStudentRefs, parseBoard, initialStats, clampStats, computeEventOutcome, saveState, loadState } from "./engine.js";

function Popup({ title, lines = [], onClose, actionLabel = "OK" }) {
  return (
    <div className="popup" role="dialog" aria-modal>
      <div className="card">
        <h3 style={{marginTop:0}}>{title}</h3>
        <div>
          {lines.map((line, i) => (
            <div key={i} className="row"><div>{line.left}</div><div className={`delta ${line.deltaClass||''}`}>{line.right}</div></div>
          ))}
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

  // Load config and previous state
  useEffect(() => {
    (async () => {
      const persisted = loadState();
      const { game, student } = await loadConfig();
      setCfg(game);
      setRefs(extractStudentRefs(student));
      const initialLevel = persisted?.level ?? game.game.levels.initial;
      setLevel(initialLevel);
      const currentBoard = parseBoard(game.game.levels[initialLevel].board);
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

  const boxMetaById = useMemo(() => {
    if (!cfg) return {};
    const entries = Object.values(cfg.game.boxes || {});
    const byId = {};
    for (const b of entries) byId[b.id] = b;
    return byId;
  }, [cfg]);

  const diceMin = cfg?.game?.dice?.minimum ?? 1;
  const diceMax = cfg?.game?.dice?.maximum ?? 6;

  function onRoll() {
    if (!board || !cfg || !stats) return;
    setRolling(true);
    const roll = Math.floor(Math.random() * (diceMax - diceMin + 1)) + diceMin;
    // compute destination
    const dest = (pos + roll) % board.path.length;
    const tile = board.path[dest];
    // resolve event
    const outcome = computeEventOutcome(tile.type, cfg, refs || {});
    let newStats = clampStats(cfg, {
      intelligence: stats.intelligence + outcome.delta.intelligence,
      energy: stats.energy + outcome.delta.energy,
      luck: stats.luck + outcome.delta.luck,
      money: stats.money + outcome.delta.money,
    });
    let newCredits = Math.max(0, Math.min((cfg?.game?.credits?.maximum ?? 999), credits + (outcome.delta.credits||0)));

    // If landing on start: reset stats to initial, then check level-up
    let leveledUp = false;
    let nextLevel = level;
    if (tile.type === 's') {
      newStats = initialStats(cfg);
      const req = cfg.game.levels[level].credits_to_advance;
      if (credits >= req && level < cfg.game.levels.maximum) {
        nextLevel = level + 1;
        leveledUp = true;
      }
    }

    const lines = [
      { left: `Ținta: ${labelForTile(tile.type)}`, right: `+${roll} pași` },
    ];
    const deltas = [
      { key:'intelligence', label: cfg?.game?.stats?.intelligence?.label || 'Int' },
      { key:'energy', label: cfg?.game?.stats?.energy?.label || 'Energie' },
      { key:'luck', label: cfg?.game?.stats?.luck?.label || 'Noroc' },
      { key:'money', label: cfg?.game?.stats?.money?.label || 'Lei' },
      { key:'credits', label: 'Credite' },
    ];
    for (const d of deltas) {
      const v = (d.key === 'credits') ? (outcome.delta.credits||0) : (newStats[d.key] - stats[d.key]);
      if (v !== 0) lines.push({ left: d.label, right: `${v>0?'+':''}${v}`, deltaClass: v>0? 'plus' : 'minus' });
    }

    const doAfterPopup = () => {
      setPos(dest);
      setStats(newStats);
      setCredits(newCredits);
      setLevel(nextLevel);
      setRolling(false);

      if (leveledUp) {
        // Load new board and teleport to start
        const newBoard = parseBoard(cfg.game.levels[nextLevel].board);
        setBoard(newBoard);
        const startIdx = newBoard.path.findIndex(c => c.type === 's');
        setPos(startIdx >= 0 ? startIdx : 0);
        setPopup({
          title: `Felicitări! Ai trecut în ${cfg.game.levels[nextLevel].label}`,
          lines: [],
          onClose: () => setPopup(null),
        });
      }
    };

    setPopup({
      title: outcome.message || "Eveniment",
      lines,
      onClose: () => { setPopup(null); doAfterPopup(); },
    });
  }

  function labelForTile(ch) {
    const meta = boxMetaById[ch];
    return meta?.label || ch.toUpperCase();
  }

  function renderGrid() {
    if (!board) return null;
    const { grid, width, height } = board;
    const pathIndexByCoord = new Map(board.path.map((p,i)=>[`${p.x},${p.y}`, i]));
    const style = { gridTemplateColumns: `repeat(${width}, 40px)` };

    const cells = [];
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const ch = grid[y][x];
        const idx = pathIndexByCoord.get(`${x},${y}`);
        const isLetter = "scrftnl".includes(ch);
        const isPlayer = idx === pos;
        const classNames = ["cell"];
        if (isLetter) classNames.push(ch);
        if (isPlayer) classNames.push("player");
        if (ch === 's') classNames.push('start');
        const label = isLetter ? labelForTile(ch)[0] : ch;
        cells.push(
          <div key={`${x},${y}`} className={classNames.join(' ')} title={isLetter ? labelForTile(ch) : ''}>
            {isLetter ? ch : (">^<v".includes(ch) ? ch : (ch==='.'?'' : ch))}
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

  if (!cfg || !board || !stats) {
    return <div className="app"><header><div>Se încarcă jocul...</div></header></div>;
  }

  return (
    <div className="app">
      <header>
        <div style={{fontWeight:700}}>{cfg.game.title}</div>
        <div className="stats">
          <div>{cfg.game.stats.intelligence.label}: <b>{stats.intelligence}</b></div>
          <div>{cfg.game.stats.energy.label}: <b>{stats.energy}</b></div>
          <div>{cfg.game.stats.luck.label}: <b>{stats.luck}</b></div>
          <div>{cfg.game.stats.money.label}: <b>{stats.money}</b></div>
          <div>Credite: <b>{credits}</b></div>
          <div>Nivel: <b>{cfg.game.levels[level].label}</b></div>
        </div>
      </header>

      <div className="board">
        {renderGrid()}
      </div>

      <div className="actions">
        <button onClick={onRoll} disabled={rolling}>{rolling? '...' : 'Dă cu zarul'}</button>
        <div style={{opacity:0.7}}>Pas curent: {pos}</div>
      </div>

      {popup && (
        <Popup
          title={popup.title}
          lines={popup.lines || []}
          onClose={popup.onClose}
        />
      )}
    </div>
  );
}
