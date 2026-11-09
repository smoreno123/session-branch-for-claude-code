// Tests de la extensión con un `vscode` simulado, transcripts .jsonl y repos git
// reales en un HOME temporal. Ejecutar: npm test  (node --test)
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const Module = require('module');

// ---------- entorno: HOME temporal (antes de cargar la extensión) ----------
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'cbs-test-'));
process.env.HOME = TMP;
const PROJ = path.join(TMP, '.claude', 'projects');
fs.mkdirSync(PROJ, { recursive: true });

function gitRepo(dir, branch) {
  fs.mkdirSync(dir, { recursive: true });
  const g = (...a) => execFileSync('git', ['-C', dir, ...a], { stdio: 'pipe' });
  g('init', '-q', '-b', branch);
  g('-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '--allow-empty', '-m', 'init');
  return { dir, checkout: (b) => g('checkout', '-q', '-B', b) };
}
const WS = gitRepo(path.join(TMP, 'ws', 'repo'), 'main');
const WT = gitRepo(path.join(TMP, 'ws', 'repo-174'), 'feature-174');
const OTHER = gitRepo(path.join(TMP, 'otro'), 'main');

let n = 0;
function transcript({ dir = 'proj', title, custom, branch, cwd = WS.dir, sessionId, lines, ageDays = 0 } = {}) {
  const sid = sessionId || `s${++n}`;
  const d = path.join(PROJ, dir);
  fs.mkdirSync(d, { recursive: true });
  const rows = lines || [
    { type: 'user', sessionId: sid, cwd, gitBranch: branch, message: { content: 'hola "con comillas" y \\ barra' } },
    ...(title !== undefined ? [{ type: 'ai-title', aiTitle: title, sessionId: sid }] : []),
    ...(custom !== undefined ? [{ type: 'custom-title', customTitle: custom, sessionId: sid }] : []),
  ];
  const f = path.join(d, `${sid}.jsonl`);
  fs.writeFileSync(f, rows.map((r) => JSON.stringify(r)).join('\n') + '\n');
  if (ageDays) {
    const t = (Date.now() - ageDays * 864e5) / 1000;
    fs.utimesSync(f, t, t);
  }
  return f;
}

// ---------- vscode simulado ----------
class TabInputWebview { constructor(viewType) { this.viewType = viewType; } }
class TabInputText { constructor(uri) { this.uri = uri; } }
class ThemeColor { constructor(id) { this.id = id; } }
class MarkdownString {
  constructor(v = '', supportThemeIcons) { this.value = v; this.supportThemeIcons = supportThemeIcons; }
  appendMarkdown(s) { this.value += s; return this; }
}
const listeners = { tabs: [], groups: [] };
const commands = {};
const messages = [];
let clipboard = null;
let msgAnswer;
let config = {};
const vscode = {
  TabInputWebview, TabInputText, ThemeColor, MarkdownString,
  StatusBarAlignment: { Left: 1, Right: 2 },
  window: {
    tabGroups: {
      activeTabGroup: { activeTab: undefined },
      onDidChangeTabs: (fn) => (listeners.tabs.push(fn), { dispose() {} }),
      onDidChangeTabGroups: (fn) => (listeners.groups.push(fn), { dispose() {} }),
    },
    createStatusBarItem(id, alignment, priority) {
      return { id, alignment, priority, text: '', visible: false, show() { this.visible = true; }, hide() { this.visible = false; }, dispose() {} };
    },
    showInformationMessage: async (msg, ...items) => { messages.push({ msg, items }); return msgAnswer; },
  },
  workspace: {
    workspaceFolders: [{ uri: { fsPath: WS.dir } }],
    getConfiguration: () => ({ get: (k, d) => (k in config ? config[k] : d) }),
  },
  commands: { registerCommand: (id, fn) => ((commands[id] = fn), { dispose() {} }) },
  env: { clipboard: { writeText: async (t) => { clipboard = t; } } },
};
const origLoad = Module._load;
Module._load = (req, ...a) => (req === 'vscode' ? vscode : origLoad(req, ...a));

const ext = require('../extension.js');
const T = ext._test;
const ctx = { subscriptions: [] };

const VIEW = 'mainThreadWebview-claudeVSCodePanel';
function setTab(label, viewType = VIEW, Input = TabInputWebview) {
  vscode.window.tabGroups.activeTabGroup = { activeTab: label === null ? undefined : { label, input: new Input(viewType) } };
}
async function switchTo(label, viewType) { setTab(label, viewType); await T.refresh(); return T.getItem(); }

test.after(() => {
  for (const d of ctx.subscriptions) d.dispose?.();
  fs.rmSync(TMP, { recursive: true, force: true });
});

// ======================= parseTranscript =======================
test('parseTranscript: campos básicos', () => {
  const r = T.parseTranscript(fs.readFileSync(transcript({ title: 'A', branch: 'main', sessionId: 'p1' }), 'utf8'));
  assert.deepEqual(r, { customTitle: null, aiTitle: 'A', branch: 'main', cwd: WS.dir, sessionId: 'p1', worktree: null, paths: [WS.dir], work: [] });
});

test('parseTranscript: se queda con la ÚLTIMA aparición (rama y título cambian)', () => {
  const lines = [
    { type: 'user', sessionId: 'x', cwd: '/a', gitBranch: 'main' },
    { type: 'ai-title', aiTitle: 'viejo', sessionId: 'x' },
    { type: 'user', sessionId: 'x', cwd: '/b', gitBranch: 'feat' },
    { type: 'ai-title', aiTitle: 'nuevo', sessionId: 'x' },
  ];
  const r = T.parseTranscript(lines.map((l) => JSON.stringify(l)).join('\n'));
  assert.equal(r.aiTitle, 'nuevo');
  assert.equal(r.branch, 'feat');
  assert.equal(r.cwd, '/b');
});

test('parseTranscript: escapes JSON (comillas, barras, unicode, emoji)', () => {
  const title = 'Cita "urgente" C:\\ruta — ñandú 🦄 \t tab';
  const r = T.parseTranscript(JSON.stringify({ type: 'ai-title', aiTitle: title, gitBranch: 'feat/año-ü' }));
  assert.equal(r.aiTitle, title);
  assert.equal(r.branch, 'feat/año-ü');
  // ensure_ascii estilo \u00f1
  const r2 = T.parseTranscript('{"aiTitle":"Ni\\u00f1o \\ud83e\\udd84"}');
  assert.equal(r2.aiTitle, 'Niño 🦄');
});

test('parseTranscript: contenido del usuario que imita un campo no rompe nada', () => {
  // un mensaje cuyo texto contiene "gitBranch":"falsa" va escapado dentro de un string JSON
  const lines = [
    { type: 'user', sessionId: 'x', cwd: '/a', gitBranch: 'real', message: { content: '"gitBranch":"falsa"' } },
  ];
  const r = T.parseTranscript(lines.map((l) => JSON.stringify(l)).join('\n'));
  assert.equal(r.branch, 'real');
});

test('parseTranscript: vacío / basura / líneas cortadas', () => {
  assert.deepEqual(T.parseTranscript(''), { customTitle: null, aiTitle: null, branch: null, cwd: null, sessionId: null, worktree: null, paths: [], work: [] });
  const r = T.parseTranscript('no json\n{"aiTitle":"ok","gitBranch":"m"}\n{"aiTitle":"cort');
  assert.equal(r.aiTitle, 'ok');
  assert.equal(r.branch, 'm');
});

test('parseTranscript: gitBranch vacío (carpeta sin git)', () => {
  const r = T.parseTranscript('{"gitBranch":""}');
  assert.equal(r.branch, '');
});

test('parseTranscript: rendimiento con transcript grande (~20 MB)', () => {
  const line = JSON.stringify({ type: 'assistant', sessionId: 'big', cwd: '/a', gitBranch: 'main', message: { content: 'x'.repeat(2000) } });
  const big = Array(10000).fill(line).join('\n') + '\n{"aiTitle":"fin","gitBranch":"ultima"}';
  const t0 = Date.now();
  const r = T.parseTranscript(big);
  const ms = Date.now() - t0;
  assert.equal(r.branch, 'ultima');
  assert.ok(ms < 1500, `tarda ${ms} ms`);
});

test('parseTranscript: worktree-state (entrar / salir) y relocatedCwd', () => {
  const wt = { originalCwd: '/repo', worktreePath: '/repo/.claude/worktrees/x', worktreeName: 'x', worktreeBranch: 'worktree-x', originalBranch: 'main' };
  const enter = [
    { type: 'user', sessionId: 'w', cwd: '/repo', gitBranch: 'main' },
    { type: 'relocated', sessionId: 'w', relocatedCwd: '/repo/.claude/worktrees/x' },
    { type: 'worktree-state', worktreeSession: wt, sessionId: 'w' },
  ];
  const r = T.parseTranscript(enter.map((l) => JSON.stringify(l)).join('\n') + '\n');
  assert.deepEqual(r.worktree, { path: wt.worktreePath, branch: 'worktree-x', name: 'x', originalCwd: '/repo' });
  assert.equal(r.cwd, '/repo/.claude/worktrees/x', 'relocatedCwd posterior al último cwd manda');
  const exit = [...enter, { type: 'worktree-state', worktreeSession: null, sessionId: 'w' }, { type: 'user', sessionId: 'w', cwd: '/repo', gitBranch: 'main' }];
  const r2 = T.parseTranscript(exit.map((l) => JSON.stringify(l)).join('\n'));
  assert.equal(r2.worktree, null, 'al salir del worktree se olvida');
  assert.equal(r2.cwd, '/repo');
  // un mensaje del usuario que menciona el registro no cuenta
  const fake = JSON.stringify({ type: 'user', message: { content: '{"type":"worktree-state","worktreeSession":{"worktreePath":"/x"}}' } });
  assert.equal(T.parseTranscript(fake).worktree, null);
});

// ======================= titleMatches =======================
test('titleMatches: exacto, espacios, truncado con …', () => {
  assert.ok(T.titleMatches('173_last_visit', '173_last_visit'));
  assert.ok(T.titleMatches('  Huecos  de citas ', 'Huecos de citas'));
  assert.ok(T.titleMatches('Pruebas de voz de Esplug…', 'Pruebas de voz de Esplugues'));
  assert.ok(!T.titleMatches('Pruebas de voz de Esplug…', 'Pruebas de umbert'));
  assert.ok(!T.titleMatches('173_last_visit', '173_last_visit_2'), 'sin … no es prefijo');
  assert.ok(!T.titleMatches('…', 'cualquiera'), '… solo no casa con todo');
  assert.ok(!T.titleMatches('', 'x'));
  assert.ok(!T.titleMatches('x', null));
  assert.ok(!T.titleMatches('Claude Code', 'Otra'));
});

test('titleMatches: reproduce exactamente el truncado de Claude Code (lTe)', () => {
  const lTe = (e) => (!e ? 'Claude Code' : e.length > 25 ? e.substring(0, 24) + '…' : e);
  for (const t of ['corto', 'exactamente veinticinco c', 'exactamente veinticinco ch', 'Rama 160_mejora_entrega_huecos larga', 'Ñandú '.repeat(10)]) {
    assert.ok(T.titleMatches(lTe(t), t), `no casa: ${t}`);
  }
});

// ======================= sessions() =======================
test('sessions: lee varios proyectos, ignora no-jsonl, antiguos y carpetas rotas', async () => {
  fs.mkdirSync(path.join(PROJ, 'vacio'), { recursive: true });
  fs.writeFileSync(path.join(PROJ, 'fichero-suelto.jsonl'), '{}'); // fichero en la raíz, no carpeta
  fs.writeFileSync(path.join(PROJ, 'proj', 'notas.txt'), '{"aiTitle":"txt"}');
  transcript({ title: 'reciente', branch: 'main', sessionId: 'rec' });
  transcript({ dir: 'proj2', title: 'otro proyecto', branch: 'dev', sessionId: 'p2' });
  transcript({ title: 'antiguo', branch: 'main', sessionId: 'old', ageDays: 60 });
  const all = await T.sessions();
  const titles = all.map((s) => s.title);
  assert.ok(titles.includes('reciente'));
  assert.ok(titles.includes('otro proyecto'));
  assert.ok(!titles.includes('antiguo'), 'más de maxAgeDays');
  assert.ok(!titles.includes('txt'));
});

test('sessions: maxAgeDays configurable', async () => {
  config.maxAgeDays = 90;
  assert.ok((await T.sessions()).some((s) => s.title === 'antiguo'));
  config = {};
});

test('sessions: customTitle tiene prioridad sobre aiTitle', async () => {
  transcript({ title: 'ia', custom: 'renombrada', branch: 'main', sessionId: 'ren' });
  const s = (await T.sessions()).find((x) => x.sessionId === 'ren');
  assert.equal(s.title, 'renombrada');
});

test('sessions: caché por mtime/tamaño y relectura al cambiar', async () => {
  const f = transcript({ title: 'cacheada', branch: 'b1', sessionId: 'cch' });
  await T.sessions();
  const c1 = T.cache.get(f);
  await T.sessions();
  assert.equal(T.cache.get(f), c1, 'sin cambios no relee');
  fs.appendFileSync(f, JSON.stringify({ type: 'user', sessionId: 'cch', gitBranch: 'b2', cwd: WS.dir }) + '\n');
  const s = (await T.sessions()).find((x) => x.sessionId === 'cch');
  assert.equal(s.branch, 'b2');
});

test('sessions: sin carpeta de proyectos devuelve []', async () => {
  const bak = PROJ + '.bak';
  fs.renameSync(PROJ, bak);
  try { assert.deepEqual(await T.sessions(), []); } finally { fs.renameSync(bak, PROJ); }
});

test('sessions: fichero ilegible se salta sin romper', { skip: process.getuid?.() === 0 }, async () => {
  const f = transcript({ title: 'ilegible', branch: 'x', sessionId: 'ileg' });
  fs.chmodSync(f, 0o000);
  try {
    const all = await T.sessions();
    assert.ok(!all.some((s) => s.sessionId === 'ileg'));
    assert.ok(all.length > 0);
  } finally { fs.chmodSync(f, 0o644); }
});

// ======================= activeClaudeTab =======================
test('activeClaudeTab: solo pestañas webview de Claude Code', () => {
  setTab('x', VIEW); assert.ok(T.activeClaudeTab());
  setTab('x', 'claudeVSCodePanel'); assert.ok(T.activeClaudeTab(), 'viewType sin prefijo');
  setTab('x', 'mainThreadWebview-claudePlanPreview'); assert.equal(T.activeClaudeTab(), null);
  setTab('x', 'markdown.preview'); assert.equal(T.activeClaudeTab(), null);
  vscode.window.tabGroups.activeTabGroup = { activeTab: { label: 'f.js', input: new TabInputText({}) } };
  assert.equal(T.activeClaudeTab(), null);
  setTab(null); assert.equal(T.activeClaudeTab(), null);
  vscode.window.tabGroups.activeTabGroup = undefined; assert.equal(T.activeClaudeTab(), null);
});

// ======================= activate + refresh/render =======================
test('activate: crea item a la izquierda junto a Git y registra comandos/eventos', async () => {
  setTab(null);
  ext.activate(ctx);
  const item = T.getItem();
  assert.equal(item.alignment, vscode.StatusBarAlignment.Left);
  assert.ok(item.priority > 0);
  assert.equal(item.command, 'claudeBranchStatus.info');
  assert.ok(commands['claudeBranchStatus.info'] && commands['claudeBranchStatus.refresh']);
  assert.equal(listeners.tabs.length, 1);
  await T.refresh();
  assert.equal(item.visible, false, 'sin sesión no se muestra');
});

test('render: misma rama que la carpeta → sin aviso', async () => {
  transcript({ title: 'misma rama', branch: 'main', sessionId: 'same' });
  const item = await switchTo('misma rama');
  assert.equal(item.visible, true);
  assert.equal(item.text, '$(sparkle) main');
  assert.equal(item.backgroundColor, undefined);
  assert.match(item.tooltip.value, /Workspace folder branch: `main`/);
  assert.match(item.tooltip.value, /sessionId: `same`/);
});

test('render: rama distinta → aviso amarillo', async () => {
  transcript({ title: 'rama distinta', branch: 'feature-x', sessionId: 'diff' });
  const item = await switchTo('rama distinta');
  assert.equal(item.text, '$(sparkle) feature-x $(warning)');
  assert.equal(item.backgroundColor?.id, 'statusBarItem.warningBackground');
  assert.match(item.tooltip.value, /different branch than the workspace/);
});

test('render: título truncado de Claude Code encuentra la sesión', async () => {
  transcript({ title: 'Pruebas de voz de Esplugues con todos', branch: 'esplugues', sessionId: 'trunc' });
  const item = await switchTo('Pruebas de voz de Esplugu…');
  assert.equal(T.getCurrent().sessionId, 'trunc');
  assert.match(item.text, /esplugues/);
});

test('render: sesión en worktree → muestra la rama del worktree y la real de su cwd', async () => {
  transcript({ dir: 'wt', title: 'en worktree', branch: 'feature-174', cwd: WT.dir, sessionId: 'wt' });
  const item = await switchTo('en worktree');
  assert.match(item.text, /feature-174 \$\(warning\)/);
  assert.match(item.tooltip.value, new RegExp(`Session cwd: \`${WT.dir}\` \\(now on \`feature-174\`\\)`));
});

test('render: la carpeta cambia de rama → el aviso se actualiza', async () => {
  transcript({ title: 'sigue carpeta', branch: 'dev', sessionId: 'sc' });
  let item = await switchTo('sigue carpeta');
  assert.match(item.text, /\$\(warning\)/);
  WS.checkout('dev');
  try {
    item = await switchTo('sigue carpeta');
    assert.equal(item.text, '$(sparkle) dev');
  } finally { WS.checkout('main'); }
});

test('render: títulos duplicados → prioriza la de esta carpeta y luego la más reciente', async () => {
  transcript({ dir: 'a', title: 'dup', branch: 'de-otro-proyecto', cwd: OTHER.dir, sessionId: 'dupOther' });
  transcript({ title: 'dup', branch: 'vieja', sessionId: 'dupOld', ageDays: 2 });
  transcript({ title: 'dup', branch: 'nueva', sessionId: 'dupNew', ageDays: 1 });
  // la de otro proyecto es la más reciente de todas
  const f = transcript({ dir: 'a', title: 'dup', branch: 'de-otro-proyecto', cwd: OTHER.dir, sessionId: 'dupOther' });
  fs.utimesSync(f, new Date(), new Date());
  await switchTo('dup');
  assert.equal(T.getCurrent().sessionId, 'dupNew');
});

test('render: pestaña sin sesión conocida (p. ej. "Claude Code" recién abierta)', async () => {
  const item = await switchTo('Claude Code');
  assert.equal(item.visible, true);
  assert.equal(item.text, '$(sparkle) ?');
  assert.match(item.tooltip.value, /No transcript found/);
});

test('render: pestaña no-Claude mantiene la última sesión y sigue su rama', async () => {
  const f = transcript({ title: 'persistente', branch: 'p1', sessionId: 'pers' });
  await switchTo('persistente');
  setTab('archivo.js', 'default');
  await T.refresh();
  assert.equal(T.getCurrent().sessionId, 'pers');
  assert.match(T.getItem().tooltip.value, /_\(last active\)_/);
  // la sesión cambia de rama mientras estamos en otra pestaña
  fs.appendFileSync(f, JSON.stringify({ type: 'user', sessionId: 'pers', gitBranch: 'p2', cwd: WS.dir }) + '\n');
  await T.refresh();
  assert.match(T.getItem().text, /p2/);
});

test('render: el transcript de la última sesión desaparece → no rompe', async () => {
  const f = transcript({ title: 'borrable', branch: 'b', sessionId: 'del' });
  await switchTo('borrable');
  fs.rmSync(f);
  setTab(null);
  await T.refresh();
  assert.equal(T.getItem().visible, true);
});

test('render: sin carpeta abierta / carpeta no git / cwd inexistente', async () => {
  transcript({ title: 'sin ws', branch: 'x', cwd: '/no/existe', sessionId: 'nows' });
  const bak = vscode.workspace.workspaceFolders;
  vscode.workspace.workspaceFolders = undefined;
  try {
    const item = await switchTo('sin ws');
    assert.equal(item.text, '$(sparkle) x', 'sin carpeta no hay aviso');
    assert.match(item.tooltip.value, /folder branch: `\?`/);
    assert.doesNotMatch(item.tooltip.value, /now on/);
    vscode.workspace.workspaceFolders = [{ uri: { fsPath: TMP } }]; // no es repo git
    assert.equal((await switchTo('sin ws')).text, '$(sparkle) x');
  } finally { vscode.workspace.workspaceFolders = bak; }
});

test('render: gitBranch vacío no da falso aviso', async () => {
  transcript({ title: 'sin git', branch: '', sessionId: 'ng' });
  const item = await switchTo('sin git');
  assert.equal(item.text, '$(sparkle) ?');
  assert.equal(item.backgroundColor, undefined);
});

test('render: caracteres markdown en título/rama no rompen el tooltip', async () => {
  transcript({ title: 'título *raro* [x](y) `z`', branch: 'feat/a_b', sessionId: 'md' });
  const item = await switchTo('título *raro* [x](y) `z`');
  assert.match(item.text, /feat\/a_b/);
  assert.ok(item.tooltip.value.length > 0);
});

// ======================= concurrencia =======================
test('refresh: un cambio de pestaña durante un refresco no se pierde', async () => {
  transcript({ title: 'primera', branch: 'uno', sessionId: 'c1' });
  transcript({ title: 'segunda', branch: 'dos', sessionId: 'c2' });
  setTab('primera');
  const p1 = T.refresh();            // empieza a refrescar "primera"
  setTab('segunda');
  const p2 = T.refresh();            // llega el evento mientras está ocupado
  await Promise.all([p1, p2]);
  assert.equal(T.getCurrent().sessionId, 'c2', 'debe acabar mostrando la pestaña actual');
  assert.match(T.getItem().text, /dos/);
});

test('refresh: ráfaga de 50 eventos → estado final correcto y sin excepciones', async () => {
  for (let i = 0; i < 5; i++) transcript({ title: `rafaga ${i}`, branch: `r${i}`, sessionId: `raf${i}` });
  const ps = [];
  for (let i = 0; i < 50; i++) { setTab(`rafaga ${i % 5}`); ps.push(T.refresh()); }
  setTab('rafaga 3');
  ps.push(T.refresh());
  await Promise.all(ps);
  assert.equal(T.getCurrent().sessionId, 'raf3');
});

test('refresh: los listeners de VS Code disparan el refresco', async () => {
  transcript({ title: 'por evento', branch: 'ev', sessionId: 'ev' });
  setTab('por evento');
  await listeners.tabs[0]();
  assert.equal(T.getCurrent().sessionId, 'ev');
});

// ======================= comandos =======================
test('comando info: copia rama y sessionId', async () => {
  transcript({ title: 'copiar', branch: 'rama-copiada', sessionId: 'sid-copia' });
  await switchTo('copiar');
  msgAnswer = 'Copy branch';
  await commands['claudeBranchStatus.info']();
  assert.equal(clipboard, 'rama-copiada');
  msgAnswer = 'Copy session ID';
  await commands['claudeBranchStatus.info']();
  assert.equal(clipboard, 'sid-copia');
  msgAnswer = undefined; // cerrar el aviso no copia nada
  clipboard = null;
  await commands['claudeBranchStatus.info']();
  assert.equal(clipboard, null);
  assert.match(messages.at(-1).msg, /"copiar" → branch rama-copiada/);
});

test('comando info: sin rama no copia undefined', async () => {
  await switchTo('Claude Code'); // sin sesión
  clipboard = null;
  msgAnswer = 'Copy branch';
  await commands['claudeBranchStatus.info']();
  assert.equal(clipboard, null);
  msgAnswer = undefined;
});

test('deactivate / dispose: limpia el intervalo', () => {
  assert.doesNotThrow(() => ext.deactivate());
  for (const d of ctx.subscriptions) d.dispose?.();
  ctx.subscriptions.length = 0;
});

// ======================= worktrees (EnterWorktree mueve el transcript) =======================
function enterWorktree(oldFile, { sid, wtDir, wtBranch, projDir }) {
  // Claude Code renombra el transcript a la carpeta de proyecto del worktree y añade
  // un registro "relocated" y otro "worktree-state"
  const d = path.join(PROJ, projDir);
  fs.mkdirSync(d, { recursive: true });
  const nf = path.join(d, `${sid}.jsonl`);
  fs.renameSync(oldFile, nf);
  fs.appendFileSync(nf, [
    { type: 'relocated', sessionId: sid, relocatedCwd: wtDir },
    { type: 'worktree-state', sessionId: sid, worktreeSession: { originalCwd: WS.dir, worktreePath: wtDir, worktreeName: 'wt1', worktreeBranch: wtBranch, originalBranch: 'main' } },
  ].map((r) => JSON.stringify(r)).join('\n') + '\n');
  return nf;
}
function addWorktree(name, branch) {
  const dir = path.join(WS.dir, '.claude', 'worktrees', name);
  execFileSync('git', ['-C', WS.dir, 'worktree', 'add', '-q', '-b', branch, dir], { stdio: 'pipe' });
  return dir;
}

test('worktree: Claude entra en un worktree estando en otra pestaña → se sigue el transcript movido', async () => {
  const wtDir = addWorktree('wt1', 'worktree-wt1');
  const f = transcript({ title: 'entra en worktree', branch: 'main', sessionId: 'ewt' });
  await switchTo('entra en worktree');
  assert.equal(T.getItem().text, '$(sparkle) main');
  setTab('archivo.js', 'default');
  await T.refresh();
  const nf = enterWorktree(f, { sid: 'ewt', wtDir, wtBranch: 'worktree-wt1', projDir: 'wt-proj' });
  await T.refresh();
  assert.equal(T.getCurrent().file, nf, 'debe encontrar el transcript movido');
  // también ha trabajado en el checkout principal (su cwd antes de entrar) → +1
  assert.equal(T.getItem().text, '$(sparkle) worktree-wt1 $(repo-forked) +1 $(warning)');
  assert.match(T.getItem().tooltip.value, /Worktree: `.*wt1`/);
  assert.match(T.getItem().tooltip.value, /_\(last active\)_/);
});

test('worktree: al volver a la pestaña de Claude muestra la rama real del worktree', async () => {
  const wtDir = path.join(WS.dir, '.claude', 'worktrees', 'wt1');
  // Claude cambia de rama dentro del worktree: manda lo que hay ahora en disco
  execFileSync('git', ['-C', wtDir, 'checkout', '-q', '-b', 'otra-en-wt'], { stdio: 'pipe' });
  const item = await switchTo('entra en worktree');
  assert.equal(T.getCurrent().sessionId, 'ewt');
  assert.match(item.text, /^\$\(sparkle\) otra-en-wt \$\(repo-forked\)/);
  await commands['claudeBranchStatus.info']();
  assert.match(messages.at(-1).msg, /branch otra-en-wt \(worktree .*wt1\)/);
});

test('worktree: al salir del worktree vuelve a la rama normal', async () => {
  const f = (await T.sessions()).find((s) => s.sessionId === 'ewt').file;
  fs.appendFileSync(f, [
    { type: 'worktree-state', sessionId: 'ewt', worktreeSession: null },
    { type: 'user', sessionId: 'ewt', cwd: WS.dir, gitBranch: 'main' },
  ].map((r) => JSON.stringify(r)).join('\n') + '\n');
  const item = await switchTo('entra en worktree');
  assert.equal(item.text, '$(sparkle) main +1', 'el worktree sigue contando como repo de la sesión');
  assert.doesNotMatch(item.tooltip.value, /- Worktree:/);
});

test('worktree: worktree fuera de la carpeta del workspace sigue contando como "de esta carpeta"', async () => {
  transcript({ dir: 'b', title: 'dup wt', branch: 'otro', cwd: OTHER.dir, sessionId: 'dwOther' });
  const f = transcript({ dir: 'c', title: 'dup wt', branch: 'feature-174', cwd: WT.dir, sessionId: 'dwMine', ageDays: 1,
    lines: [
      { type: 'user', sessionId: 'dwMine', cwd: WT.dir, gitBranch: 'feature-174' },
      { type: 'ai-title', aiTitle: 'dup wt', sessionId: 'dwMine' },
      { type: 'worktree-state', sessionId: 'dwMine', worktreeSession: { originalCwd: WS.dir, worktreePath: WT.dir, worktreeBranch: 'feature-174' } },
    ] });
  assert.ok(f);
  await switchTo('dup wt');
  assert.equal(T.getCurrent().sessionId, 'dwMine');
});

test('sessions: mismo sessionId en dos carpetas → solo el más reciente', async () => {
  transcript({ dir: 'dupA', title: 'dup sid', branch: 'viejo', sessionId: 'dsid', ageDays: 1 });
  transcript({ dir: 'dupB', title: 'dup sid', branch: 'nuevo', sessionId: 'dsid' });
  const found = (await T.sessions()).filter((s) => s.sessionId === 'dsid');
  assert.equal(found.length, 1);
  assert.equal(found[0].branch, 'nuevo');
  assert.match(await T.findSessionFile('dsid'), /dupB/);
  assert.equal(await T.findSessionFile('no-existe'), null);
});

// ======================= varios repos en una sesión =======================
test('parseActivity: herramientas, cwd, cd / pushd / git -C, ~, comillas; sin duplicados y por recencia', () => {
  const rows = [
    { type: 'user', cwd: '/r/a' },
    { type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Read', input: { file_path: '/r/b/src/x.js' } }] } },
    { type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Grep', input: { pattern: 'x', path: '/r/c' } }] } },
    { type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Bash', input: { command: 'cd /r/d && npm test; git -C "/r/e f" status | head; pushd ~/r/g; cd relativo; cd \'/r/h\'' } }] } },
    { type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Edit', input: { file_path: '/r/b/src/x.js' } }] } },
    { type: 'user', message: { content: 'texto {"type":"tool_use","name":"Edit","input":{"file_path":"/falso"}} y "file_path":"/falso2"' } },
  ];
  const r = T.parseActivity(rows.map((x) => JSON.stringify(x)).join('\n'));
  const g = path.join(os.homedir(), 'r/g');
  assert.deepEqual(r.paths, ['/r/a', '/r/c', '/r/d', '/r/e f', g, '/r/h', '/r/b/src/x.js']);
  // solo cuenta como trabajo editar/escribir y ejecutar comandos; leer (Read, Grep) no
  assert.deepEqual(r.work, ['/r/d', '/r/e f', g, '/r/h', '/r/b/src/x.js']);
});

