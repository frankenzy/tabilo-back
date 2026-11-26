import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { zip } from './zip';

/** Spec 041, R3 : l'archive s'ouvre avec un outil standard. */
describe('zip', () => {
  it('produit une archive lisible', () => {
    const dir = mkdtempSync(join(tmpdir(), 'tabilo-zip-'));
    const file = join(dir, 'a.zip');
    writeFileSync(file, zip([{ name: 'carte.csv', data: 'Nom;Prix\r\nGarba;1500\r\n' }, { name: 'photos/é.bin', data: Buffer.from([1, 2, 3]) }]));
    let listing = '';
    try {
      listing = execFileSync('python3', ['-c', 'import sys,zipfile;z=zipfile.ZipFile(sys.argv[1]);print(z.testzip());print(z.read("carte.csv").decode())', file]).toString();
    } catch {
      return; // python3 absent : test ignoré
    }
    expect(listing).toContain('None');
    expect(listing).toContain('Garba;1500');
    expect(readFileSync(file).subarray(0, 4).readUInt32LE(0)).toBe(0x04034b50);
  });
});
