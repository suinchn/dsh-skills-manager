// 统一技能库（library）配置 + 按项目 / 按机器人开关的持久化模块。
// 刻意不 import core.js，避免循环依赖；只依赖 types.js 的类型与 node 内置模块。
// 配置落在 DSH_HOME/skills-manager/library.json：
//   { version:1, path:"<统一库目录绝对路径>"(空串=关闭库模式),
//     projects:{ [key]:{name,path,disabled:string[]} },
//     bots:{ [botId]:{name,workDir?,disabled:string[]} } }
// *.disabled 记录该维度下「关闭」的技能名（canonical name）；默认空 = 全部启用。
// 机器人名单取自 DSH_HOME/bot/state.json（ds-bot 插件状态），只读不写。

import { createHash, randomUUID } from "node:crypto";
import { promises as fs, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve, sep } from "node:path";
import type { SkillRoot } from "./types.js";

export const LIBRARY_ROOT_KEY = "library";
export const LIBRARY_ROOT_RANK = 50;
const LIBRARY_CONFIG_VERSION = 1;
const MAX_PATH_LENGTH = 4096;

export interface LibraryProjectConfig {
  name: string;
  path: string;
  disabled: string[];
}
export interface LibraryBotConfig {
  name: string;
  workDir?: string;
  disabled: string[];
}
export interface LibraryConfig {
  version: number;
  path: string;
  projects: Record<string, LibraryProjectConfig>;
  bots: Record<string, LibraryBotConfig>;
}
/** 从 ds-bot 的 state.json 读到的机器人条目。 */
export interface BotStateEntry {
  id: string;
  name: string;
  role?: string;
  workDir?: string;
  sessionId?: string;
}
/** GET /library 用的机器人下拉项（state.json 名单 + library.json 开关合并）。 */
export interface LibraryBotView {
  key: string;
  name: string;
  role: string;
  workDir: string;
  disabled: string[];
  hasWorkDir: boolean;
  projectKey: string;   // 关联项目的稳定 key（由工作目录解析），无工作目录时为 ""
  projectPath: string;  // 关联项目在项目下拉里的 value（项目根绝对路径）
}
/** 机器人工作目录 ↔ 项目根的关联记录（内部共用）。 */
export interface BotProjectLink {
  botKey: string;
  botName: string;
  projectKey: string;
  projectRoot: string;
}
export interface LibrarySkillView {
  name: string;       // canonical（可被调用）技能名
  entryName: string;  // 目录名 / 文件名
  description: string;
  path: string;       // SKILL.md 绝对路径
  loadable: boolean;
  descriptionTokens?: number; // 简介估算 token（常驻系统提示词）
  bodyTokens?: number;        // 正文估算 token（调用时加载）
}

export function resolveDshHome(): string {
  return process.env.DSH_HOME || join(homedir(), ".dsh");
}
export function managerHomePath(): string {
  return join(resolveDshHome(), "skills-manager");
}
export function libraryConfigPath(): string {
  return join(managerHomePath(), "library.json");
}

/** ds-bot 插件的机器人名单文件。 */
export function botStatePath(): string {
  return join(resolveDshHome(), "bot", "state.json");
}

function defaultConfig(): LibraryConfig {
  return { version: LIBRARY_CONFIG_VERSION, path: "", projects: {}, bots: {} };
}

function normalizeDisabled(value: unknown): string[] {
  return Array.isArray(value)
    ? Array.from(new Set(value.filter((n): n is string => typeof n === "string" && !!n)))
    : [];
}