test('parseActivity: un Bash sin cd trabaja en el cwd de ese mensaje', () => {
  const rows = [
    { type: 'assistant', cwd: '/r/a', message: { content: [{ type: 'tool_use', name: 'Bash', input: { command: 'cd /r/otro && ls' } }] } },
    { type: 'assistant', cwd: '/r/a', message: { content: [{ type: 'tool_use', name: 'Bash', input: { command: 'npm test' } }] } },
  ];
  assert.deepEqual(T.parseActivity(rows.map((x) => JSON.stringify(x)).join('\n')).work, ['/r/otro', '/r/a']);
});

test('parseActivity: se queda con las 200 más recientes', () => {
  const rows = Array.from({ length: 300 }, (_, i) => JSON.stringify({ cwd: `/p/${i}` }));
  const ps = T.parseActivity(rows.join('\n')).paths;
  assert.equal(ps.length, 200);
  assert.equal(ps[0], '/p/100');
  assert.equal(ps.at(-1), '/p/299');
});

test('multi-repo: la sesión trabaja en otros repos (local y worktree) → +N y lista en el tooltip', async () => {
  const API = gitRepo(path.join(TMP, 'multi', 'api'), 'develop');
  const WEB = gitRepo(path.join(TMP, 'multi', 'web'), 'main');
  const webWt = path.join(TMP, 'multi', 'web-wt');
  execFileSync('git', ['-C', WEB.dir, 'worktree', 'add', '-q', '-b', 'feat-web', webWt], { stdio: 'pipe' });
  const sid = 'multi';
  const tool = (name, input) => ({ type: 'assistant', sessionId: sid, message: { content: [{ type: 'tool_use', name, input }] } });
  transcript({ sessionId: sid, lines: [
    { type: 'user', sessionId: sid, cwd: WS.dir, gitBranch: 'main' },
    { type: 'ai-title', aiTitle: 'varios repos', sessionId: sid },
    tool('Edit', { file_path: path.join(API.dir, 'src', 'borrado.js') }), // el fichero ya no existe
    tool('Bash', { command: `cd ${webWt} && git status` }),
    tool('Read', { file_path: path.join(TMP, 'no-es-repo', 'x.txt') }),
    tool('Read', { file_path: path.join(WS.dir, 'README.md') }),
  ] });
  // lo último que hizo fue trabajar en el worktree de web (los Read posteriores no cuentan)
  const item = await switchTo('varios repos');
  assert.equal(item.text, '$(sparkle) feat-web $(repo-forked) +2 $(warning)');
  const tip = item.tooltip.value;
  assert.match(tip, /Repos in this session/);
  assert.match(tip, new RegExp(`Working in: \`${webWt}\` \\(worktree\\)`));
  assert.match(tip, /\$\(repo-forked\) \*\*web\*\* → `feat-web` \(worktree\) _\(active\)_/);
  assert.match(tip, /\$\(repo\) \*\*repo\*\* → `main` _\(session cwd\)_/);
  assert.match(tip, /\$\(repo\) \*\*api\*\* → `develop`/);
  assert.doesNotMatch(tip, /no-es-repo/);
  // orden: activo, cwd de la sesión, resto por recencia
  assert.ok(tip.indexOf('**web**') < tip.indexOf('**repo**') && tip.indexOf('**repo**') < tip.indexOf('**api**'));
  // las ramas son en vivo
  API.checkout('hotfix');
  assert.match((await switchTo('varios repos')).tooltip.value, /\*\*api\*\* → `hotfix`/);
  await commands['claudeBranchStatus.info']();
  assert.match(messages.at(-1).msg, /→ branch feat-web \(worktree .*web-wt\) · Repos: web \(worktree\) → feat-web, repo → main, api → hotfix/);
});

