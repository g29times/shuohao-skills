#!/usr/bin/env node
import { execFile } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { createServer } from 'node:http';
import { basename, dirname, extname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const PUBLIC_DIR = join(ROOT, 'web', 'public');
const DATA_DIR = join(ROOT, 'web', 'data');
const PORT = Number(process.env.PORT || 3100);
const MAX_BODY = 20 * 1024 * 1024;

const SKILLS = [
  { id: 'novel-outline', label: '短剧改编大纲', description: '改编结构、爽点与分集梗概', script: 'novel-outline.mjs', needs: [] },
  { id: 'novel-characters', label: '角色设定集', description: '人物画像与角色资产', script: 'novel-characters.mjs', needs: [] },
  { id: 'novel-art', label: '美术设定集', description: '场景与叙事道具', script: 'novel-art.mjs', needs: ['cast'] },
  { id: 'novel-script', label: '短剧剧本', description: '场次、节拍与台词', script: 'novel-script.mjs', needs: ['outline', 'art'] },
  { id: 'novel-storyboard', label: '分镜规划', description: '段、分镜与生成提示词', script: 'novel-storyboard.mjs', needs: ['script', 'outline', 'art', 'cast'] },
];

const skillOf = (id) => SKILLS.find((skill) => skill.id === id);
const jsonHeaders = { 'content-type': 'application/json; charset=utf-8' };

async function readBody(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY) throw new Error('请求内容超过 20 MB 限制');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString('utf8');
}

function send(res, status, body, type = 'application/json; charset=utf-8') {
  res.writeHead(status, { 'content-type': type, 'x-content-type-options': 'nosniff' });
  res.end(type.startsWith('application/json') ? JSON.stringify(body) : body);
}

async function promptPack(skill) {
  const dir = join(ROOT, 'skills', skill.id);
  const files = ['SKILL.md'];
  const references = await (await import('node:fs/promises')).readdir(join(dir, 'references'), { withFileTypes: true });
  files.push(...references.filter((entry) => entry.isFile() && extname(entry.name) === '.md').map((entry) => join('references', entry.name)).sort());
  const sections = [];
  for (const relative of files) {
    const content = await readFile(join(dir, relative), 'utf8');
    sections.push(`\n\n===== ${skill.id}/${relative} =====\n\n${content}`);
  }
  return sections.join('');
}

function safeFilename(name, fallback) {
  const cleaned = basename(String(name || fallback)).replace(/[^\w.\-\u4e00-\u9fff]/g, '_');
  return cleaned.endsWith('.json') ? cleaned : `${cleaned}.json`;
}

function runNode(args, cwd) {
  return new Promise((resolvePromise) => {
    execFile(process.execPath, args, { cwd, maxBuffer: 64 * 1024 * 1024, env: { ...process.env, NODE_OPTIONS: '' } }, (error, stdout, stderr) => {
      resolvePromise({ ok: !error, stdout, stderr: stderr || (error ? error.message : '') });
    });
  });
}

async function renderReport(payload) {
  const skill = skillOf(payload.skillId);
  if (!skill) throw new Error('未知的 skill');
  if (!payload.file || typeof payload.file.content !== 'string') throw new Error('请上传 JSON 文件');

  let parsed;
  try {
    parsed = JSON.parse(payload.file.content);
  } catch (error) {
    throw new Error(`JSON 格式错误：${error.message}`);
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('JSON 顶层必须是对象');

  const id = randomUUID();
  const jobDir = join(DATA_DIR, id);
  await mkdir(jobDir, { recursive: true });
  const mainPath = join(jobDir, safeFilename(payload.file.name, `${skill.id}.json`));
  await writeFile(mainPath, JSON.stringify(parsed, null, 2));

  const depPaths = {};
  for (const need of skill.needs) {
    const dep = payload.dependencies?.[need];
    if (!dep || typeof dep.content !== 'string') {
      if (skill.id === 'novel-storyboard' && need === 'script') throw new Error('分镜报告必须同时上传 script.json');
      continue;
    }
    try {
      JSON.parse(dep.content);
    } catch (error) {
      throw new Error(`${need}.json 格式错误：${error.message}`);
    }
    const path = join(jobDir, safeFilename(dep.name, `${need}.json`));
    await writeFile(path, dep.content);
    depPaths[need] = path;
  }

  const scriptPath = join(ROOT, 'skills', skill.id, 'scripts', skill.script);
  const validationArgs = [scriptPath, 'validate', mainPath];
  const renderArgs = [scriptPath, 'render', mainPath, '--html'];
  const flags = { outline: '--outline', cast: '--cast', art: '--art', script: '--script' };
  for (const need of skill.needs) {
    if (depPaths[need]) {
      validationArgs.push(flags[need], depPaths[need]);
      renderArgs.push(flags[need], depPaths[need]);
    }
  }
  const validation = await runNode(validationArgs, jobDir);
  const rendered = await runNode(renderArgs, jobDir);
  if (!rendered.ok || !rendered.stdout.trim().startsWith('<!doctype html>')) {
    throw new Error(`报告渲染失败：${rendered.stderr || '脚本没有输出 HTML'}`);
  }
  await writeFile(join(jobDir, 'report.html'), rendered.stdout);
  return {
    id,
    valid: validation.ok,
    validation: `${validation.stdout}${validation.stderr}`.trim(),
    reportUrl: `/reports/${id}/report.html`,
  };
}

async function staticFile(pathname, res) {
  const relative = pathname === '/' ? 'index.html' : pathname.slice(1);
  const file = resolve(PUBLIC_DIR, relative);
  if (!file.startsWith(`${PUBLIC_DIR}/`) && file !== PUBLIC_DIR) return send(res, 403, { error: '禁止访问' });
  if (!existsSync(file)) return send(res, 404, { error: '页面不存在' });
  const content = await readFile(file);
  const type = file.endsWith('.html') ? 'text/html; charset=utf-8' : 'application/octet-stream';
  return send(res, 200, content, type);
}

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    if (req.method === 'GET' && url.pathname === '/api/skills') {
      return send(res, 200, SKILLS.map(({ id, label, description, needs }) => ({ id, label, description, needs })));
    }
    if (req.method === 'GET' && url.pathname.startsWith('/api/skills/') && url.pathname.endsWith('/prompt')) {
      const id = url.pathname.split('/')[3];
      const skill = skillOf(id);
      if (!skill) return send(res, 404, { error: '未知的 skill' });
      return send(res, 200, { id, content: await promptPack(skill) });
    }
    if (req.method === 'POST' && url.pathname === '/api/render') {
      const result = await renderReport(JSON.parse(await readBody(req)));
      return send(res, 200, result);
    }
    if (req.method === 'GET' && url.pathname.startsWith('/reports/')) {
      const relative = url.pathname.slice('/reports/'.length);
      const file = resolve(DATA_DIR, relative);
      if (!file.startsWith(`${DATA_DIR}/`) || !existsSync(file)) return send(res, 404, { error: '报告不存在' });
      return send(res, 200, await readFile(file), 'text/html; charset=utf-8');
    }
    if (req.method === 'GET') return staticFile(url.pathname, res);
    return send(res, 405, { error: '不支持的请求方法' });
  } catch (error) {
    return send(res, 400, { error: error instanceof Error ? error.message : String(error) });
  }
});

await mkdir(DATA_DIR, { recursive: true });
server.listen(PORT, '127.0.0.1', () => console.log(`shuohao web running at http://127.0.0.1:${PORT}`));
