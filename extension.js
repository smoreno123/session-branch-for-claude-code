// Claude Session Branch: muestra, junto al indicador de Git, la rama de la
// sesión de Claude Code de la pestaña activa (leída de su transcript .jsonl).
const vscode = require('vscode');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');

const PROJECTS_DIR = path.join(os.homedir(), '.claude', 'projects');
const cache = new Map(); // file -> { mtimeMs, size, info }
let item;
let current = null; // { title, sessionId, branch, cwd, file }

function parseTranscript(text) {
  const last = (re) => { let m, v = null, i = -1; while ((m = re.exec(text))) { v = m[1]; i = m.index; } return { v, i }; };
  const unq = (s) => { try { return s == null ? null : JSON.parse(`"${s}"`); } catch { return s; } };
  const S = '((?:[^"\\\\]|\\\\.)*)';
  const field = (k) => unq(last(new RegExp(`"${k}":"${S}"`, 'g')).v);
  // cwd: el último entre el "cwd" de los mensajes y el "relocatedCwd" que Claude Code
  // escribe al mover el transcript a otra carpeta de proyecto (p. ej. al entrar en un worktree)
  const c = last(new RegExp(`"cwd":"${S}"`, 'g'));
  const r = last(new RegExp(`"relocatedCwd":"${S}"`, 'g'));
  return {
    customTitle: field('customTitle'),
    aiTitle: field('aiTitle'),
    branch: field('gitBranch'),
    cwd: unq(r.i > c.i ? r.v : c.v),
    sessionId: field('sessionId'),
    worktree: parseWorktree(text),
    ...parseActivity(text),
  };
}

// Actividad de la sesión, de la más antigua a la más reciente y sin duplicados:
// - paths: todas las rutas tocadas (cwd de los mensajes, ficheros/carpetas de cualquier herramienta,
//   "cd" / "pushd" / "git -C" de Bash). Sirven para listar los repos de la sesión.
// - work: solo donde Claude trabaja de verdad: ficheros que edita/escribe y carpetas donde ejecuta
//   comandos (el destino del cd/git -C o, si no hay, el cwd de ese mensaje). La más reciente decide
//   el repo "activo", que puede no ser el cwd: el shell vuelve al cwd tras cada comando, así que
//   Claude suele trabajar en otro worktree con "cd /otro/worktree && …" en cada orden.
const MAX_PATHS = 200;
const WRITE_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);
const SHELL_TOOLS = new Set(['Bash', 'PowerShell']);
const SHELL_DIR = /(?:^|[\s;&|(])(?:cd|pushd|git\s+-C)\s+(?:"([^"]+)"|'([^']+)'|([^\s;&|)'"]+))/g;
function parseActivity(text) {
  const home = os.homedir();
  const all = [];  // [pos, ruta]
  const work = [];
  const fix = (p) => {
    if (typeof p !== 'string' || !p) return null;
    if (p === '~' || p.startsWith('~/')) p = path.join(home, p.slice(1));
    return path.isAbsolute(p) ? path.normalize(p) : null;
  };
  const add = (list, pos, p) => { p = fix(p); if (p) list.push([pos, p]); };

  const S = '((?:[^"\\\\]|\\\\.)*)';
  const re = new RegExp(`"(?:cwd|relocatedCwd)":"${S}"`, 'g');
  let m;
  while ((m = re.exec(text))) { try { add(all, m.index, JSON.parse(`"${m[1]}"`)); } catch {} }

  const TAG = '"type":"tool_use"';
  for (let i = text.indexOf(TAG); i >= 0; i = text.indexOf(TAG, i)) {
    const start = text.lastIndexOf('\n', i) + 1;
    let end = text.indexOf('\n', i);
    if (end < 0) end = text.length;
    i = end;
    let row;
    try { row = JSON.parse(text.slice(start, end)); } catch { continue; }
    const content = row?.message?.content;
    if (!Array.isArray(content)) continue;
    for (const b of content) {
      if (b?.type !== 'tool_use' || !b.input || typeof b.input !== 'object') continue;
      const inp = b.input;
      if (SHELL_TOOLS.has(b.name)) {
        let dirs = [];
        if (typeof inp.command === 'string') {
          let c;
          SHELL_DIR.lastIndex = 0;
          while ((c = SHELL_DIR.exec(inp.command))) dirs.push(c[1] || c[2] || c[3]);
        }
        dirs = dirs.map(fix).filter(Boolean);
        if (!dirs.length && row.cwd) dirs = [row.cwd];
        for (const d of dirs) { add(all, start, d); add(work, start, d); }
      } else {
        for (const k of ['file_path', 'notebook_path', 'path']) {
          add(all, start, inp[k]);
          if (WRITE_TOOLS.has(b.name)) add(work, start, inp[k]);
        }
      }
    }
  }
  const recent = (list, max) => {
    list.sort((x, y) => x[0] - y[0]); // estable: respeta el orden dentro de un mismo mensaje
    const seen = new Set();
    const out = [];
    for (let k = list.length - 1; k >= 0 && out.length < max; k--) {
      if (!seen.has(list[k][1])) { seen.add(list[k][1]); out.push(list[k][1]); }
    }
    return out.reverse();
  };
  return { paths: recent(all, MAX_PATHS), work: recent(work, 50) };
}

