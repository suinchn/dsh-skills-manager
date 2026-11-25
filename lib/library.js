import { createHash, randomUUID } from "node:crypto";
import { promises as fs, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve, sep } from "node:path";
const LIBRARY_ROOT_KEY = "library";
const LIBRARY_ROOT_RANK = 50;
const LIBRARY_CONFIG_VERSION = 1;
const MAX_PATH_LENGTH = 4096;
function resolveDshHome() {
  return process.env.DSH_HOME || join(homedir(), ".dsh");
}
function managerHomePath() {
  return join(resolveDshHome(), "skills-manager");
}
function libraryConfigPath() {
  return join(managerHomePath(), "library.json");
}
function botStatePath() {
  return join(resolveDshHome(), "bot", "state.json");
}
function defaultConfig() {
  return { version: LIBRARY_CONFIG_VERSION, path: "", projects: {}, bots: {} };
}
function normalizeDisabled(value) {
  return Array.isArray(value) ? Array.from(new Set(value.filter((n) => typeof n === "string" && !!n))) : [];
}
function normalize(doc) {
  if (!doc || typeof doc !== "object") return defaultConfig();
  const d = doc;
  const path = typeof d.path === "string" ? d.path : "";
  const projects = {};
  if (d.projects && typeof d.projects === "object" && !Array.isArray(d.projects)) {
    for (const [key, value] of Object.entries(d.projects)) {
      if (!value || typeof value !== "object") continue;
      const v = value;
      projects[key] = {
        name: typeof v.name === "string" ? v.name : key,
        path: typeof v.path === "string" ? v.path : "",
        disabled: normalizeDisabled(v.disabled)
      };
    }
  }
  const bots = {};
  if (d.bots && typeof d.bots === "object" && !Array.isArray(d.bots)) {
    for (const [key, value] of Object.entries(d.bots)) {
      if (!value || typeof value !== "object") continue;
      const v = value;
      bots[key] = {
        name: typeof v.name === "string" ? v.name : key,
        workDir: typeof v.workDir === "string" ? v.workDir : void 0,
        disabled: normalizeDisabled(v.disabled)
      };
    }
  }
  return { version: LIBRARY_CONFIG_VERSION, path, projects, bots };
}
let cached = null;
function invalidateLibraryConfig() {
  cached = null;
}
function readLibraryConfig() {
  if (cached) return cached;
  let doc;
  try {
    doc = JSON.parse(readFileSync(libraryConfigPath(), "utf8"));
  } catch {
    cached = defaultConfig();
    return cached;
  }
  cached = normalize(doc);
  return cached;
}
async function writeConfig(next) {
  const dir = managerHomePath();
  await fs.mkdir(dir, { recursive: true });
  const file = libraryConfigPath();
  const tmp = join(dir, `.library-${randomUUID()}.tmp`);
  const normalized = normalize(next);
  await fs.writeFile(tmp, JSON.stringify(normalized, null, 2), "utf8");
  try {
    await fs.rename(tmp, file);
  } catch (error) {
    await fs.rm(tmp, { force: true }).catch(() => void 0);
    throw error;
  }
  cached = normalized;
}
function coded(message, code) {
  return Object.assign(new Error(message), { statusCode: 400, code, params: {} });
}
async function setLibraryPath(input) {
  let value = typeof input === "string" ? input.trim() : "";
  if (value) {
    if (value.length > MAX_PATH_LENGTH) throw coded("\u7EDF\u4E00\u6280\u80FD\u5E93\u76EE\u5F55\u8DEF\u5F84\u8FC7\u957F", "error.library.path");
    if (!isAbsolute(value)) throw coded("\u7EDF\u4E00\u6280\u80FD\u5E93\u76EE\u5F55\u5FC5\u987B\u662F\u7EDD\u5BF9\u8DEF\u5F84", "error.library.path");
    value = resolve(value);
  }
  const config = readLibraryConfig();
  await writeConfig({ ...config, path: value });
  return { path: value };
}
function libraryRoot(config = readLibraryConfig()) {
  if (!config.path) return null;
  return {
    key: LIBRARY_ROOT_KEY,
    path: config.path,
    label: "Skill Library",
    rank: LIBRARY_ROOT_RANK,
    mutable: false,
    native: false,
    toggleable: false,
    kind: "library"
  };
}
function projectKeyForRoot(root) {
  const canonical = process.platform === "win32" ? resolve(root).toLowerCase() : resolve(root);
  return createHash("sha256").update(canonical).digest("hex").slice(0, 16);
}
async function resolveLibraryProjectRoot(cwd) {
  let start;
  try {
    start = await fs.realpath(resolve(cwd || "."));
  } catch {
    start = resolve(cwd || ".");
  }
  let current = start;
  for (; ; ) {
    try {
      await fs.lstat(join(current, ".git"));
      return current;
    } catch {
    }
    const parent = dirname(current);
    if (parent === current) return start;
    current = parent;
  }
}
async function projectKeyForPath(projectPath) {
  const root = await resolveLibraryProjectRoot(projectPath);
  return projectKeyForRoot(root);
}
async function libraryProjectKey(cwd) {
  return projectKeyForPath(cwd);
}
function disabledSkillsFor(config, key) {
  const project = config.projects[key];
  return project ? project.disabled : [];
}
function ensureProject(config, key, root) {
  let project = config.projects[key];
  if (!project) {
    project = { name: basename(root) || key, path: root, disabled: [] };
    config.projects[key] = project;
  }
  return project;
}
async function setProjectSkillEnabled(projectPath, skillName, enabled) {
  const name = typeof skillName === "string" ? skillName.trim() : "";
  if (!name) throw coded("\u7F3A\u5C11\u6280\u80FD\u540D", "error.library.name");
  const root = await resolveLibraryProjectRoot(projectPath);
  const key = projectKeyForRoot(root);
  const config = readLibraryConfig();
  const project = ensureProject(config, key, root);
  const set = new Set(project.disabled);
  if (enabled) set.delete(name);
  else set.add(name);
  project.disabled = Array.from(set);
  await writeConfig(config);
  return { key, disabled: project.disabled };
}
async function setProjectAllSkills(projectPath, enabled, allSkillNames) {
  const root = await resolveLibraryProjectRoot(projectPath);
  const key = projectKeyForRoot(root);
  const config = readLibraryConfig();
  const project = ensureProject(config, key, root);
  project.disabled = enabled ? [] : Array.from(new Set(allSkillNames.filter((n) => typeof n === "string" && !!n)));
  await writeConfig(config);
  return { key, disabled: project.disabled };
}
async function libraryProjectViews(registered) {
  const config = readLibraryConfig();
  const views = /* @__PURE__ */ new Map();
  const blank = (key, name, path, disabled) => ({
    key,
    name,
    path,
    disabled,
    botKey: "",
    botName: ""
  });
  for (const [key, project] of Object.entries(config.projects)) {
    views.set(key, blank(key, project.name, project.path, project.disabled.slice()));
  }
  const links = await botProjectLinks(config);
  const addPath = async (p) => {
    try {
      const root = await resolveLibraryProjectRoot(p);
      const key = projectKeyForRoot(root);
      const existing = views.get(key);
      if (existing) {
        if (!existing.path) existing.path = root;
      } else {
        views.set(key, blank(key, basename(root) || key, root, []));
      }
    } catch {
    }
  };
  const paths = Array.isArray(registered) ? registered.filter((p) => typeof p === "string" && !!p) : [];
  for (const p of paths) await addPath(p);
  for (const link of links) await addPath(link.projectRoot);
  for (const link of links) {
    const view = views.get(link.projectKey);
    if (view && !view.botKey) {
      view.botKey = link.botKey;
      view.botName = link.botName;
      if (!view.path) view.path = link.projectRoot;
    }
  }
  return Array.from(views.values()).sort((a, b) => a.name.localeCompare(b.name));
}
let botStateCache = null;
function readBotTeamState() {
  const file = botStatePath();
  let mtimeMs = 0;
  try {
    mtimeMs = statSync(file).mtimeMs;
  } catch {
    botStateCache = null;
    return { entries: [], mainBotIds: [] };
  }
  if (botStateCache && botStateCache.mtimeMs === mtimeMs) return { entries: botStateCache.entries, mainBotIds: botStateCache.mainBotIds };
  let entries = [];
  let mainBotIds = [];
  try {
    const text = readFileSync(file, "utf8").replace(/\u0000/g, "");
    const doc = JSON.parse(text);
    mainBotIds = Array.isArray(doc.mainBotIds) ? doc.mainBotIds.filter((id) => typeof id === "string" && !!id) : [];
    const bots = doc.bots && typeof doc.bots === "object" && !Array.isArray(doc.bots) ? doc.bots : {};
    entries = Object.entries(bots).map(([id, value]) => {
      const v = value && typeof value === "object" ? value : {};
      return {
        id,
        name: typeof v.name === "string" && v.name ? v.name : id,
        role: typeof v.role === "string" ? v.role : "",
        workDir: typeof v.workDir === "string" && v.workDir ? v.workDir : void 0,
        sessionId: typeof v.sessionId === "string" ? v.sessionId : void 0
      };
    });
  } catch {
    entries = [];
    mainBotIds = [];
  }
  botStateCache = { mtimeMs, entries, mainBotIds };
  return { entries, mainBotIds };
}
function readBotState() {
  return readBotTeamState().entries;
}
function dsBotTeamFolder() {
  return process.env.DS_BOT_WORKSPACE?.trim() || join(resolveDshHome(), "bot", "workspace");
}
function disabledSkillsForBot(config, key) {
  const bot = config.bots[key];
  return bot ? bot.disabled : [];
}
function comparePath(p) {
  let out = resolve(p);
  if (process.platform === "win32") out = out.toLowerCase();
  while (out.length > 3 && (out.endsWith(sep) || out.endsWith("/"))) out = out.slice(0, -1);
  return out;
}
function botWorkDirs(config) {
  const map = /* @__PURE__ */ new Map();
  const team = readBotTeamState();
  const mainIds = new Set(team.mainBotIds);
  for (const entry of team.entries) {
    if (entry.workDir) map.set(entry.id, entry.workDir);
  }
  for (const [key, bot] of Object.entries(config.bots)) {
    if (bot.workDir && !map.has(key)) map.set(key, bot.workDir);
  }
  if (mainIds.size > 0) {
    for (const entry of team.entries) {
      if (!entry.workDir && mainIds.has(entry.id) && !map.has(entry.id)) {
        map.set(entry.id, dsBotTeamFolder());
      }
    }
  }
  return Array.from(map, ([key, workDir]) => ({ key, workDir }));
}
async function botProjectLinks(config = readLibraryConfig()) {
  const names = /* @__PURE__ */ new Map();
  for (const entry of readBotState()) names.set(entry.id, entry.name);
  for (const [key, bot] of Object.entries(config.bots)) {
    if (!names.has(key)) names.set(key, bot.name);
  }
  const out = [];
  for (const { key, workDir } of botWorkDirs(config)) {
    try {
      const root = await resolveLibraryProjectRoot(workDir);
      out.push({
        botKey: key,
        botName: names.get(key) || key,
        projectKey: projectKeyForRoot(root),
        projectRoot: root
      });
    } catch {
    }
  }
  return out;
}
function libraryBotKeyForCwd(cwd, config = readLibraryConfig()) {
  if (!cwd || typeof cwd !== "string") return "";
  const canonical = comparePath(cwd);
  let bestKey = "";
  let bestLen = -1;
  for (const { key, workDir } of botWorkDirs(config)) {
    const base = comparePath(workDir);
    const prefix = base.endsWith(sep) ? base : base + sep;
    if (canonical === base || canonical.startsWith(prefix)) {
      if (base.length > bestLen) {
        bestLen = base.length;
        bestKey = key;
      }
    }
  }
  return bestKey;
}
async function disabledSkillsForScope(config, cwd) {
  const out = /* @__PURE__ */ new Set();
  try {
    const projectKey = await libraryProjectKey(cwd);
    for (const name of disabledSkillsFor(config, projectKey)) out.add(name);
  } catch {
  }
  const botKey = libraryBotKeyForCwd(cwd, config);
  if (botKey) {
    for (const name of disabledSkillsForBot(config, botKey)) out.add(name);
  }
  return Array.from(out);
}
function ensureBot(config, key) {
  let bot = config.bots[key];
  if (!bot) {
    const entry = readBotState().find((e) => e.id === key);
    bot = {
      name: entry ? entry.name : key,
      workDir: entry ? entry.workDir : void 0,
      disabled: []
    };
    config.bots[key] = bot;
  }
  return bot;
}
async function setBotSkillEnabled(botId, skillName, enabled) {
  const key = typeof botId === "string" ? botId.trim() : "";
  if (!key) throw coded("\u7F3A\u5C11\u673A\u5668\u4EBA", "error.library.bot");
  const name = typeof skillName === "string" ? skillName.trim() : "";
  if (!name) throw coded("\u7F3A\u5C11\u6280\u80FD\u540D", "error.library.name");
  const config = readLibraryConfig();
  const bot = ensureBot(config, key);
  const set = new Set(bot.disabled);
  if (enabled) set.delete(name);
  else set.add(name);
  bot.disabled = Array.from(set);
  await writeConfig(config);
  return { key, disabled: bot.disabled };
}
async function setBotAllSkills(botId, enabled, allSkillNames) {
  const key = typeof botId === "string" ? botId.trim() : "";
  if (!key) throw coded("\u7F3A\u5C11\u673A\u5668\u4EBA", "error.library.bot");
  const config = readLibraryConfig();
  const bot = ensureBot(config, key);
  bot.disabled = enabled ? [] : Array.from(new Set(allSkillNames.filter((n) => typeof n === "string" && !!n)));
  await writeConfig(config);
  return { key, disabled: bot.disabled };
}
async function libraryBotViews(config = readLibraryConfig()) {
  const configured = config.bots;
  const links = await botProjectLinks(config);
  const byBot = new Map(links.map((link) => [link.botKey, link]));
  const effectiveWorkDirs = new Map(botWorkDirs(config).map((entry) => [entry.key, entry.workDir]));
  const make = (key, name, role, workDir, disabled) => {
    const link = byBot.get(key);
    return {
      key,
      name,
      role,
      workDir,
      disabled,
      hasWorkDir: !!workDir,
      projectKey: link ? link.projectKey : "",
      projectPath: link ? link.projectRoot : ""
    };
  };
  const views = readBotState().map((entry) => {
    const saved = configured[entry.id];
    const workDir = entry.workDir || saved && saved.workDir || effectiveWorkDirs.get(entry.id) || "";
    return make(entry.id, entry.name, entry.role || "", workDir, saved ? saved.disabled.slice() : []);
  });
  for (const [key, bot] of Object.entries(configured)) {
    if (!views.some((v) => v.key === key)) {
      views.push(make(key, bot.name, "", bot.workDir || "", bot.disabled.slice()));
    }
  }
  return views.sort((a, b) => a.name.localeCompare(b.name));
}
async function disableSkillEverywhere(name, registeredPaths = []) {
  const skillName = typeof name === "string" ? name.trim() : "";
  if (!skillName) throw coded("\u7F3A\u5C11\u6280\u80FD\u540D", "error.library.name");
  const config = readLibraryConfig();
  if (!config.path) return;
  const add = (disabled) => {
    if (disabled.includes(skillName)) return false;
    disabled.push(skillName);
    return true;
  };
  let changed = false;
  for (const project of Object.values(config.projects)) {
    if (add(project.disabled)) changed = true;
  }
  const paths = Array.isArray(registeredPaths) ? registeredPaths.filter((p) => typeof p === "string" && !!p) : [];
  for (const path of paths) {
    try {
      const root = await resolveLibraryProjectRoot(path);
      const key = projectKeyForRoot(root);
      const project = ensureProject(config, key, root);
      if (add(project.disabled)) changed = true;
    } catch {
    }
  }
  for (const bot of Object.values(config.bots)) {
    if (add(bot.disabled)) changed = true;
  }
  for (const entry of readBotState()) {
    const bot = ensureBot(config, entry.id);
    if (add(bot.disabled)) changed = true;
  }
  if (changed) await writeConfig(config);
}
export {
  LIBRARY_ROOT_KEY,
  LIBRARY_ROOT_RANK,
  botProjectLinks,
  botStatePath,
  disableSkillEverywhere,
  disabledSkillsFor,
  disabledSkillsForBot,
  disabledSkillsForScope,
  dsBotTeamFolder,
  invalidateLibraryConfig,
  libraryBotKeyForCwd,
  libraryBotViews,
  libraryConfigPath,
  libraryProjectKey,
  libraryProjectViews,
  libraryRoot,
  managerHomePath,
  projectKeyForPath,
  projectKeyForRoot,
  readBotState,
  readLibraryConfig,
  resolveDshHome,
  resolveLibraryProjectRoot,
  setBotAllSkills,
  setBotSkillEnabled,
  setLibraryPath,
  setProjectAllSkills,
  setProjectSkillEnabled
};
