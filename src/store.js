// Atomic JSON persistence for bot state (one file per mode/data source).
import fs from 'node:fs';
import path from 'node:path';

export class JsonStore {
  constructor(dataDir, name) {
    this.file = path.resolve(dataDir, `state-${name}.json`);
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
  }

  load() {
    try {
      return JSON.parse(fs.readFileSync(this.file, 'utf8'));
    } catch (err) {
      if (err.code === 'ENOENT') return null;
      throw err;
    }
  }

  save(obj) {
    const tmp = `${this.file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(obj));
    fs.renameSync(tmp, this.file);
  }
}

export class MemoryStore {
  constructor() {
    this.data = null;
  }

  load() {
    return this.data;
  }

  save(obj) {
    this.data = JSON.parse(JSON.stringify(obj));
  }
}