// Último registro {"type":"worktree-state","worktreeSession":{...}|null}: Claude Code lo
// escribe al entrar en un worktree (EnterWorktree / --worktree) y con null al salir.
function parseWorktree(text) {
  const at = text.lastIndexOf('"type":"worktree-state"');
  if (at < 0) return null;
  const start = text.lastIndexOf('\n', at) + 1;
  let end = text.indexOf('\n', at);
  if (end < 0) end = text.length;
  try {
    const w = JSON.parse(text.slice(start, end)).worktreeSession;
    if (!w || typeof w !== 'object' || !w.worktreePath) return null;
    return { path: w.worktreePath, branch: w.worktreeBranch || null, name: w.worktreeName || null, originalCwd: w.originalCwd || null };
  } catch { return null; }
}

async function sessions() {
  const maxAge = vscode.workspace.getConfiguration('claudeBranchStatus').get('maxAgeDays', 30) * 864e5;
  const now = Date.now();
  const out = [];
  let dirs = [];
  try { dirs = await fs.promises.readdir(PROJECTS_DIR); } catch { return out; }
  for (const d of dirs) {
    const dir = path.join(PROJECTS_DIR, d);
    let files = [];
    try { files = (await fs.promises.readdir(dir)).filter((f) => f.endsWith('.jsonl')); } catch { continue; }
    for (const f of files) {
      const file = path.join(dir, f);
      let st;
      try { st = await fs.promises.stat(file); } catch { continue; }
      if (now - st.mtimeMs > maxAge) continue;
      let c = cache.get(file);
      if (!c || c.mtimeMs !== st.mtimeMs || c.size !== st.size) {
        try {
          c = { mtimeMs: st.mtimeMs, size: st.size, info: parseTranscript(await fs.promises.readFile(file, 'utf8')) };
          cache.set(file, c);
        } catch { continue; }
      }
      out.push({ ...c.info, file, mtimeMs: st.mtimeMs, title: c.info.customTitle || c.info.aiTitle });
    }
  }
  // una sesión movida de carpeta (worktree) podría aparecer dos veces: nos quedamos con la más reciente
  const bySid = new Map();
  for (const s of out) {
    const prev = s.sessionId && bySid.get(s.sessionId);
    if (!prev || s.mtimeMs > prev.mtimeMs) bySid.set(s.sessionId || s.file, s);
  }
  return [...bySid.values()];
}