function normalize(doc: unknown): LibraryConfig {
  if (!doc || typeof doc !== "object") return defaultConfig();
  const d = doc as Record<string, unknown>;
  const path = typeof d.path === "string" ? d.path : "";
  const projects: Record<string, LibraryProjectConfig> = {};
  if (d.projects && typeof d.projects === "object" && !Array.isArray(d.projects)) {
    for (const [key, value] of Object.entries(d.projects as Record<string, unknown>)) {
      if (!value || typeof value !== "object") continue;
      const v = value as Record<string, unknown>;
      projects[key] = {
        name: typeof v.name === "string" ? v.name : key,
        path: typeof v.path === "string" ? v.path : "",
        disabled: normalizeDisabled(v.disabled),
      };
    }
  }
  const bots: Record<string, LibraryBotConfig> = {};
  if (d.bots && typeof d.bots === "object" && !Array.isArray(d.bots)) {
    for (const [key, value] of Object.entries(d.bots as Record<string, unknown>)) {
      if (!value || typeof value !== "object") continue;
      const v = value as Record<string, unknown>;
      bots[key] = {
        name: typeof v.name === "string" ? v.name : key,
        workDir: typeof v.workDir === "string" ? v.workDir : undefined,
        disabled: normalizeDisabled(v.disabled),
      };
    }
  }
  return { version: LIBRARY_CONFIG_VERSION, path, projects, bots };
}

let cached: LibraryConfig | null = null;

export function invalidateLibraryConfig(): void {
  cached = null;
}

export function readLibraryConfig(): LibraryConfig {
  if (cached) return cached;
  let doc: unknown;
  try {
    doc = JSON.parse(readFileSync(libraryConfigPath(), "utf8"));
  } catch {
    cached = defaultConfig();
    return cached;
  }
  cached = normalize(doc);
  return cached;
}

async function writeConfig(next: LibraryConfig): Promise<void> {
  const dir = managerHomePath();
  await fs.mkdir(dir, { recursive: true });
  const file = libraryConfigPath();
  const tmp = join(dir, `.library-${randomUUID()}.tmp`);
  const normalized = normalize(next);
  await fs.writeFile(tmp, JSON.stringify(normalized, null, 2), "utf8");
  try {
    await fs.rename(tmp, file);
  } catch (error) {
    await fs.rm(tmp, { force: true }).catch(() => undefined);
    throw error;
  }
  cached = normalized;
}

function coded(message: string, code: string): Error {
  return Object.assign(new Error(message), { statusCode: 400, code, params: {} });
}

/** 设置（或清空）统一技能库目录。空串 = 关闭库模式（provider 行为零回归）。 */
export async function setLibraryPath(input: unknown): Promise<{ path: string }> {
  let value = typeof input === "string" ? input.trim() : "";
  if (value) {
    if (value.length > MAX_PATH_LENGTH) throw coded("统一技能库目录路径过长", "error.library.path");
    if (!isAbsolute(value)) throw coded("统一技能库目录必须是绝对路径", "error.library.path");
    value = resolve(value);
  }
  const config = readLibraryConfig();
  await writeConfig({ ...config, path: value });
  return { path: value };
}

/** 构造库对应的只读 SkillRoot；库模式关闭时返回 null。 */
export function libraryRoot(config: LibraryConfig = readLibraryConfig()): SkillRoot | null {
  if (!config.path) return null;
  return {
    key: LIBRARY_ROOT_KEY,
    path: config.path,
    label: "Skill Library",
    rank: LIBRARY_ROOT_RANK,
    mutable: false,
    native: false,
    toggleable: false,
    kind: "library",
  };
}

/** 由项目根绝对路径算出稳定的 16 位 key（win32 大小写不敏感）。 */
export function projectKeyForRoot(root: string): string {
  const canonical = process.platform === "win32" ? resolve(root).toLowerCase() : resolve(root);
  return createHash("sha256").update(canonical).digest("hex").slice(0, 16);
}

/** 从任意 cwd 向上找 .git，找不到就用 cwd 本身；返回项目根绝对路径。 */
export async function resolveLibraryProjectRoot(cwd: string): Promise<string> {
  let start: string;
  try {
    start = await fs.realpath(resolve(cwd || "."));
  } catch {
    start = resolve(cwd || ".");
  }
  let current = start;
  for (;;) {
    try {
      await fs.lstat(join(current, ".git"));
      return current;
    } catch {
      // 继续向上
    }
    const parent = dirname(current);
    if (parent === current) return start;
    current = parent;
  }
}

