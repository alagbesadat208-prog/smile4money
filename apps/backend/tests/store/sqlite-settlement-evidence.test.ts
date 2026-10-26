import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SqliteMatchStore } from '../../src/store/sqlite-match-store.js';

describe('SQLite settlement evidence', () => {
  const directories: string[] = [];
  afterEach(() => {
    for (const directory of directories.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
  });

  it('persists sanitized evidence across store instances', async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'smile-evidence-'));
    directories.push(directory);
    const dbPath = path.join(directory, 'matches.sqlite');
    const first = new SqliteMatchStore(dbPath);
    await first.initialize();
    await first.saveSettlementEvidence({
      parserVersion: 'chess-result-v1', evaluatedAt: new Date().toISOString(), matchId: 7,
      gameId: 'abc_123', platform: 'lichess', whitePlayer: 'alice', blackPlayer: 'bob',
      result: 'Player1Wins', status: 'mate', decision: 'player_identity_mismatch',
    });
    await first.saveSettlementEvidence({
      parserVersion: 'chess-result-v1', evaluatedAt: new Date().toISOString(), matchId: 7,
      gameId: 'abc_123', platform: 'lichess', whitePlayer: 'alice', blackPlayer: 'bob',
      result: 'Player1Wins', status: 'mate', decision: 'verified',
    });
    await first.close();

    const reopened = new SqliteMatchStore(dbPath);
    await reopened.initialize();
    await expect(reopened.getSettlementEvidence(7)).resolves.toMatchObject({
      parserVersion: 'chess-result-v1', gameId: 'abc_123', whitePlayer: 'alice', result: 'Player1Wins', decision: 'verified',
    });
    await expect(reopened.getSettlementEvidenceHistory(7)).resolves.toMatchObject([
      { decision: 'player_identity_mismatch' },
      { decision: 'verified' },
    ]);
    await reopened.close();
  });
});