// Claude Code mueve el transcript a ~/.claude/projects/<carpeta del worktree>/<sessionId>.jsonl
// cuando la sesión cambia de directorio de proyecto: lo buscamos por su sessionId.
async function findSessionFile(sessionId) {
  if (!sessionId) return null;
  let dirs = [];
  try { dirs = await fs.promises.readdir(PROJECTS_DIR); } catch { return null; }
  let best = null;
  for (const d of dirs) {
    const file = path.join(PROJECTS_DIR, d, `${sessionId}.jsonl`);
    try {
      const st = await fs.promises.stat(file);
      if (st.isFile() && (!best || st.mtimeMs > best.mtimeMs)) best = { file, mtimeMs: st.mtimeMs };
    } catch {}
  }
  return best && best.file;
}

async function readSession(file) {
  const st = await fs.promises.stat(file);
  let c = cache.get(file);
  if (!c || c.mtimeMs !== st.mtimeMs || c.size !== st.size) {
    c = { mtimeMs: st.mtimeMs, size: st.size, info: parseTranscript(await fs.promises.readFile(file, 'utf8')) };
    cache.set(file, c);
  }
  return { ...c.info, file, mtimeMs: st.mtimeMs, title: c.info.customTitle || c.info.aiTitle };
}

const under = (p, root) => !!p && (p === root || p.startsWith(root.endsWith(path.sep) ? root : root + path.sep));

// Claude Code pone de título lTe(t): >25 chars -> 24 chars + '…'; compara con espacios normalizados.
const norm = (s) => String(s).replace(/\s+/g, ' ').trim();
function titleMatches(label, title) {
  if (!label || !title) return false;
  const l = norm(label), t = norm(title);
  if (l === t) return true;
  if (l.endsWith('…')) {
    const pre = l.slice(0, -1);
    return pre !== '' && t.startsWith(pre);
  }
  return false;
}

function activeClaudeTab() {
  const tab = vscode.window.tabGroups.activeTabGroup?.activeTab;
  if (tab && tab.input instanceof vscode.TabInputWebview && /claudeVSCodePanel/.test(tab.input.viewType)) return tab;
  return null;
}

function git(cwd, args) {
  return new Promise((res) => execFile('git', ['-C', cwd, ...args], { timeout: 3000 }, (e, so) => res(e ? null : so.trim())));
}

// carpeta existente más cercana -> { top, common } del repo git (o null). La pertenencia de una
// carpeta a un repo apenas cambia, así que se cachea; la rama se consulta en cada refresco.
const repoCache = new Map();
async function nearestDir(p) {
  for (let d = p; ; d = path.dirname(d)) {
    try { const st = await fs.promises.stat(d); return st.isDirectory() ? d : path.dirname(d); } catch {}
    if (path.dirname(d) === d) return null;
  }
}
async function repoOf(p) {
  const dir = await nearestDir(p);
  if (!dir) return null;
  if (repoCache.has(dir)) return repoCache.get(dir);
  const out = await git(dir, ['rev-parse', '--path-format=absolute', '--show-toplevel', '--git-common-dir']);
  const [top, common] = out ? out.split('\n') : [];
  const r = top && common ? { top, common } : null;
  repoCache.set(dir, r);
  return r;
}

// Repos en los que trabaja la sesión (máx. MAX_REPOS). Un worktree es una entrada propia, con el
// nombre del repo principal. "active" es el repo donde Claude ha trabajado por última vez
// (o, si no ha hecho nada, el del cwd); va primero, luego el del cwd y el resto por recencia.
const MAX_REPOS = 10;
function describe(r, extra) {
  const worktree = path.resolve(r.common) !== path.resolve(r.top, '.git');
  const name = path.basename(path.basename(r.common) === '.git' ? path.dirname(r.common) : r.common.replace(/\.git$/, ''));
  return { top: r.top, name, worktree, ...extra };
}
async function sessionRepos(s) {
  const cwd = s.worktree?.path || s.cwd;
  const cwdRepo = cwd ? await repoOf(cwd) : null;
  let activeRepo = null;
  for (const p of [...(s.work || [])].reverse()) {
    if ((activeRepo = await repoOf(p))) break;
  }
  activeRepo = activeRepo || cwdRepo;
  const byTop = new Map();
  const put = (r) => {
    if (!r || byTop.has(r.top) || byTop.size >= MAX_REPOS) return;
    byTop.set(r.top, describe(r, { isSession: r.top === cwdRepo?.top, isActive: r.top === activeRepo?.top }));
  };
  put(activeRepo);
  put(cwdRepo);
  for (const p of [...(s.work || []), ...(s.paths || [])].reverse()) {
    if (byTop.size >= MAX_REPOS) break;
    put(await repoOf(p));
  }
  const repos = [...byTop.values()];
  await Promise.all(repos.map(async (r) => { r.branch = await git(r.top, ['rev-parse', '--abbrev-ref', 'HEAD']); }));
  return repos;
}

