#!/usr/bin/env node
/**
 * Migration script: index.html → Obsidian/Quartz markdown files
 */

const fs = require('fs');
const path = require('path');
const vm = require('vm');

// ─── Extract data from HTML ───────────────────────────────────────────────────

const html = fs.readFileSync(path.join(__dirname, 'index.html'), 'utf8');

const dataStart = html.indexOf('const ARTICLES = {');
const dataEnd   = html.indexOf('\nfunction parseText(');
const dataScript = html.slice(dataStart, dataEnd);

// `const` is block-scoped and won't land on the sandbox — convert to `var`
const processedScript = dataScript.replace(/^const /gm, 'var ');

const sandbox = {};
try {
  vm.runInNewContext(processedScript, sandbox);
} catch (e) {
  console.error('Failed to evaluate data script:', e.message);
  process.exit(1);
}

const { ARTICLES, TIMELINE_EVENTS, LINK_MAP } = sandbox;
console.log(`Loaded ${Object.keys(ARTICLES).length} articles, ${TIMELINE_EVENTS.length} timeline events.`);

// ─── Build alias map: article ID → [alias, alias, ...] ───────────────────────

const aliasMap = {};
for (const [alias, id] of Object.entries(LINK_MAP)) {
  if (!aliasMap[id]) aliasMap[id] = new Set();
  aliasMap[id].add(alias);
}

// ─── Content block converters ─────────────────────────────────────────────────

function convertText(text) {
  // text already uses **bold**, _italic_, [[wikilinks]] — all Obsidian-native
  return text || '';
}

function convertTable(block) {
  const escape = cell => String(cell ?? '').replace(/\|/g, '\\|').replace(/\n/g, ' ');
  const header = '| ' + block.headers.map(escape).join(' | ') + ' |';
  const divider = '| ' + block.headers.map(() => '---').join(' | ') + ' |';
  const rows = (block.rows || []).map(row =>
    '| ' + row.map(escape).join(' | ') + ' |'
  );
  return '\n' + [header, divider, ...rows].join('\n') + '\n';
}

function convertList(block) {
  return '\n' + (block.items || []).map(item => `- ${convertText(item)}`).join('\n') + '\n';
}

function convertRP(block) {
  const lines = (block.lines || []).map(line => {
    const prefix = line.speaker ? `**${line.speaker}:** ` : '';
    return `> ${prefix}${line.text}`;
  });
  return '\n' + lines.join('\n>\n') + '\n';
}

function convertBlocks(content) {
  let md = '';
  for (const block of (content || [])) {
    switch (block.type) {
      case 'p':
        md += `\n${convertText(block.text)}\n`;
        break;
      case 'subsection':
        md += `\n### ${block.text}\n`;
        break;
      case 'table':
        md += convertTable(block);
        break;
      case 'ul':
        md += convertList(block);
        break;
      case 'rp':
        md += convertRP(block);
        break;
      case 'quote':
        md += `\n> ${convertText(block.text)}\n`;
        break;
      default:
        console.warn(`  Unknown block type: ${block.type}`);
    }
  }
  return md;
}

// ─── Infobox → Obsidian callout ───────────────────────────────────────────────

function convertInfobox(infobox) {
  if (!infobox) return '';
  let md = '\n> [!infobox]\n';
  md += `> # ${infobox.title}\n`;

  if (infobox.imageTabs && infobox.imageTabs.length > 0) {
    for (const tab of infobox.imageTabs) {
      if (tab.src) md += `> ![[${tab.src}]]\n`;
      md += `> *${tab.label}${tab.caption ? ': ' + tab.caption : ''}*\n`;
    }
    md += '>\n';
  }

  for (const group of (infobox.groups || [])) {
    if (group.heading) {
      md += `> **${group.heading}**\n>\n`;
    }
    md += '> | | |\n> |---|---|\n';
    for (const [key, value] of (group.fields || [])) {
      const safeVal = String(value ?? '').replace(/\|/g, '\\|').replace(/\n/g, ' ');
      md += `> | **${key}** | ${safeVal} |\n`;
    }
    md += '>\n';
  }

  return md + '\n';
}

// ─── Article → Markdown ───────────────────────────────────────────────────────

function safeTitle(title) {
  // Replace filesystem-unsafe characters and collapse multiple spaces
  return title.replace(/\//g, ' - ').replace(/[<>:"|?*\\]/g, '').replace(/\s+/g, ' ').trim();
}

function articleToMarkdown(id, article) {
  const aliases = aliasMap[id] ? [...aliasMap[id]] : [];

  // YAML frontmatter
  const lines = ['---'];
  lines.push(`title: "${article.title.replace(/"/g, '\\"')}"`);
  if (article.subtitle) lines.push(`subtitle: "${article.subtitle.replace(/"/g, '\\"')}"`);
  lines.push(`category: ${article.category}`);
  if (article.tags && article.tags.length > 0) {
    lines.push('tags:');
    for (const t of article.tags) lines.push(`  - ${t}`);
  }
  if (aliases.length > 0) {
    lines.push('aliases:');
    for (const a of aliases) lines.push(`  - "${a.replace(/"/g, '\\"')}"`);
  }
  lines.push(`stub: ${article.stub}`);
  lines.push('---');

  let md = lines.join('\n') + '\n';

  // Infobox
  if (article.infobox) {
    md += convertInfobox(article.infobox);
  }

  // Sections
  for (const section of (article.sections || [])) {
    if (section.heading) {
      md += `\n## ${section.heading}\n`;
    }
    md += convertBlocks(section.content);
  }

  return md;
}

// ─── Timeline → Markdown ──────────────────────────────────────────────────────

function timelineToMarkdown(events) {
  let md = `---
title: "Timeline"
category: meta
tags:
  - meta
  - timeline
stub: false
---

# World Timeline

`;

  for (const event of events) {
    const major = event.major ? '**' : '';
    const tags = event.tags && event.tags.length > 0 ? ` *(${event.tags.join(', ')})*` : '';
    md += `- **${event.year}** — ${major}${convertText(event.text)}${major}${tags}\n`;
  }

  return md;
}

// ─── Write files ──────────────────────────────────────────────────────────────

const categoryFolders = {
  character: 'characters',
  faction:   'factions',
  lore:      'lore',
  world:     'world',
  location:  'locations',
  artifact:  'artifacts',
  project:   'projects',
  meta:      '',  // meta pages go in root
};

const contentBase = path.join(__dirname, 'content');

// Create all category directories
for (const folder of Object.values(categoryFolders)) {
  if (folder) fs.mkdirSync(path.join(contentBase, folder), { recursive: true });
}
fs.mkdirSync(contentBase, { recursive: true });

// Write articles (skip 'timeline' — we generate it from TIMELINE_EVENTS below)
for (const [id, article] of Object.entries(ARTICLES)) {
  if (id === 'timeline') continue;
  const folder = categoryFolders[article.category] ?? 'misc';
  const filename = safeTitle(article.title) + '.md';
  const filepath = folder
    ? path.join(contentBase, folder, filename)
    : path.join(contentBase, filename);

  const markdown = articleToMarkdown(id, article);
  fs.writeFileSync(filepath, markdown, 'utf8');
  console.log(`  ✓ ${filepath.replace(contentBase, 'content')}`);
}

// Write timeline
const timelinePath = path.join(contentBase, 'Timeline.md');
fs.writeFileSync(timelinePath, timelineToMarkdown(TIMELINE_EVENTS), 'utf8');
console.log(`  ✓ content/Timeline.md`);

console.log('\nMigration complete!');
