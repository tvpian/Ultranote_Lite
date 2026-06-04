#!/usr/bin/env node
// One-shot scaffolder: adds a Paper Note template and 5 Topic Map notes.
// Idempotent — re-running won't create duplicates.
const http = require('http');

const BASE = process.env.ULTRANOTE_URL || 'http://localhost:3366';
const RESEARCH_NOTEBOOK_ID = 'wvskhat9'; // existing Research notebook
const nowISO = () => new Date().toISOString();
const rid = () => Math.random().toString(36).slice(2, 10);

function req(method, path, body) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const u = new URL(BASE + path);
    const r = http.request({
      hostname: u.hostname, port: u.port, path: u.pathname + u.search,
      method, headers: {
        'Content-Type': 'application/json',
        'X-Requested-With': 'XMLHttpRequest',
        ...(data ? { 'Content-Length': Buffer.byteLength(data) } : {}),
      },
    }, res => {
      let buf = ''; res.on('data', c => buf += c);
      res.on('end', () => {
        if (res.statusCode >= 400) return reject(new Error(`${res.statusCode} ${buf.slice(0,200)}`));
        try { resolve(buf ? JSON.parse(buf) : null); } catch { resolve(buf); }
      });
    });
    r.on('error', reject);
    if (data) r.write(data);
    r.end();
  });
}

const PAPER_TEMPLATE = {
  id: 'tpl_paper_note',
  name: '📄 Paper Note',
  description: 'Structured reading note — TL;DR, method, why-I-care, links to topic maps.',
  tags: ['research', 'paper'],
  updatedAt: nowISO(),
  content: [
    '# [Title]',
    '',
    '**Authors:** ',
    '**Venue / Year:** ',
    '**Link:** ',
    '**Date read:** ' + new Date().toISOString().slice(0, 10),
    '',
    '## TL;DR (≤3 sentences)',
    '- ',
    '',
    '## Problem & motivation',
    '- ',
    '',
    '## Method (in my own words)',
    '- ',
    '',
    '## Key results',
    '- ',
    '',
    '## Why I care / how it connects to my work',
    '- ',
    '',
    '## Limitations / open questions',
    '- ',
    '',
    '## Connects to',
    '- [[🗺️ Topic Map — ]]',
    '',
    '## Follow-ups',
    '- [ ] ',
    '',
  ].join('\n'),
};

const TOPIC_MAPS = [
  { slug: 'world-models',       title: '🗺️ Topic Map — World Models',       tags: ['research', 'topic-map', 'world-models'] },
  { slug: 'vla',                title: '🗺️ Topic Map — VLA',                tags: ['research', 'topic-map', 'vla'] },
  { slug: 'imitation-dexterity',title: '🗺️ Topic Map — Imitation & Dexterity', tags: ['research', 'topic-map', 'imitation', 'dexterity'] },
  { slug: 'motion-planning',    title: '🗺️ Topic Map — Motion Planning',    tags: ['research', 'topic-map', 'motion-planning'] },
  { slug: 'perception',         title: '🗺️ Topic Map — Perception',         tags: ['research', 'topic-map', 'perception'] },
];

function topicMapBody(title) {
  return [
    `# ${title}`,
    '',
    '> Single source of truth for this research thread. Link papers, ideas, and open questions here.',
    '',
    '## North star question',
    '_What\'s the one question I\'m trying to answer in this area?_',
    '- ',
    '',
    '## Key papers (linked notes)',
    '- ',
    '',
    '## Core ideas / concepts',
    '- ',
    '',
    '## Open questions',
    '- ',
    '',
    '## Active experiments / projects',
    '- ',
    '',
    '## Backlog (papers to read)',
    '- ',
    '',
  ].join('\n');
}

(async () => {
  console.log('→ Fetching current DB...');
  const db = await req('GET', '/api/db');
  if (!db || !Array.isArray(db.notes)) throw new Error('Bad DB shape');

  let added = { template: false, topicMaps: [] };

  // 1) Template
  db.templates = db.templates || [];
  const tplExists = db.templates.some(t => !t.deletedAt && t.name === PAPER_TEMPLATE.name);
  if (tplExists) {
    console.log('✓ Template "📄 Paper Note" already exists — skipping.');
  } else {
    db.templates.push({ ...PAPER_TEMPLATE });
    added.template = true;
    console.log('+ Added template: 📄 Paper Note');
  }

  // 2) Topic Maps
  for (const tm of TOPIC_MAPS) {
    const exists = db.notes.some(n => !n.deletedAt && n.title === tm.title);
    if (exists) {
      console.log(`✓ Note "${tm.title}" already exists — skipping.`);
      continue;
    }
    const note = {
      id: rid(),
      title: tm.title,
      content: topicMapBody(tm.title),
      tags: tm.tags,
      notebookId: RESEARCH_NOTEBOOK_ID,
      createdAt: nowISO(),
      updatedAt: nowISO(),
    };
    db.notes.push(note);
    added.topicMaps.push(tm.title);
    console.log(`+ Created note: ${tm.title}`);
  }

  if (!added.template && added.topicMaps.length === 0) {
    console.log('Nothing to do.');
    return;
  }

  console.log('→ Posting back to server...');
  const resp = await req('POST', '/api/db', db);
  console.log('✓ Server accepted update.');
  console.log('Summary:', JSON.stringify(added, null, 2));
})().catch(e => { console.error('FAILED:', e.message); process.exit(1); });
