import yaml from "js-yaml";

export async function loadConfig() {
  const [gameYaml, studentXml] = await Promise.all([
    fetch("/config/game.yaml").then(r => r.text()),
    fetch("/config/student_life.xml").then(r => r.text()),
  ]);
  const game = yaml.load(gameYaml);
  const student = new DOMParser().parseFromString(studentXml, "text/xml");
  const boardsByLevel = extractBoardsByLevel(gameYaml);
  return { game, student, boardsByLevel };
}

export function extractStudentRefs(studentDoc) {
  const getTextList = (selector) =>
    Array.from(studentDoc.querySelectorAll(selector))
      .map(n => n.textContent)
      .join("\n")
      .split("\n")
      .map(s => s.trim())
      .filter(Boolean);
  return {
    classes: getTextList("Classes Items > *"),
    foods: getTextList("FoodAndDrinks Items"),
    hangouts: getTextList("Hangout Items"),
    study: getTextList("Study Items"),
    transport: getTextList("Transportation Items"),
  };
}

// Parse board ASCII into a 2D grid and a path order starting at 's'
export function parseBoard(board) {
  if (typeof board === 'string') {
    // Backward-compatible ASCII parser (arrows/dots)
    const lines = board.split(/\r?\n/);
    const height = lines.length;
    const width = Math.max(...lines.map(l => l.length));
    const grid = Array.from({ length: height }, (_, y) =>
      Array.from({ length: width }, (_, x) => lines[y][x] || " ")
    );
    // find start 's'
    let start = null;
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        if (grid[y][x] === "s") start = { x, y };
      }
    }
    if (!start) throw new Error("Start box 's' not found on board");
    // Follow corridors roughly as before, then extract letters
    const path = [];
    let cur = { ...start };
    const visited = new Set();
    const key = (p) => `${p.x},${p.y}`;
    let guard = width * height * 4;
    while (guard-- > 0) {
      path.push({ ...cur, type: grid[cur.y][cur.x] });
      if (cur.x === start.x && cur.y === start.y && path.length > 1) break;
      const neighbors = [
        { dx: 1, dy: 0, sym: ">" },
        { dx: -1, dy: 0, sym: "<" },
        { dx: 0, dy: 1, sym: "v" },
        { dx: 0, dy: -1, sym: "^" },
      ];
      // prefer continuing along any visible corridor
      let moved = false;
      for (const n of neighbors) {
        const nx = cur.x + n.dx, ny = cur.y + n.dy;
        const ch = (grid[ny] && grid[ny][nx]) || ' ';
        if (ch === '.' || ">^<v".includes(ch)) {
          cur = { x: nx, y: ny }; moved = true; break;
        }
      }
      if (!moved) break;
      if (visited.has(key(cur)) && !(cur.x === start.x && cur.y === start.y)) break;
      visited.add(key(cur));
    }
    const letters = new Set(["s","c","r","f","t","n","l"]);
    const letterPath = path.filter(p => letters.has(p.type));
    const compact = [];
    for (const p of letterPath) {
      if (!compact.length || compact[compact.length-1].x !== p.x || compact[compact.length-1].y !== p.y) compact.push(p);
    }
    return { grid, path: compact, width, height };
  }
  // New sides format
  const sides = board;
  const bottom = (sides.bottom || '').trim();
  const right = (sides.right || '').trim();
  const top = (sides.top || '').trim();
  const left = (sides.left || '').trim();
  const width = bottom.length || top.length;
  const height = (left.length || right.length) + 2;
  if (!width || !height) throw new Error('Invalid board sides');
  const grid = Array.from({ length: height }, () => Array.from({ length: width }, () => ' '));
  // bottom: left -> right
  for (let x = 0; x < width; x++) grid[height-1][x] = bottom[x] || ' ';
  // right: bottom -> top; place at x=width-1, y=height-2..1
  for (let i = 0; i < right.length; i++) grid[height-2 - i][width-1] = right[i];
  // top: right -> left; place at y=0, x=0..width-1 using reversed string
  for (let x = 0; x < width; x++) grid[0][x] = top[width-1 - x] || ' ';
  // left: top -> bottom; place at x=0, y=1..height-2
  for (let i = 0; i < left.length; i++) grid[1 + i][0] = left[i];
  // Build path clockwise starting at bottom-left (assume start there)
  const letters = new Set(["s","c","r","f","t","n","l"]);
  const path = [];
  // bottom row left->right
  for (let x = 0; x < width; x++) if (letters.has(grid[height-1][x])) path.push({ x, y: height-1, type: grid[height-1][x] });
  // right col bottom-1 up to y=1
  for (let y = height-2; y >= 1; y--) if (letters.has(grid[y][width-1])) path.push({ x: width-1, y, type: grid[y][width-1] });
  // top row right->left
  for (let x = width-1; x >= 0; x--) if (letters.has(grid[0][x])) path.push({ x, y: 0, type: grid[0][x] });
  // left col top+1 down to y=1
  for (let y = 1; y <= height-2; y++) if (letters.has(grid[y][0])) path.push({ x: 0, y, type: grid[y][0] });
  // rotate path so start 's' first (if present)
  const startIdx = path.findIndex(p => p.type === 's');
  const ordered = startIdx > 0 ? path.slice(startIdx).concat(path.slice(0, startIdx)) : path;
  return { grid, path: ordered, width, height };
}