async function folderBranch() {
  const f = vscode.workspace.workspaceFolders?.[0];
  return f ? git(f.uri.fsPath, ['rev-parse', '--abbrev-ref', 'HEAD']) : null;
}

let busy = false;
let again = false;
async function refresh() {
  // si llega un evento mientras refrescamos, no se pierde: se repite al terminar
  if (busy) { again = true; return; }
  busy = true;
  try {
    do {
      again = false;
      await refreshOnce();
    } while (again);
  } finally {
    busy = false;
  }
}

async function refreshOnce() {
  {
    const tab = activeClaudeTab();
    if (tab) {
      const label = norm(tab.label);
      const all = await sessions();
      const wsPaths = (vscode.workspace.workspaceFolders || []).map((w) => w.uri.fsPath);
      const match = all
        .filter((s) => titleMatches(label, s.title))
        .sort((a, b) => {
          // prioriza sesiones de esta carpeta (o worktrees hermanos), luego la más reciente
          const mine = (s) => wsPaths.some((p) => [s.cwd, s.worktree?.path, s.worktree?.originalCwd].some((c) => under(c, p))) ? 1 : 0;
          const wa = mine(a);
          const wb = mine(b);
          return wb - wa || b.mtimeMs - a.mtimeMs;
        })[0];
      current = match ? { ...match, label } : { label, branch: null };
    } else if (current?.file) {
      // pestaña no-Claude: mantenemos la última sesión, refrescando su rama
      let s = null;
      try { s = await readSession(current.file); } catch {
        // el transcript se ha movido (p. ej. Claude entró en un worktree): lo buscamos por sessionId
        const moved = await findSessionFile(current.sessionId);
        if (moved) { try { s = await readSession(moved); } catch {} }
      }
      if (s) current = { ...current, ...s };
    }
    await render(!!tab);
  }
}

