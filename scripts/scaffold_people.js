#!/usr/bin/env node
// One-shot scaffolder for the People feature.
// Idempotent — re-runs are safe.
//
// Creates:
//   - "People" notebook (storage container; user reaches People via sidebar)
//   - "Person" template (bold-key fields + structured sections)
//   - "👥 People — Index" note (role buckets with [[wiki-links]])
const http = require('http');

const BASE = process.env.ULTRANOTE_URL || 'http://localhost:3366';
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

const PEOPLE_NOTEBOOK_NAME = 'People';
const PEOPLE_NOTEBOOK_EMOJI = '👥';

const PERSON_TEMPLATE = {
  id: 'tpl_person',
  name: 'Person',
  description: 'Researcher dossier — who they are, what they work on, who they know.',
  tags: ['person'],
  updatedAt: nowISO(),
  content: [
    '# [Name]',
    '',
    '**Role:** Prof / Postdoc / PhD / Research Engineer / Founder / …',
    '**Affiliation:** Lab or Team @ Org',
    '**Location:** ',
    '**Tags:** ',
    '**Met:** no',
    '**Star:** no',
    '',
    '## Currently working on',
    '- ',
    '',
    '## Lab / team',
    '- Lab page: ',
    '- Advisor / mentor: ',
    '- Advisees / reports: ',
    '- Frequent collaborators: ',
    '- Team\'s main focus: ',
    '',
    '## Key papers / projects',
    '- ',
    '',
    '## Topics',
    '- ',
    '',
    '## Online',
    '- Scholar: ',
    '- GitHub: ',
    '- Site: ',
    '- X / Twitter: ',
    '- LinkedIn: ',
    '',
    '## How I first encountered them',
    '- ',
    '',
    '## Insights & memorable quotes',
    '- ',
    '',
    '## Open questions I\'d want to ask',
    '- ',
    '',
    '## Notes / threads',
    '- ',
    '',
  ].join('\n'),
};

const INDEX_NOTE_TITLE = '👥 People — Index';
function indexNoteBody() {
  return [
    '# 👥 People — Index',
    '',
    '> The roster. Add `[[Person Name]]` links under the right bucket as you create person notes.',
    '',
    '## ⭐ Currently watching closely',
    '- ',
    '',
    '## Profs / PIs',
    '- ',
    '',
    '## Researchers (postdocs, PhDs, scientists)',
    '- ',
    '',
    '## Engineers / Founders',
    '- ',
    '',
    '## Met IRL',
    '- ',
    '',
    '## Recruiters / Hiring managers',
    '- ',
    '',
  ].join('\n');
}

(async () => {
  console.log('→ Fetching current DB...');
  const db = await req('GET', '/api/db');
  if (!db || !Array.isArray(db.notes)) throw new Error('Bad DB shape');

  let dirty = false;

  // 1) People notebook (find by name; do NOT repurpose unnamed notebooks)
  db.notebooks = db.notebooks || [];
  let peopleNotebook = db.notebooks.find(n => !n.deletedAt && n.name === PEOPLE_NOTEBOOK_NAME);
  if (peopleNotebook) {
    console.log(`✓ Notebook "${PEOPLE_NOTEBOOK_NAME}" already exists (id=${peopleNotebook.id}).`);
  } else {
    peopleNotebook = {
      id: rid(),
      name: PEOPLE_NOTEBOOK_NAME,
      emoji: PEOPLE_NOTEBOOK_EMOJI,
      createdAt: nowISO(),
      updatedAt: nowISO(),
    };
    db.notebooks.push(peopleNotebook);
    dirty = true;
    console.log(`+ Created notebook: ${PEOPLE_NOTEBOOK_EMOJI} ${PEOPLE_NOTEBOOK_NAME} (id=${peopleNotebook.id})`);
  }

  // 2) Person template
  db.templates = db.templates || [];
  const existingTpl = db.templates.find(t => !t.deletedAt && t.id === PERSON_TEMPLATE.id);
  if (existingTpl) {
    console.log('✓ Template "Person" already exists — skipping.');
  } else {
    db.templates.push({ ...PERSON_TEMPLATE });
    dirty = true;
    console.log('+ Added template: Person');
  }

  // 3) People — Index note
  const existingIndex = db.notes.find(n => !n.deletedAt && n.title === INDEX_NOTE_TITLE);
  if (existingIndex) {
    console.log(`✓ Note "${INDEX_NOTE_TITLE}" already exists — skipping.`);
  } else {
    db.notes.push({
      id: rid(),
      title: INDEX_NOTE_TITLE,
      content: indexNoteBody(),
      tags: ['people', 'index'],
      notebookId: peopleNotebook.id,
      createdAt: nowISO(),
      updatedAt: nowISO(),
    });
    dirty = true;
    console.log(`+ Created note: ${INDEX_NOTE_TITLE}`);
  }

  if (!dirty) {
    console.log('Nothing to do.');
    return;
  }

  console.log('→ Posting back to server...');
  await req('POST', '/api/db', db);
  console.log('✓ Server accepted update.');
  console.log(`\nPeople notebook id: ${peopleNotebook.id}`);
})().catch(e => { console.error('FAILED:', e.message); process.exit(1); });