/** 由任意项目内路径（项目根或子目录）算出配置 key。 */
export async function projectKeyForPath(projectPath: string): Promise<string> {
  const root = await resolveLibraryProjectRoot(projectPath);
  return projectKeyForRoot(root);
}

/** provider 使用：由会话 cwd 得到该项目的配置 key。 */
export async function libraryProjectKey(cwd: string): Promise<string> {
  return projectKeyForPath(cwd);
}

/** 取该项目被禁用的技能名集合。 */
export function disabledSkillsFor(config: LibraryConfig, key: string): string[] {
  const project = config.projects[key];
  return project ? project.disabled : [];
}

function ensureProject(config: LibraryConfig, key: string, root: string): LibraryProjectConfig {
  let project = config.projects[key];
  if (!project) {
    project = { name: basename(root) || key, path: root, disabled: [] };
    config.projects[key] = project;
  }
  return project;
}

/** 切换单个技能在某项目的启用状态。projectPath 可为项目根或其子目录。 */
export async function setProjectSkillEnabled(
  projectPath: string,
  skillName: string,
  enabled: boolean,
): Promise<{ key: string; disabled: string[] }> {
  const name = typeof skillName === "string" ? skillName.trim() : "";
  if (!name) throw coded("缺少技能名", "error.library.name");
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

/** 一次性把某项目的全部技能设为启用 / 禁用。 */
export async function setProjectAllSkills(
  projectPath: string,
  enabled: boolean,
  allSkillNames: string[],
): Promise<{ key: string; disabled: string[] }> {
  const root = await resolveLibraryProjectRoot(projectPath);
  const key = projectKeyForRoot(root);
  const config = readLibraryConfig();
  const project = ensureProject(config, key, root);
  project.disabled = enabled
    ? []
    : Array.from(new Set(allSkillNames.filter((n): n is string => typeof n === "string" && !!n)));
  await writeConfig(config);
  return { key, disabled: project.disabled };
}

export interface LibraryProjectView {
  key: string;
  name: string;
  path: string;
  disabled: string[];
  botKey: string;   // 关联机器人的 bot id（无匹配机器人时为 ""）
  botName: string;  // 关联机器人名称（无匹配机器人时为 ""）
}

/** GET /library 用：已有配置记录 + 当前已登记工作区合并成项目下拉列表。 */
export async function libraryProjectViews(registered: unknown): Promise<LibraryProjectView[]> {
  const config = readLibraryConfig();
  const views = new Map<string, LibraryProjectView>();
  const blank = (key: string, name: string, path: string, disabled: string[]): LibraryProjectView => ({
    key, name, path, disabled, botKey: "", botName: "",
  });
  for (const [key, project] of Object.entries(config.projects)) {
    views.set(key, blank(key, project.name, project.path, project.disabled.slice()));
  }
  // 机器人工作目录也登记为项目，保证「选机器人 → 自动选中其工作目录」能命中下拉项。
  const links = await botProjectLinks(config);
  const addPath = async (p: string) => {
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
      // 忽略不可访问的工作区
    }
  };
  const paths = Array.isArray(registered)
    ? registered.filter((p): p is string => typeof p === "string" && !!p)
    : [];
  for (const p of paths) await addPath(p);
  for (const link of links) await addPath(link.projectRoot);
  // 反向标注项目对应的机器人（同一个项目根被多个机器人共享时取第一个）。
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

/* ─────────── 机器人（dsh-bot / ds-bot）维度 ─────────── */

let botStateCache: { mtimeMs: number; entries: BotStateEntry[]; mainBotIds: string[] } | null = null;

/** 只读解析 DSH_HOME/bot/state.json 的 bots 名单 + 主机器人 id 列表。
 *  按 mtime 缓存，避免 provider 频繁读盘。
 *  ds-bot 的 state.json 偶尔含内嵌 NUL 字节，读进来后需剔除再 JSON.parse。 */
function readBotTeamState(): { entries: BotStateEntry[]; mainBotIds: string[] } {
  const file = botStatePath();
  let mtimeMs = 0;
  try {
    mtimeMs = statSync(file).mtimeMs;
  } catch {
    botStateCache = null;
    return { entries: [], mainBotIds: [] };
  }
  if (botStateCache && botStateCache.mtimeMs === mtimeMs) return { entries: botStateCache.entries, mainBotIds: botStateCache.mainBotIds };
  let entries: BotStateEntry[] = [];
  let mainBotIds: string[] = [];
  try {
    const text = readFileSync(file, "utf8").replace(/\u0000/g, "");
    const doc = JSON.parse(text) as Record<string, unknown>;
    mainBotIds = Array.isArray(doc.mainBotIds)
      ? doc.mainBotIds.filter((id): id is string => typeof id === "string" && !!id)
      : [];
    const bots = doc.bots && typeof doc.bots === "object" && !Array.isArray(doc.bots)
      ? (doc.bots as Record<string, unknown>)
      : {};
    entries = Object.entries(bots).map(([id, value]) => {
      const v = (value && typeof value === "object" ? value : {}) as Record<string, unknown>;
      return {
        id,
        name: typeof v.name === "string" && v.name ? v.name : id,
        role: typeof v.role === "string" ? v.role : "",
        workDir: typeof v.workDir === "string" && v.workDir ? v.workDir : undefined,
        sessionId: typeof v.sessionId === "string" ? v.sessionId : undefined,
      };
    });
  } catch {
    entries = [];
    mainBotIds = [];
  }
  botStateCache = { mtimeMs, entries, mainBotIds };
  return { entries, mainBotIds };
}

/** 只读解析 DSH_HOME/bot/state.json 的 bots 名单（兼容旧签名）。 */
export function readBotState(): BotStateEntry[] {
  return readBotTeamState().entries;
}

/** ds-bot 的团队工作区目录：DS_BOT_WORKSPACE 覆盖，否则 `DSH_HOME/bot/workspace`。
 *  与 ds-bot 的 `defaultTeamFolder()` 逻辑一致（rt.home = DSH_HOME/bot）。 */
export function dsBotTeamFolder(): string {
  return process.env.DS_BOT_WORKSPACE?.trim() || join(resolveDshHome(), "bot", "workspace");
}

/** 取某机器人在配置里被禁用的技能名集合。 */
export function disabledSkillsForBot(config: LibraryConfig, key: string): string[] {
  const bot = config.bots[key];
  return bot ? bot.disabled : [];
}

function comparePath(p: string): string {
  let out = resolve(p);
  if (process.platform === "win32") out = out.toLowerCase();
  while (out.length > 3 && (out.endsWith(sep) || out.endsWith("/"))) out = out.slice(0, -1);
  return out;
}

/** 用于 cwd 匹配的机器人工作目录清单：state.json 为准，配置里残留的 workDir 兜底。
 *  无工作目录的主机器人（Main Bot / Chief）以 ds-bot 团队工作区为有效工作目录，
 *  使其 disabled 名单与库 UI 的项目关联都能生效（m00227 chief 纳入）。 */
function botWorkDirs(config: LibraryConfig): { key: string; workDir: string }[] {
  const map = new Map<string, string>();
  const team = readBotTeamState();
  const mainIds = new Set(team.mainBotIds);
  for (const entry of team.entries) {
    if (entry.workDir) map.set(entry.id, entry.workDir);
  }
  for (const [key, bot] of Object.entries(config.bots)) {
    if (bot.workDir && !map.has(key)) map.set(key, bot.workDir);
  }
  // 主机器人（ds-bot 的 Main Bot，如 Chief）在 state.json 里没有 workDir 字段，
  // 它的会话实际跑在团队工作区（ds-bot createSession 兜底 teamFolder），
  // 这里用团队工作区目录作为它的有效工作目录，让 cwd 匹配能命中它。
  if (mainIds.size > 0) {
    for (const entry of team.entries) {
      if (!entry.workDir && mainIds.has(entry.id) && !map.has(entry.id)) {
        map.set(entry.id, dsBotTeamFolder());
      }
    }
  }
  return Array.from(map, ([key, workDir]) => ({ key, workDir }));
}

/** 机器人工作目录 ↔ 项目根的关联（列表/联动共用）。
 *  用与 provider 侧完全相同的 resolveLibraryProjectRoot + projectKeyForRoot 解析，
 *  保证「选机器人 → 选中其工作目录作为项目」与实际生效的 projectKey 一致。 */
export async function botProjectLinks(config: LibraryConfig = readLibraryConfig()): Promise<BotProjectLink[]> {
  const names = new Map<string, string>();
  for (const entry of readBotState()) names.set(entry.id, entry.name);
  for (const [key, bot] of Object.entries(config.bots)) {
    if (!names.has(key)) names.set(key, bot.name);
  }
  const out: BotProjectLink[] = [];
  for (const { key, workDir } of botWorkDirs(config)) {
    try {
      const root = await resolveLibraryProjectRoot(workDir);
      out.push({
        botKey: key,
        botName: names.get(key) || key,
        projectKey: projectKeyForRoot(root),
        projectRoot: root,
      });
    } catch {
      // 忽略不可访问的工作目录
    }
  }
  return out;
}

/** provider 使用：由会话 cwd 匹配到所属机器人（祖先匹配、取最长 workDir）。
 *  host 只把 cwd 传给 provider.list/get，拿不到 sessionId/botId；
 *  但 ds-bot 创建会话时用的 cwd 就是该 bot 的 workDir，故可据此识别。
 *  不匹配任何 workDir（普通会话 / 无 workDir 的 Chief）→ 返回 ""，零回归。 */
export function libraryBotKeyForCwd(cwd: string, config: LibraryConfig = readLibraryConfig()): string {
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

/** provider 使用：由会话 cwd 汇总「项目 + 机器人」两个维度被禁用的技能名（并集）。 */
export async function disabledSkillsForScope(config: LibraryConfig, cwd: string): Promise<string[]> {
  const out = new Set<string>();
  try {
    const projectKey = await libraryProjectKey(cwd);
    for (const name of disabledSkillsFor(config, projectKey)) out.add(name);
  } catch {
    // 忽略不可访问的工作目录
  }
  const botKey = libraryBotKeyForCwd(cwd, config);
  if (botKey) {
    for (const name of disabledSkillsForBot(config, botKey)) out.add(name);
  }
  return Array.from(out);
}

function ensureBot(config: LibraryConfig, key: string): LibraryBotConfig {
  let bot = config.bots[key];
  if (!bot) {
    const entry = readBotState().find((e) => e.id === key);
    bot = {
      name: entry ? entry.name : key,
      workDir: entry ? entry.workDir : undefined,
      disabled: [],
    };
    config.bots[key] = bot;
  }
  return bot;
}

/** 切换单个技能在某机器人的启用状态。bot 字段为 ds-bot 的 bot id。 */
export async function setBotSkillEnabled(
  botId: string,
  skillName: string,
  enabled: boolean,
): Promise<{ key: string; disabled: string[] }> {
  const key = typeof botId === "string" ? botId.trim() : "";
  if (!key) throw coded("缺少机器人", "error.library.bot");
  const name = typeof skillName === "string" ? skillName.trim() : "";
  if (!name) throw coded("缺少技能名", "error.library.name");
  const config = readLibraryConfig();
  const bot = ensureBot(config, key);
  const set = new Set(bot.disabled);
  if (enabled) set.delete(name);
  else set.add(name);
  bot.disabled = Array.from(set);
  await writeConfig(config);
  return { key, disabled: bot.disabled };
}

/** 一次性把某机器人的全部技能设为启用 / 禁用。 */
export async function setBotAllSkills(
  botId: string,
  enabled: boolean,
  allSkillNames: string[],
): Promise<{ key: string; disabled: string[] }> {
  const key = typeof botId === "string" ? botId.trim() : "";
  if (!key) throw coded("缺少机器人", "error.library.bot");
  const config = readLibraryConfig();
  const bot = ensureBot(config, key);
  bot.disabled = enabled
    ? []
    : Array.from(new Set(allSkillNames.filter((n): n is string => typeof n === "string" && !!n)));
  await writeConfig(config);
  return { key, disabled: bot.disabled };
}

/** GET /library 用：ds-bot 名单 + 配置开关合并成机器人下拉列表。 */
export async function libraryBotViews(config: LibraryConfig = readLibraryConfig()): Promise<LibraryBotView[]> {
  const configured = config.bots;
  const links = await botProjectLinks(config);
  const byBot = new Map(links.map((link) => [link.botKey, link]));
  // 与 provider 匹配（botWorkDirs）一致的有效工作目录：无 workDir 的主机器人 = 团队工作区。
  const effectiveWorkDirs = new Map(botWorkDirs(config).map((entry) => [entry.key, entry.workDir]));
  const make = (
    key: string,
    name: string,
    role: string,
    workDir: string,
    disabled: string[],
  ): LibraryBotView => {
    const link = byBot.get(key);
    return {
      key,
      name,
      role,
      workDir,
      disabled,
      hasWorkDir: !!workDir,
      projectKey: link ? link.projectKey : "",
      projectPath: link ? link.projectRoot : "",
    };
  };
  const views: LibraryBotView[] = readBotState().map((entry) => {
    const saved = configured[entry.id];
    const workDir = entry.workDir || (saved && saved.workDir) || effectiveWorkDirs.get(entry.id) || "";
    return make(entry.id, entry.name, entry.role || "", workDir, saved ? saved.disabled.slice() : []);
  });
  // 配置里存在、但 state.json 里已删除的机器人也保留，方便查看/清理其开关。
  for (const [key, bot] of Object.entries(configured)) {
    if (!views.some((v) => v.key === key)) {
      views.push(make(key, bot.name, "", bot.workDir || "", bot.disabled.slice()));
    }
  }
  return views.sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * 新技能默认全局关闭：把名字追加进「所有已配置项目 + 所有已登记工作区项目
 * + 所有已配置机器人 + 所有 state.json 机器人」的 disabled 名单（去重后写入）。
 * 供 create / import / upload 新增技能后调用，满足「新建 skill 默认在所有项目与机器人处关闭」。
 */
export async function disableSkillEverywhere(name: string, registeredPaths: string[] = []): Promise<void> {
  const skillName = typeof name === "string" ? name.trim() : "";
  if (!skillName) throw coded("缺少技能名", "error.library.name");
  const config = readLibraryConfig();
  // 库模式关闭（path 为空）时 disabled 名单不生效，不写入，避免污染配置。
  if (!config.path) return;
  const add = (disabled: string[]) => {
    if (disabled.includes(skillName)) return false;
    disabled.push(skillName);
    return true;
  };
  let changed = false;
  // 项目维度：现有配置条目 + 已登记工作区（按与 libraryProjectViews 相同的解析入配置）
  for (const project of Object.values(config.projects)) {
    if (add(project.disabled)) changed = true;
  }
  const paths = Array.isArray(registeredPaths)
    ? registeredPaths.filter((p): p is string => typeof p === "string" && !!p)
    : [];
  for (const path of paths) {
    try {
      const root = await resolveLibraryProjectRoot(path);
      const key = projectKeyForRoot(root);
      const project = ensureProject(config, key, root);
      if (add(project.disabled)) changed = true;
    } catch {
      // 忽略不可访问的工作区
    }
  }
  // 机器人维度：现有配置条目 + state.json 名单（含无 workDir 的 Main Bot）
  for (const bot of Object.values(config.bots)) {
    if (add(bot.disabled)) changed = true;
  }
  for (const entry of readBotState()) {
    const bot = ensureBot(config, entry.id);
    if (add(bot.disabled)) changed = true;
  }
  if (changed) await writeConfig(config);
}
