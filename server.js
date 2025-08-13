const express = require('express');
const fs = require('fs');
const path = require('path');
const app = express();
const PORT = process.env.PORT || 3366;

const DATA_FILE = path.join(__dirname, 'data.json');

app.use(express.json({ limit: '2mb' }));
app.use(express.static(__dirname));

function readData() {
  try {
    if (!fs.existsSync(DATA_FILE)) return null;
    const txt = fs.readFileSync(DATA_FILE, 'utf8');
    return JSON.parse(txt);
  } catch (e) {
    console.error('Read error', e);
    return null;
  }
}

function writeData(obj) {
  try {
    fs.writeFileSync(DATA_FILE, JSON.stringify(obj, null, 2));
    return true;
  } catch (e) {
    console.error('Write error', e);
    return false;
  }
}

app.get('/api/db', (req, res) => {
  const data = readData();
  if (!data) return res.status(200).json({});
  res.json(data);
});

app.post('/api/db', (req, res) => {
  const body = req.body;
  if (!body || typeof body !== 'object') {
    return res.status(400).json({ error: 'Invalid body' });
  }
  if (!writeData(body)) return res.status(500).json({ error: 'Persist failed' });
  res.json({ ok: true });
});

app.listen(PORT, () => console.log('Server running on http://localhost:' + PORT));