async function render(isActive) {
  if (!current) { item.hide(); return; }
  const fb = await folderBranch();
  const wt = current.worktree;
  const cwd = wt?.path || current.cwd;
  const liveCwd = cwd ? await git(cwd, ['rev-parse', '--abbrev-ref', 'HEAD']) : null;
  const repos = await sessionRepos(current);
  current.repos = repos;
  // Claude trabaja en otro repo/worktree distinto de su cwd (p. ej. "cd ../repo-160 && …")
  const away = repos.find((r) => r.isActive && !r.isSession) || null;
  current.away = away;
  // en un worktree o en otro repo manda lo que hay ahora en disco; si no, lo que registró Claude
  const sessionBranch = away ? away.branch : (wt && (liveCwd || wt.branch)) || current.branch;
  current.effectiveBranch = sessionBranch;
  const forked = away ? away.worktree : !!wt;
  const branch = sessionBranch || '?';
  const differs = sessionBranch && fb && sessionBranch !== fb;
  // repos además del principal (si la sesión no está en ningún repo, cuentan todos)
  const others = repos.filter((r) => !r.isActive);
  const multi = others.length > 0;
  item.text = `$(sparkle) ${branch}${forked ? ' $(repo-forked)' : ''}${multi ? ` +${others.length}` : ''}${differs ? ' $(warning)' : ''}`;
  item.backgroundColor = differs ? new vscode.ThemeColor('statusBarItem.warningBackground') : undefined;
  const md = new vscode.MarkdownString(undefined, true);
  md.appendMarkdown(`**Claude Code session:** ${current.label || current.title || '?'}${isActive ? '' : ' _(last active)_'}\n\n`);
  md.appendMarkdown(`- Session branch: \`${branch}\`${forked ? ' (worktree)' : ''}\n`);
  if (away) md.appendMarkdown(`- Working in: \`${away.top}\`${away.worktree ? ' (worktree)' : ''}\n`);
  md.appendMarkdown(`- Workspace folder branch: \`${fb || '?'}\`\n`);
  if (wt) md.appendMarkdown(`- Worktree: \`${wt.path}\`\n`);
  if (cwd && (!wt || away)) md.appendMarkdown(`- Session cwd: \`${cwd}\`${liveCwd ? ` (now on \`${liveCwd}\`)` : ''}\n`);
  if (current.sessionId) md.appendMarkdown(`- sessionId: \`${current.sessionId}\`\n`);
  if (multi) {
    md.appendMarkdown(`\n**Repos in this session:**\n\n`);
    for (const r of repos) {
      md.appendMarkdown(`- ${r.worktree ? '$(repo-forked)' : '$(repo)'} **${r.name}** → \`${r.branch || '?'}\`` +
        `${r.worktree ? ' (worktree)' : ''}${r.isActive ? ' _(active)_' : ''}${r.isSession ? ' _(session cwd)_' : ''} — \`${r.top}\`\n`);
    }
  }
  if (!current.file) md.appendMarkdown(`\n_No transcript found for this tab._`);
  if (differs) md.appendMarkdown(`\n\n$(warning) This session is on a different branch than the workspace folder.`);
  item.tooltip = md;
  item.show();
}

const branchOf = (c) => c.effectiveBranch || c.worktree?.branch || c.branch;

function activate(ctx) {
  // El indicador de Git (SCM) va a la izquierda con prioridad alta; justo detrás.
  item = vscode.window.createStatusBarItem('claudeBranchStatus', vscode.StatusBarAlignment.Left, 9999);
  item.name = 'Session Branch for Claude Code';
  item.command = 'claudeBranchStatus.info';
  ctx.subscriptions.push(
    item,
    vscode.window.tabGroups.onDidChangeTabs(refresh),
    vscode.window.tabGroups.onDidChangeTabGroups(refresh),
    vscode.commands.registerCommand('claudeBranchStatus.refresh', refresh),
    vscode.commands.registerCommand('claudeBranchStatus.info', async () => {
      if (!current) return vscode.window.showInformationMessage('No active Claude Code session.');
      const pick = await vscode.window.showInformationMessage(
        `Session "${current.label || current.title}" → branch ${branchOf(current) || '?'}${current.away ? ` (${current.away.worktree ? 'worktree ' : ''}${current.away.top})` : current.worktree ? ` (worktree ${current.worktree.path})` : current.cwd ? ` (${current.cwd})` : ''}` +
        (current.repos?.some((r) => !r.isActive)
          ? ` · Repos: ${current.repos.map((r) => `${r.name}${r.worktree ? ' (worktree)' : ''} → ${r.branch || '?'}`).join(', ')}`
          : ''),
        'Copy branch', 'Copy session ID');
      if (pick === 'Copy branch' && branchOf(current)) vscode.env.clipboard.writeText(branchOf(current));
      if (pick === 'Copy session ID' && current.sessionId) vscode.env.clipboard.writeText(current.sessionId);
    }),
  );
  const t = setInterval(refresh, 5000); // la rama puede cambiar a mitad de sesión
  ctx.subscriptions.push({ dispose: () => clearInterval(t) });
  refresh();
}

function deactivate() {}
module.exports = {
  activate,
  deactivate,
  // solo para tests
  _test: { parseActivity, sessionRepos, repoCache, parseTranscript, titleMatches, sessions, findSessionFile, activeClaudeTab, refresh, getCurrent: () => current, getItem: () => item, cache },
};