test('multi-repo: un solo repo → sin +N ni lista', async () => {
  const item = await switchTo('misma rama');
  assert.equal(item.text, '$(sparkle) main');
  assert.doesNotMatch(item.tooltip.value, /Repos in this session/);
});

test('multi-repo: sesión abierta fuera de un repo que escribe en uno → muestra la rama de ese repo', async () => {
  const API2 = gitRepo(path.join(TMP, 'multi2', 'api2'), 'release');
  const sid = 'fuera';
  transcript({ dir: 'fuera', sessionId: sid, lines: [
    { type: 'user', sessionId: sid, cwd: path.join(TMP, 'multi2'), gitBranch: '' },
    { type: 'ai-title', aiTitle: 'desde fuera', sessionId: sid },
    { type: 'assistant', sessionId: sid, message: { content: [{ type: 'tool_use', name: 'Write', input: { file_path: path.join(API2.dir, 'a.txt') } }] } },
  ] });
  const item = await switchTo('desde fuera');
  assert.equal(item.text, '$(sparkle) release $(warning)', 'el repo donde escribe pasa a ser el principal');
  assert.match(item.tooltip.value, new RegExp(`Working in: \`${API2.dir}\``));
  assert.doesNotMatch(item.tooltip.value, /Repos in this session/, 'un solo repo: sin lista');
});

