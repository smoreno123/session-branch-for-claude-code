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
  const last = (re) => { let m, v = null; while ((m = re.exec(text))) v = m[1]; return v; };
  const unq = (s) => { try { return s == null ? null : JSON.parse(`"${s}"`); } catch { return s; } };
  const S = '((?:[^"\\\\]|\\\\.)*)';
  return {
    customTitle: unq(last(new RegExp(`"customTitle":"${S}"`, 'g'))),
    aiTitle: unq(last(new RegExp(`"aiTitle":"${S}"`, 'g'))),
    branch: unq(last(new RegExp(`"gitBranch":"${S}"`, 'g'))),
    cwd: unq(last(new RegExp(`"cwd":"${S}"`, 'g'))),
    sessionId: unq(last(new RegExp(`"sessionId":"${S}"`, 'g'))),
  };
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
  return out;
}

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
          const wa = wsPaths.some((p) => a.cwd && a.cwd.startsWith(p)) ? 1 : 0;
          const wb = wsPaths.some((p) => b.cwd && b.cwd.startsWith(p)) ? 1 : 0;
          return wb - wa || b.mtimeMs - a.mtimeMs;
        })[0];
      current = match ? { ...match, label } : { label, branch: null };
    } else if (current?.file) {
      // pestaña no-Claude: mantenemos la última sesión, refrescando su rama
      const c = cache.get(current.file);
      try {
        const st = await fs.promises.stat(current.file);
        if (!c || c.mtimeMs !== st.mtimeMs) {
          const info = parseTranscript(await fs.promises.readFile(current.file, 'utf8'));
          cache.set(current.file, { mtimeMs: st.mtimeMs, size: st.size, info });
          current = { ...current, ...info };
        }
      } catch {}
    }
    await render(!!tab);
  }
}

async function render(isActive) {
  if (!current) { item.hide(); return; }
  const fb = await folderBranch();
  const liveCwd = current.cwd ? await git(current.cwd, ['rev-parse', '--abbrev-ref', 'HEAD']) : null;
  const branch = current.branch || '?';
  const differs = current.branch && fb && current.branch !== fb;
  item.text = `$(sparkle) ${branch}${differs ? ' $(warning)' : ''}`;
  item.backgroundColor = differs ? new vscode.ThemeColor('statusBarItem.warningBackground') : undefined;
  const md = new vscode.MarkdownString(undefined, true);
  md.appendMarkdown(`**Claude Code session:** ${current.label || current.title || '?'}${isActive ? '' : ' _(last active)_'}\n\n`);
  md.appendMarkdown(`- Session branch: \`${branch}\`\n`);
  md.appendMarkdown(`- Workspace folder branch: \`${fb || '?'}\`\n`);
  if (current.cwd) md.appendMarkdown(`- Session cwd: \`${current.cwd}\`${liveCwd ? ` (now on \`${liveCwd}\`)` : ''}\n`);
  if (current.sessionId) md.appendMarkdown(`- sessionId: \`${current.sessionId}\`\n`);
  if (!current.file) md.appendMarkdown(`\n_No transcript found for this tab._`);
  if (differs) md.appendMarkdown(`\n\n$(warning) This session is on a different branch than the workspace folder.`);
  item.tooltip = md;
  item.show();
}

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
        `Session "${current.label || current.title}" → branch ${current.branch || '?'}${current.cwd ? ` (${current.cwd})` : ''}`,
        'Copy branch', 'Copy session ID');
      if (pick === 'Copy branch' && current.branch) vscode.env.clipboard.writeText(current.branch);
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
  _test: { parseTranscript, titleMatches, sessions, activeClaudeTab, refresh, getCurrent: () => current, getItem: () => item, cache },
};