// Extract raw board text blocks per level from the YAML source, preserving line breaks
export function extractBoardsByLevel(yamlText) {
  const lines = yamlText.split(/\r?\n/);
  // find the indent level of 'levels:'
  const boards = {};
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(/^(\s*)(\d+):\s*$/);
    if (m) {
      const level = m[2];
      const levelIndent = m[1].length;
      // scan inside this level for 'board: >'
      for (let j = i + 1; j < lines.length; j++) {
        const line = lines[j];
        const indent = line.match(/^(\s*)/)[1].length;
        if (indent <= levelIndent) break; // left this level
        const bm = line.match(new RegExp(`^(\\s{${levelIndent + 2}})board:\s*>\s*$`));
        if (bm) {
          const boardIndent = bm[1].length;
          const block = [];
          for (let k = j + 1; k < lines.length; k++) {
            const ln = lines[k];
            const ind = ln.match(/^(\s*)/)[1].length;
            if (ind <= levelIndent) break; // end of level or block
            if (ind >= boardIndent + 2) {
              block.push(ln.slice(boardIndent + 2));
            } else {
              break;
            }
          }
          if (block.length) boards[level] = block.join("\n");
          break;
        }
      }
    }
  }
  return boards;
}

export function initialStats(config) {
  const s = config.game.stats;
  return {
    intelligence: s.intelligence.initial,
    energy: s.energy.initial,
    luck: s.luck.initial,
    money: s.money.initial,
  };
}

export function clampStats(config, stats) {
  const s = config.game.stats;
  const clamp = (val, min, max) => Math.max(min ?? -Infinity, Math.min(max ?? Infinity, val));
  return {
    intelligence: clamp(stats.intelligence, s.intelligence.minimum, s.intelligence.maximum),
    energy: clamp(stats.energy, s.energy.minimum, s.energy.maximum),
    luck: clamp(stats.luck, s.luck.minimum ?? 0, 1000),
    money: clamp(stats.money, 0, s.money.maximum),
  };
}

export function computeEventOutcome(boxType, cfg, refs) {
  // Minimalistic logic for MVP; refine later using per-event probabilities
  const rand = (a,b)=>Math.floor(Math.random()*(b-a+1))+a;
  let delta = { intelligence: 0, energy: 0, luck: 0, money: 0, credits: 0 };
  let message = "";
  switch (boxType) {
    case "s":
      message = "Start! Stat reset.";
      break;
    case "c":
      delta.credits = rand(1,3);
      delta.energy = -rand(1,5);
      delta.intelligence = rand(1,4);
      message = `Ai fost la curs/lab/seminar. +${delta.credits} credite.`;
      break;
    case "r": {
      const v = rand(-5,5);
      delta.energy += v;
      delta.intelligence += rand(-3,3);
      delta.luck += rand(-5,5);
      delta.money += rand(-50,50);
      message = "Eveniment surpriză!";
      break;
    }
    case "f": {
      const places = refs.foods?.length ? refs.foods : ["Cantină"];
      const place = places[rand(0, places.length-1)];
      delta.energy = rand(3,8);
      delta.money = -rand(15,50);
      message = `Ai mâncat la ${place}.`;
      break;
    }
    case "t": {
      const acts = refs.hangouts?.length ? refs.hangouts : ["parc"];
      const act = acts[rand(0, acts.length-1)];
      delta.energy = rand(2,6);
      delta.intelligence = rand(-2,2);
      delta.money = -rand(0,40);
      message = `Timp liber: ${act}.`;
      break;
    }
    case "n":
      message = "Nimic notabil s-a întâmplat.";
      break;
    case "l":
      message = "Te așteptăm la Levi9 :)";
      delta.luck = rand(1,4);
      break;
    default:
      message = "Casetă necunoscută.";
  }
  return { delta, message };
}

export function saveState(state) {
  localStorage.setItem("levin_game_state", JSON.stringify(state));
}
export function loadState() {
  try {
    const raw = localStorage.getItem("levin_game_state");
    return raw ? JSON.parse(raw) : null;
  } catch { return null; }
}