test('multi-repo: Claude trabaja con "cd worktree && …" mientras el cwd está en otra rama (caso real)', async () => {
  // el checkout principal está en 173, la sesión lo registra como gitBranch, pero Claude
  // trabaja en el worktree de la 160 haciendo cd en cada comando (el shell vuelve al cwd)
  const MAIN = gitRepo(path.join(TMP, 'real', 'botcontroller'), '173_last_visit');
  const wt160 = path.join(TMP, 'real', 'botcontroller-160');
  execFileSync('git', ['-C', MAIN.dir, 'worktree', 'add', '-q', '-b', '160_mejora_entrega_huecos', wt160], { stdio: 'pipe' });
  const sid = 'real160';
  const bash = (command) => ({ type: 'assistant', sessionId: sid, cwd: MAIN.dir, gitBranch: '173_last_visit', message: { content: [{ type: 'tool_use', name: 'Bash', input: { command } }] } });
  const lines = [
    { type: 'user', sessionId: sid, cwd: MAIN.dir, gitBranch: '173_last_visit' },
    { type: 'custom-title', customTitle: '160_mejora_entrega_huecos', sessionId: sid },
    bash(`cd ${wt160}; grep -rn shiftedDays src | head`),
    { type: 'assistant', sessionId: sid, cwd: MAIN.dir, message: { content: [{ type: 'tool_use', name: 'Read', input: { file_path: path.join(MAIN.dir, 'README.md') } }] } },
    bash(`cd ${wt160}; sed -n 1,10p test/e2e/ESTADO.md`),
    { type: 'user', sessionId: sid, cwd: MAIN.dir, gitBranch: '173_last_visit' },
  ];
  const f = transcript({ dir: 'real', sessionId: sid, lines });
  const bak = vscode.workspace.workspaceFolders;
  vscode.workspace.workspaceFolders = [{ uri: { fsPath: MAIN.dir } }];
  try {
    let item = await switchTo('160_mejora_entrega_huecos');
    assert.equal(item.text, '$(sparkle) 160_mejora_entrega_huecos $(repo-forked) +1 $(warning)');
    assert.match(item.tooltip.value, /Session cwd: `.*botcontroller` \(now on `173_last_visit`\)/);
    // si después vuelve a trabajar en el checkout principal, se muestra ese
    fs.appendFileSync(f, JSON.stringify(bash('npm test')) + '\n');
    item = await switchTo('160_mejora_entrega_huecos');
    assert.equal(item.text, '$(sparkle) 173_last_visit +1');
    assert.doesNotMatch(item.tooltip.value, /Working in/);
  } finally { vscode.workspace.workspaceFolders = bak; }
});
